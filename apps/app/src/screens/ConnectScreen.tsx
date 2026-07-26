import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Bot, Check, Copy, Plug, ShieldCheck, X } from 'lucide-react'
import { api, API_URL, getSessionToken, type Company, type ProjectListItem } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Logo } from '@/components/Logo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LanguageSelect } from '@/components/LanguageSelect'
import { ThemeToggle } from '@/components/ThemeToggle'

// Страница подключения внешнего ИИ (SPEC §8.27).
// Здесь человек: (1) копирует строку-приглашение для Claude Code,
// (2) подтверждает код, который тот показал, (3) видит и закрывает туннели.

type BridgeSession = {
  id: string
  clientName: string
  project: { id: string; name: string }
  lastUsedAt: string
  expiresAt: string
  createdAt: string
}

export function ConnectScreen() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [params] = useSearchParams()
  const [code, setCode] = useState(params.get('code') ?? '')
  const [projectId, setProjectId] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!getSessionToken()) navigate('/login', { replace: true })
  }, [navigate])

  // строка, которую человек вставляет в Claude Code — без токена, безопасно
  const inviteLine = `${t('connect.pastePrefix')} ${API_URL.replace(/\/$/, '')}/x`

  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<{ companies: Company[] }>('/api/v1/companies'),
  })
  // Проекты СО ВСЕХ компаний: человек может состоять в нескольких, и выбирать
  // из проектов только первой — значит часть его проектов просто не показать.
  const companyIds = (companies.data?.companies ?? []).map((c) => c.id)
  const projects = useQuery({
    queryKey: ['connect-projects', companyIds.join(',')],
    enabled: companyIds.length > 0,
    queryFn: async () => {
      const lists = await Promise.all(
        companyIds.map((id) =>
          api<ProjectListItem[]>(`/api/v1/projects?companyId=${id}`).catch(() => [] as ProjectListItem[]),
        ),
      )
      return lists.flat()
    },
  })
  const myProjects = (projects.data ?? []).filter((p) => p.isMember)

  useEffect(() => {
    if (!projectId && myProjects.length) setProjectId(myProjects[0]!.id)
  }, [myProjects, projectId])

  // Подтверждение кода НЕ создаёт сессию: она появляется, когда ассистент
  // придёт за токеном (/x/device/poll). Поэтому сразу после «Разрешить»
  // список ещё пуст — какое-то время опрашиваем чаще и показываем ожидание.
  const [awaiting, setAwaiting] = useState(false)
  const sessions = useQuery({
    queryKey: ['bridge-sessions'],
    queryFn: () => api<{ items: BridgeSession[] }>('/api/v1/auth/bridge/sessions'),
    refetchInterval: awaiting ? 1500 : 10_000,
  })

  // как только подключение появилось — перестаём частить
  useEffect(() => {
    if (awaiting && (sessions.data?.items.length ?? 0) > 0) setAwaiting(false)
  }, [awaiting, sessions.data])

  // проверяем код, чтобы показать, КТО просит доступ
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
        body: JSON.stringify({ code: code.trim(), projectId }),
      }),
    onSuccess: () => {
      toast.success(t('connect.approved'))
      setCode('')
      setAwaiting(true)
      qc.invalidateQueries({ queryKey: ['bridge-sessions'] })
      // ассистент может не успеть опросить: через минуту прекращаем частить
      setTimeout(() => setAwaiting(false), 60_000)
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
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <Logo />
          <span className="text-muted-foreground">/</span>
          <span className="text-sm font-medium">{t('connect.title')}</span>
        </div>
        <div className="flex items-center gap-2">
          <LanguageSelect />
          <ThemeToggle />
          {/* назад туда, откуда пришли: сюда попадают и из проекта, и со старта */}
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
            {t('connect.back')}
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 space-y-6 overflow-y-auto px-6 py-8">
        {/* Шаг 1: одна кнопка — скопировать приглашение */}
        <section className="rounded-xl border bg-card p-5">
          <h1 className="flex items-center gap-2 text-base font-bold">
            <Bot className="size-4" />
            {t('connect.step1Title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('connect.step1Hint')}</p>

          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-secondary px-3 py-2 text-xs">{inviteLine}</code>
            <Button variant="brand" onClick={copy}>
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? t('connect.copied') : t('connect.copy')}
            </Button>
          </div>
        </section>

        {/* Шаг 2: подтвердить код, который показал ИИ */}
        <section className="rounded-xl border bg-card p-5">
          <h2 className="flex items-center gap-2 text-base font-bold">
            <ShieldCheck className="size-4" />
            {t('connect.step2Title')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('connect.step2Hint')}</p>

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
                <b>{pending.data.clientName}</b> {t('connect.requestsAccess')}
              </p>
              <label className="block text-xs font-medium text-muted-foreground">
                {t('connect.chooseProject')}
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm text-foreground"
                >
                  {myProjects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-xs text-muted-foreground">{t('connect.actsAsYou')}</p>
              <div className="flex gap-2">
                <Button variant="brand" size="sm" disabled={!projectId || approve.isPending} onClick={() => approve.mutate()}>
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

        {/* Активные туннели */}
        <section className="rounded-xl border bg-card p-5">
          <h2 className="flex items-center gap-2 text-base font-bold">
            <Plug className="size-4" />
            {t('connect.activeTitle')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('connect.activeHint')}</p>

          <ul className="mt-3 space-y-2">
            {(sessions.data?.items ?? []).map((s) => (
              <li key={s.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-secondary">
                  <Bot className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{s.clientName}</span>
                  <span className="block text-xs text-muted-foreground">
                    {s.project.name} · {t('connect.lastUsed')}{' '}
                    {new Date(s.lastUsedAt).toLocaleString(i18n.language, { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </span>
                <Button variant="outline" size="sm" onClick={() => close.mutate(s.id)}>
                  {t('connect.closeTunnel')}
                </Button>
              </li>
            ))}
            {awaiting && (sessions.data?.items.length ?? 0) === 0 && (
              <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                {t('connect.waitingForAi')}
              </p>
            )}
            {!awaiting && sessions.data && sessions.data.items.length === 0 && (
              <p className={cn('rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground')}>
                {t('connect.noSessions')}
              </p>
            )}
          </ul>
        </section>
      </main>
    </div>
  )
}
