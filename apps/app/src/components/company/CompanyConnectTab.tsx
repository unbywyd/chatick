import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Bot, Check, Copy, Plug, ShieldCheck, X } from 'lucide-react'
import { api, API_URL, type Company } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// Подключение ИИ ко ВСЕЙ компании (SPEC §8.27).
// Отличие от личного подключения к одному проекту: туннель покрывает все
// проекты компании, где состоит этот человек, — ассистент выбирает проект сам.

type BridgeSession = {
  id: string
  clientName: string
  scope: 'company' | 'project'
  project: { id: string; name: string } | null
  company: { id: string; name: string } | null
  lastUsedAt: string
}

export function CompanyConnectTab({ company }: { company: Company }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)

  const inviteLine = `${t('connect.pastePrefix')} ${API_URL.replace(/\/$/, '')}/x`

  const sessions = useQuery({
    queryKey: ['bridge-sessions'],
    queryFn: () => api<{ items: BridgeSession[] }>('/api/v1/auth/bridge/sessions'),
    refetchInterval: 10_000,
  })
  const companySessions = (sessions.data?.items ?? []).filter((s) => s.company?.id === company.id)

  const pending = useQuery({
    queryKey: ['bridge-code', code],
    enabled: code.trim().length >= 8,
    retry: false,
    queryFn: () => api<{ clientName: string }>(`/api/v1/auth/bridge/code/${encodeURIComponent(code.trim())}`),
  })

  const approve = useMutation({
    mutationFn: () =>
      api('/api/v1/auth/bridge/approve', {
        method: 'POST',
        body: JSON.stringify({ code: code.trim(), companyId: company.id }),
      }),
    onSuccess: () => {
      toast.success(t('connect.approved'))
      setCode('')
      qc.invalidateQueries({ queryKey: ['bridge-sessions'] })
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const deny = useMutation({
    mutationFn: () => api('/api/v1/auth/bridge/deny', { method: 'POST', body: JSON.stringify({ code: code.trim() }) }),
    onSuccess: () => {
      setCode('')
      toast.success(t('connect.denied'))
    },
  })

  const close = useMutation({
    mutationFn: (id: string) => api(`/api/v1/auth/bridge/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t('connect.closed'))
      qc.invalidateQueries({ queryKey: ['bridge-sessions'] })
    },
  })

  const copy = () => {
    navigator.clipboard.writeText(inviteLine).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="flex items-center gap-2 text-base font-bold">
          <Bot className="size-4" />
          {t('connect.companyTitle')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('connect.companySubtitle')}</p>
      </div>

      {/* Шаг 1 — строка для вставки в ассистента */}
      <section className="rounded-xl border bg-card p-4">
        <h3 className="text-sm font-semibold">{t('connect.step1Title')}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t('connect.step1Hint')}</p>
        <div className="mt-3 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md border bg-secondary px-3 py-2 text-xs">{inviteLine}</code>
          <Button variant="brand" size="sm" onClick={copy}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? t('connect.copied') : t('connect.copy')}
          </Button>
        </div>
      </section>

      {/* Шаг 2 — подтверждение кода на всю компанию */}
      <section className="rounded-xl border bg-card p-4">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <ShieldCheck className="size-4" />
          {t('connect.step2Title')}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">{t('connect.step2Hint')}</p>
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="ABCD-2345"
          className="mt-3 font-mono tracking-widest"
          maxLength={9}
        />
        {pending.data && (
          <div className="mt-3 space-y-3 rounded-lg border border-brand/40 bg-brand-soft/40 p-3">
            <p className="text-sm">
              <b>{pending.data.clientName}</b> {t('connect.requestsCompanyAccess', { company: company.name })}
            </p>
            <p className="text-xs text-muted-foreground">{t('connect.companyScopeNote')}</p>
            <div className="flex gap-2">
              <Button variant="brand" size="sm" disabled={approve.isPending} onClick={() => approve.mutate()}>
                <Check className="size-3.5" />
                {t('connect.allow')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => deny.mutate()}>
                <X className="size-3.5" />
                {t('connect.deny')}
              </Button>
            </div>
          </div>
        )}
        {code.trim().length >= 8 && pending.isError && (
          <p className="mt-2 text-xs text-destructive">{t('connect.badCode')}</p>
        )}
      </section>

      {/* Активные подключения к этой компании */}
      <section className="rounded-xl border bg-card p-4">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Plug className="size-4" />
          {t('connect.activeTitle')}
        </h3>
        <ul className="mt-3 space-y-2">
          {companySessions.map((s) => (
            <li key={s.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-secondary">
                <Bot className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{s.clientName}</span>
                <span className="block text-xs text-muted-foreground">
                  {t('connect.wholeCompany')} · {t('connect.lastUsed')}{' '}
                  {new Date(s.lastUsedAt).toLocaleString(i18n.language, { hour: '2-digit', minute: '2-digit' })}
                </span>
              </span>
              <Button variant="outline" size="sm" onClick={() => close.mutate(s.id)}>
                {t('connect.closeTunnel')}
              </Button>
            </li>
          ))}
          {companySessions.length === 0 && (
            <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
              {t('connect.noSessions')}
            </p>
          )}
        </ul>
      </section>
    </div>
  )
}
