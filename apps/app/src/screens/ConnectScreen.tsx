import { createPortal } from 'react-dom'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowLeft, Bot, Check, ChevronDown, Copy, Plug, ShieldCheck, X, Search, Building2, FolderKanban } from 'lucide-react'
import { api, API_URL, getSessionToken, type Company, type ProjectListItem } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Logo } from '@/components/Logo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { LanguageSelect } from '@/components/LanguageSelect'
import { ThemeToggle } from '@/components/ThemeToggle'

// Подключение внешнего ИИ (SPEC §8.27).
// Здесь человек: (1) копирует строку-приглашение для Claude Code,
// (2) подтверждает код, который тот показал, (3) видит и закрывает туннели.
//
// Это действие ВНУТРИ проекта, поэтому основной способ открыть его — модалка
// (ConnectDialog): контекст проекта не теряется и возвращаться некуда.
// Отдельный маршрут /connect оставлен как обёртка — на него ведут старые
// ссылки и письма.

type BridgeSession = {
  id: string
  clientName: string
  /** Туннель открыт либо на один проект, либо на всю компанию — заполнено одно. */
  scope: 'company' | 'project'
  project: { id: string; name: string } | null
  company: { id: string; name: string } | null
  lastUsedAt: string
  expiresAt: string
  createdAt: string
}

export function ConnectPanel({ onClose }: { onClose?: () => void }) {
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
          api<ProjectListItem[]>(`/api/v1/projects?companyId=${id}`)
            // Компания известна из самого запроса — приклеиваем её здесь,
            // чтобы потом не гадать, чей это проект.
            .then((list) => list.map((p) => ({ ...p, companyId: id })))
            .catch(() => [] as (ProjectListItem & { companyId: string })[]),
        ),
      )
      return lists.flat()
    },
  })
  const myProjects = (projects.data ?? []).filter((p) => p.isMember)
  const myCompanies = companies.data?.companies ?? []
  const companyNames = new Map(myCompanies.map((c) => [c.id, c.name]))

  // Цели: компании человека и его проекты. Компания — обычный выбор:
  // приложение мультипроектное, и туннель на один проект заставлял бы
  // переподключаться при каждом переходе. Больше своего человек так не выдаёт:
  // туннель компании открывает ровно те проекты, где он состоит, и с его же
  // правами — это проверяется на каждом запросе.
  const targets = [
    ...myCompanies.map((c) => ({ key: `c:${c.id}`, name: c.name, company: null as string | null, whole: true })),
    ...myProjects.map((p) => ({
      key: `p:${p.id}`,
      name: p.name,
      // Подпись компанией нужна, когда компаний несколько: одинаковые названия
      // проектов не редкость, и без неё непонятно, какой из них какой.
      company: myCompanies.length > 1 ? companyNames.get((p as ProjectListItem & { companyId?: string }).companyId ?? '') ?? null : null,
      whole: false,
    })),
  ]
  const [q, setQ] = useState('')
  const [showProjects, setShowProjects] = useState(false)
  const match = (name: string, company: string | null) => {
    const needle = q.trim().toLowerCase()
    if (!needle) return true
    return name.toLowerCase().includes(needle) || (company ?? '').toLowerCase().includes(needle)
  }
  const shownCompanies = targets.filter((x) => x.whole && match(x.name, null))
  const shownProjects = targets.filter((x) => !x.whole && match(x.name, x.company))

  useEffect(() => {
    if (!projectId && targets.length) setProjectId(targets[0]!.key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets.length, projectId])

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
        // Ключ цели несёт её вид: «c:» — компания целиком, «p:» — проект.
        // Префикс надо снять, иначе сервер ищет проект с таким id и отвечает
        // «вы не участник этого проекта» — при том, что участник.
        body: JSON.stringify({
          code: code.trim(),
          ...(projectId.startsWith('c:')
            ? { companyId: projectId.slice(2) }
            : { projectId: projectId.replace(/^p:/, '') }),
        }),
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

  // Сюда попадают из проекта и со стартовой страницы. Возврат — в компанию,
  // если она известна, иначе на список проектов: всегда есть куда уйти.
  const backTo = companyIds[0] ? `/start/${companyIds[0]}` : '/start'

  const copy = () => {
    navigator.clipboard.writeText(inviteLine).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex min-h-0 flex-col">
      <header className="flex items-center justify-between gap-3 border-b px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Plug className="size-4 shrink-0" />
          <span className="truncate text-sm font-semibold">{t('connect.title')}</span>
        </div>
        <div className="flex items-center gap-2">
          {/* в модалке тема и язык лишние — они есть в меню профиля */}
          {!onClose && <LanguageSelect />}
          {!onClose && <ThemeToggle />}
          {onClose && (
            <Button variant="ghost" size="icon" onClick={onClose} title={t('connect.back')}>
              <X className="size-4" />
            </Button>
          )}
        </div>
      </header>

      <main className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
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
              <div>
                <p className="text-xs font-medium text-muted-foreground">{t('connect.chooseProject')}</p>

                {/* Поиск всегда: даже с четырьмя целями искать быстрее, чем
                    водить глазами по списку, а с двадцатью — единственный
                    способ. Порог «показывать после N» только сбивает: поле то
                    появляется, то исчезает. */}
                <div className="relative mt-1.5">
                  <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={t('connect.search')}
                    className="h-8 w-full rounded-md border bg-transparent ps-8 pe-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>

                <div className="mt-2 max-h-56 overflow-y-auto pe-1">
                  {/* Компании и проекты — разные вещи: выдать компанию значит
                      открыть доступ ко всем её проектам сразу, включая будущие.
                      В одном плоском списке это различие терялось. */}
                  {shownCompanies.length > 0 && (
                    <>
                      <p className="px-0.5 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {t('connect.groupCompanies')}
                      </p>
                      <div className="space-y-1">
                        {shownCompanies.map((x) => (
                          <TargetRow
                            key={x.key}
                            active={projectId === x.key}
                            onClick={() => setProjectId(x.key)}
                            title={x.name}
                            note={t('connect.allProjectsOf')}
                            icon={<Building2 className="size-4" />}
                          />
                        ))}
                      </div>
                    </>
                  )}

                  {shownProjects.length > 0 && (
                    <>
                      {/* Один проект — редкий случай: сузить ассистента, когда
                          редактор чужой или ключ не хочется давать широко.
                          Обычному человеку это только мешает выбирать, поэтому
                          свёрнуто. Поиск раскрывает само: иначе найденное
                          пряталось бы за закрытым блоком. */}
                      <button
                        type="button"
                        onClick={() => setShowProjects((v) => !v)}
                        className="mt-2.5 flex w-full items-center gap-1 px-0.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
                      >
                        <ChevronDown
                          className={cn('size-3 transition-transform', !(showProjects || q.trim()) && '-rotate-90')}
                        />
                        {t('connect.groupProjects')}
                        <span className="font-normal normal-case tracking-normal opacity-60">
                          {t('connect.singleProjectNote')}
                        </span>
                      </button>
                      {(showProjects || q.trim()) && (
                        <div className="space-y-1">
                          {shownProjects.map((x) => (
                            <TargetRow
                              key={x.key}
                              active={projectId === x.key}
                              onClick={() => setProjectId(x.key)}
                              title={x.name}
                              note={x.company}
                              icon={<FolderKanban className="size-4" />}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {!shownCompanies.length && !shownProjects.length && (
                    <p className="py-6 text-center text-xs text-muted-foreground">{t('connect.nothingFound')}</p>
                  )}
                </div>
              </div>

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
                    {/* У туннеля на компанию проекта нет — раньше здесь читали
                        s.project.name и роняли весь экран. */}
                    {s.scope === 'company'
                      ? `${s.company?.name ?? ''} · ${t('connect.wholeCompany')}`
                      : (s.project?.name ?? '')}{' '}
                    · {t('connect.lastUsed')}{' '}
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

/**
 * Отдельный маршрут /connect — обёртка над той же панелью. Существует ради
 * старых ссылок; из интерфейса подключение открывается модалкой.
 */
export function ConnectScreen() {
  const navigate = useNavigate()
  const { t } = useTranslation()

  useEffect(() => {
    if (!getSessionToken()) navigate('/login', { replace: true })
  }, [navigate])

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {/* явный адрес, а не navigate(-1): после рефреша истории нет */}
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            title={t('connect.back')}
            onClick={() => navigate('/start', { replace: true })}
          >
            <ArrowLeft className="size-4 rtl:rotate-180" />
          </Button>
          <Logo />
        </div>
        <div className="flex items-center gap-2">
          <LanguageSelect />
          <ThemeToggle />
        </div>
      </header>
      <div className="mx-auto w-full max-w-2xl flex-1 overflow-y-auto">
        <ConnectPanel />
      </div>
    </div>
  )
}

/** Модалка подключения — основной вход из проекта и из меню профиля. */
export function ConnectDialog({ onClose }: { onClose: () => void }) {
  // Через портал, в body: диалог открывают из меню профиля в сайдбаре, а на
  // сайдбаре стоит transition — он создаёт содержащий блок, и position:fixed
  // внутри отсчитывается от колонки, а не от окна.
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85dvh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border bg-card shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <ConnectPanel onClose={onClose} />
      </div>
    </div>,
    document.body,
  )
}

/** Строка выбора: одна высота у компаний и проектов, чтобы список читался. */
function TargetRow({
  active,
  onClick,
  title,
  note,
  icon,
}: {
  active: boolean
  onClick: () => void
  title: string
  note?: string | null
  icon: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-start transition-colors',
        active ? 'border-brand bg-accent' : 'hover:bg-secondary',
      )}
    >
      <span className={cn('shrink-0', active ? 'text-brand' : 'text-muted-foreground')}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm leading-tight">{title}</span>
        {note && <span className="block truncate text-[11px] leading-tight text-muted-foreground">{note}</span>}
      </span>
      {active && <Check className="size-3.5 shrink-0 text-brand" />}
    </button>
  )
}
