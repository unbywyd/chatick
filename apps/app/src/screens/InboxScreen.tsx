import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Bell, Check, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { useOpenNotification, type InboxNotification } from '@/hooks/useOpenNotification'

// Страница уведомлений (SPEC §8.22).
//
// Колокольчик отвечает на «есть ли что-то новое» и показывает только
// непрочитанное. Прочитанное из него исчезает навсегда, и восстановить его
// было нечем — история в базе есть, а посмотреть её негде. Эта страница и
// есть история: всё, за всё время, с фильтрами.
//
// Страница глобальная, а не внутри проекта: уведомления приходят сразу из
// всех проектов, и заставлять переключаться между ними, чтобы собрать
// картину, противоречит тому, зачем страница нужна.

type Inbox = { unreadTotal: number; unreadByProject: Record<string, number>; items: InboxNotification[] }

export function InboxScreen() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const [onlyUnread, setOnlyUnread] = useState(false)
  const [project, setProject] = useState<string>('')

  const inbox = useQuery({
    queryKey: ['inbox-all', onlyUnread],
    queryFn: () => api<Inbox>(`/api/v1/inbox?limit=200${onlyUnread ? '&onlyUnread=1' : ''}`),
    refetchInterval: 60_000,
  })

  const { openNotification, openProject, markRead } = useOpenNotification()

  const items = inbox.data?.items ?? []

  // Список проектов для фильтра — из самих уведомлений: показывать проект,
  // из которого ничего не приходило, незачем.
  const projects = useMemo(() => {
    const map = new Map<string, string>()
    for (const n of items) map.set(n.projectId, n.projectName)
    return [...map.entries()].map(([id, name]) => ({ id, name }))
  }, [items])

  const shown = project ? items.filter((n) => n.projectId === project) : items
  const unread = inbox.data?.unreadTotal ?? 0

  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} title={t('connect.back')}>
          <ArrowLeft className="size-4 rtl:-scale-x-100" />
        </Button>
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <Bell className="size-5" />
          {t('inbox.title')}
        </h1>
        {unread > 0 && (
          <span className="grid min-w-5 place-items-center rounded-full bg-brand px-1.5 text-xs font-bold text-brand-foreground">
            {unread}
          </span>
        )}
        {unread > 0 && (
          <button
            onClick={() => markRead.mutate({ all: true })}
            className="ms-auto cursor-pointer text-sm text-muted-foreground hover:text-foreground"
          >
            {t('inbox.markAllRead')}
          </button>
        )}
      </div>

      {/* Фильтры: непрочитанные и проект — ими разбирают накопившееся */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <FilterChip active={!onlyUnread} onClick={() => setOnlyUnread(false)}>
          {t('inbox.filterAll')}
        </FilterChip>
        <FilterChip active={onlyUnread} onClick={() => setOnlyUnread(true)}>
          {t('inbox.filterUnread')}
        </FilterChip>
        {projects.length > 1 && (
          <>
            <span className="mx-1 h-4 w-px bg-border" />
            <FilterChip active={!project} onClick={() => setProject('')}>
              {t('inbox.allProjects')}
            </FilterChip>
            {projects.map((p) => (
              <FilterChip key={p.id} active={project === p.id} onClick={() => setProject(p.id)}>
                {p.name}
              </FilterChip>
            ))}
          </>
        )}
      </div>

      <ul className="mt-4 divide-y rounded-lg border">
        {inbox.isLoading && <li className="p-6 text-center text-sm text-muted-foreground">…</li>}
        {!inbox.isLoading && shown.length === 0 && (
          <li className="p-8 text-center text-sm text-muted-foreground">{t('inbox.empty')}</li>
        )}
        {shown.map((n) => (
          <li key={n.id} className={cn('group relative', !n.readAt && 'bg-brand/5')}>
            <button
              onClick={() => openNotification(n)}
              className="flex w-full items-start gap-3 p-3 text-start transition-colors hover:bg-accent"
            >
              <Avatar name={n.actor?.name ?? 'AI'} src={n.actor?.avatarUrl} size={32} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                {/* если ИИ понял суть запроса — показываем её, а не «X упомянул вас» */}
                {/* Без block: он отменяет -webkit-box, и line-clamp перестаёт
                    работать. Подробности — в ProjectInbox. */}
                <span className="line-clamp-2 break-all text-sm font-medium">{n.summary || n.title}</span>
                <span className="mt-0.5 line-clamp-2 break-all text-xs text-muted-foreground">
                  {n.summary ? n.title : n.body}
                </span>
                <span className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="truncate">{n.projectName}</span>
                  <span>·</span>
                  <span className="shrink-0">{new Date(n.createdAt).toLocaleString(i18n.language)}</span>
                </span>
              </span>
              {!n.readAt && <span className="mt-2 size-2 shrink-0 rounded-full bg-brand" />}
            </button>

            {/* Разобрать список, не открывая каждое: прочитать и уйти в проект */}
            <div className="absolute end-3 top-3 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              {!n.readAt && (
                <button
                  title={t('inbox.markRead')}
                  onClick={() => markRead.mutate({ ids: [n.id] })}
                  className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Check className="size-3.5" />
                </button>
              )}
              <button
                title={t('inbox.openProject')}
                onClick={() => openProject(n.projectId)}
                className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <ExternalLink className="size-3.5" />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'cursor-pointer rounded-full border px-2.5 py-1 text-xs transition-colors',
        active ? 'border-brand bg-brand/10 text-brand' : 'text-muted-foreground hover:bg-accent',
      )}
    >
      {children}
    </button>
  )
}
