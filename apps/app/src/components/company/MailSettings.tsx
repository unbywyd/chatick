import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Mail, Check, ChevronDown, Loader2, ShieldCheck, Send } from 'lucide-react'
import { api } from '@/lib/api'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckItem,
} from '@/components/ui/dropdown-menu'

// Своя почта компании (SPEC §8.41).
//
// Письма сотрудникам уходят с домена компании, а не с нашего: письмо «от
// Chatick» про их внутренние задачи выглядит как фишинг и чаще попадает в спам.
//
// Пароль и ключ сервер обратно не отдаёт — приходит только признак «задан».
// Пустое поле означает «оставить прежний», поэтому форму можно открыть ради
// смены порта, не вводя пароль заново.

type MailSettings = {
  mailProvider: 'smtp' | 'sendgrid' | null
  mailFromEmail: string | null
  mailFromName: string | null
  mailReplyTo: string | null
  mailHost: string | null
  mailPort: number | null
  mailUser: string | null
  mailVerifiedAt: string | null
  hasPassword: boolean
  hasApiKey: boolean
}

const PROVIDERS = [
  { id: 'smtp' as const, labelKey: 'mail.smtp' },
  { id: 'sendgrid' as const, labelKey: 'mail.sendgrid' },
]

/**
 * «Tal Levi <tal@startplan.net>» → имя и адрес по отдельности.
 *
 * Люди копируют отправителя целиком — так он выглядит в почтовом клиенте — и
 * вставляют в оба поля. Сервер такой адрес отклонит, а подсказать, что именно
 * не так, форма не умела. Проще разобрать самим.
 */
function splitAddress(raw: string): { name: string; email: string } | null {
  const m = raw.match(/^\s*(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/)
  if (!m) return null
  return { name: m[1]!.replace(/^["']|["']$/g, '').trim(), email: m[2]!.toLowerCase() }
}

export function MailSettings({ companyId, isAdmin }: { companyId: string; isAdmin: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()

  const settings = useQuery({
    queryKey: ['company-mail', companyId],
    queryFn: () => api<MailSettings>(`/api/v1/companies/${companyId}/mail`),
  })

  const [provider, setProvider] = useState<'smtp' | 'sendgrid' | null>(null)
  const [fromEmail, setFromEmail] = useState('')
  const [fromName, setFromName] = useState('')
  const [replyTo, setReplyTo] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('587')
  const [user, setUser] = useState('')
  const [secret, setSecret] = useState('')

  // Подставляем сохранённое, когда оно приехало. Секрет остаётся пустым — его
  // и не присылают.
  const d = settings.data
  useEffect(() => {
    if (!d) return
    setProvider(d.mailProvider)
    setFromEmail(d.mailFromEmail ?? '')
    setFromName(d.mailFromName ?? '')
    setReplyTo(d.mailReplyTo ?? '')
    setHost(d.mailHost ?? '')
    setPort(String(d.mailPort ?? 587))
    setUser(d.mailUser ?? '')
  }, [d])

  const refresh = () => qc.invalidateQueries({ queryKey: ['company-mail', companyId] })

  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/companies/${companyId}/mail`, {
        method: 'PATCH',
        body: JSON.stringify({
          provider,
          fromEmail,
          fromName,
          replyTo,
          ...(provider === 'smtp'
            ? { host, port: Number(port) || 587, user, ...(secret ? { password: secret } : {}) }
            : secret
              ? { apiKey: secret }
              : {}),
        }),
      }),
    onSuccess: () => {
      toast.success(t('mail.saved'))
      setSecret('')
      refresh()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const test = useMutation({
    mutationFn: () => api<{ sentTo: string }>(`/api/v1/companies/${companyId}/mail/test`, { method: 'POST' }),
    onSuccess: (r) => {
      toast.success(t('mail.testSent', { email: r.sentTo }))
      refresh()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const disable = useMutation({
    mutationFn: () =>
      api(`/api/v1/companies/${companyId}/mail`, { method: 'PATCH', body: JSON.stringify({ provider: null }) }),
    onSuccess: () => {
      toast.success(t('mail.disabled'))
      setSecret('')
      refresh()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const hasSecret = provider === 'smtp' ? d?.hasPassword : d?.hasApiKey
  const secretSet = !!secret || (!!hasSecret && provider === d?.mailProvider)
  const canSave = !!provider && !!fromEmail.trim() && secretSet && (provider !== 'smtp' || !!host.trim())

  return (
    <section className="rounded-xl border bg-card p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Mail className="size-4 text-muted-foreground" />
        {t('mail.title')}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">{t('mail.subtitle')}</p>

      {settings.isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('common.loading')}
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {/* Провайдер */}
          <div>
            <label className="mb-1.5 block text-xs font-medium">{t('mail.provider')}</label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild disabled={!isAdmin}>
                <Button variant="outline" size="sm" className="w-full justify-between font-normal">
                  {provider ? t(PROVIDERS.find((p) => p.id === provider)!.labelKey) : t('mail.providerDefault')}
                  <ChevronDown className="size-3.5 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[--radix-dropdown-menu-trigger-width]">
                <DropdownMenuCheckItem checked={!provider} onSelect={() => setProvider(null)}>
                  {t('mail.providerDefault')}
                </DropdownMenuCheckItem>
                {PROVIDERS.map((p) => (
                  <DropdownMenuCheckItem
                    key={p.id}
                    checked={provider === p.id}
                    onSelect={() => {
                      setProvider(p.id)
                      // Секрет от другого провайдера здесь не подойдёт.
                      setSecret('')
                    }}
                  >
                    {t(p.labelKey)}
                  </DropdownMenuCheckItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {!provider && <p className="mt-1 text-xs text-muted-foreground">{t('mail.providerDefaultHint')}</p>}
          </div>

          {provider && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-medium">{t('mail.fromEmail')}</label>
                  <Input
                    value={fromEmail}
                    disabled={!isAdmin}
                    onChange={(e) => {
                      const parts = splitAddress(e.target.value)
                      if (!parts) return setFromEmail(e.target.value)
                      // Вставили «Имя <адрес>» — раскладываем, а имя не
                      // затираем, если человек его уже написал сам.
                      setFromEmail(parts.email)
                      if (parts.name && !fromName.trim()) setFromName(parts.name)
                    }}
                    placeholder="noreply@company.com"
                    dir="ltr"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">{t('mail.fromEmailHint')}</p>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium">{t('mail.fromName')}</label>
                  <Input
                    value={fromName}
                    disabled={!isAdmin}
                    onChange={(e) => {
                      const parts = splitAddress(e.target.value)
                      if (!parts) return setFromName(e.target.value)
                      setFromName(parts.name)
                      if (!fromEmail.trim()) setFromEmail(parts.email)
                    }}
                    placeholder={t('mail.fromNamePlaceholder')}
                  />
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium">{t('mail.replyTo')}</label>
                <Input
                  value={replyTo}
                  disabled={!isAdmin}
                  onChange={(e) => setReplyTo(e.target.value)}
                  placeholder="support@company.com"
                  dir="ltr"
                />
                <p className="mt-1 text-xs text-muted-foreground">{t('mail.replyToHint')}</p>
              </div>

              {provider === 'smtp' && (
                <div className="grid gap-3 sm:grid-cols-[1fr_100px]">
                  <div>
                    <label className="mb-1.5 block text-xs font-medium">{t('mail.host')}</label>
                    <Input
                      value={host}
                      disabled={!isAdmin}
                      onChange={(e) => setHost(e.target.value)}
                      placeholder="smtp.company.com"
                      dir="ltr"
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-medium">{t('mail.port')}</label>
                    <Input
                      value={port}
                      disabled={!isAdmin}
                      onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
                      inputMode="numeric"
                      dir="ltr"
                    />
                  </div>
                </div>
              )}

              {provider === 'smtp' && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium">{t('mail.user')}</label>
                  <Input value={user} disabled={!isAdmin} onChange={(e) => setUser(e.target.value)} dir="ltr" />
                </div>
              )}

              {/* Секрет. Показать его нельзя — сервер не отдаёт: иначе чужая
                  открытая вкладка равна выданному доступу к почте компании. */}
              <div>
                <label className="mb-1.5 block text-xs font-medium">
                  {provider === 'smtp' ? t('mail.password') : t('mail.apiKey')}
                </label>
                <Input
                  type="password"
                  value={secret}
                  disabled={!isAdmin}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={hasSecret ? t('mail.secretKeep') : t('mail.secretPlaceholder')}
                  dir="ltr"
                  autoComplete="new-password"
                />
                <p className="mt-1 text-xs text-muted-foreground">{t('mail.secretHint')}</p>
              </div>

              {d?.mailVerifiedAt && (
                <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                  <ShieldCheck className="size-3.5" />
                  {t('mail.verifiedAt', { date: new Date(d.mailVerifiedAt).toLocaleString() })}
                </p>
              )}
            </>
          )}

          {isAdmin && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button variant="brand" size="sm" disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                {t('projectForm.save')}
              </Button>

              {/* Проверка живой отправкой: иначе опечатку в пароле находят
                  сотрудники, у которых молча перестали приходить письма. */}
              {d?.mailProvider && (
                <Button variant="outline" size="sm" disabled={test.isPending} onClick={() => test.mutate()}>
                  {test.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                  {t('mail.sendTest')}
                </Button>
              )}

              {d?.mailProvider && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={disable.isPending}
                  onClick={async () => {
                    if (
                      !(await confirm({
                        title: t('mail.disableConfirm'),
                        description: t('mail.disableConfirmBody'),
                        confirmLabel: t('mail.disable'),
                        destructive: true,
                      }))
                    )
                      return
                    disable.mutate()
                  }}
                >
                  {t('mail.disable')}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
