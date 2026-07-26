import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Bell, Check, ExternalLink } from 'lucide-react'
import { api, setProjectToken } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from '@/components/ui/dropdown-menu'

// Колокольчик уведомлений (SPEC §8.22): глобальные уведомления из всех проектов,
// сгруппированные по проекту, со счётчиками; клик ведёт к задаче/сообщению.
type Notification = {
  id: string
  projectId: string
  projectName: string
  event: string
  title: string
  /** суть запроса словами ИИ — важнее заголовка «X упомянул вас» */
  summary?: string | null
  body: string
  link: string
  readAt: string | null
  createdAt: string
  actor: { id: string; name: string; avatarUrl: string | null } | null
}
type Inbox = { unreadTotal: number; unreadByProject: Record<string, number>; items: Notification[] }

// Уведомления, созданные до появления вкладки /chat, ссылаются на /p/<id>?msg=<mid>.
// Такой путь падает на index-редирект, а он теряет query — дописываем /chat сами.
function normalizeLink(link: string, projectId: string): string {
  if (!link) return `/p/${projectId}/tasks`
  const m = link.match(/^\/p\/([^/?]+)(\?.*)?$/)
  return m ? `/p/${m[1]}/chat${m[2] ?? ''}` : link
}

export function NotificationBell({ currentProjectId }: { currentProjectId?: string }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const inbox = useQuery({
    queryKey: ['inbox'],
    queryFn: () => api<Inbox>('/api/v1/inbox?onlyUnread=1&limit=100'),
    refetchInterval: 60_000, // подстраховка; WS-событие обновляет мгновенно
  })

  const markRead = useMutation({
    mutationFn: (body: { ids?: string[]; projectId?: string; all?: boolean }) =>
      api('/api/v1/inbox/read', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inbox'] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  // группируем по проектам
  const groups = useMemo(() => {
    const map = new Map<string, { projectId: string; projectName: string; items: Notification[] }>()
    for (const n of inbox.data?.items ?? []) {
      const g = map.get(n.projectId) ?? { projectId: n.projectId, projectName: n.projectName, items: [] }
      g.items.push(n)
      map.set(n.projectId, g)
    }
    return [...map.values()]
  }, [inbox.data])

  const unread = inbox.data?.unreadTotal ?? 0

  // переход по уведомлению: если проект другой — переключаем project-токен
  const openNotification = async (n: Notification) => {
    try {
      if (n.projectId !== currentProjectId) {
        // Пометку ЖДЁМ: следом идёт reload, и незавершённый запрос просто
        // не успел бы уйти — уведомление оставалось непрочитанным.
        await markRead.mutateAsync({ ids: [n.id] })
        const r = await api<{ token: string; project: { id: string } }>(`/api/v1/projects/${n.projectId}/enter`, {
          method: 'POST',
          body: JSON.stringify({ acceptRules: false }),
        })
        setProjectToken(r.token)
        window.location.hash = `#${normalizeLink(n.link, n.projectId)}`
        window.location.reload()
        return
      }
      markRead.mutate({ ids: [n.id] })
      navigate(normalizeLink(n.link, n.projectId))
    } catch {
      toast.error(t('inbox.openFailed'))
    }
  }

  const openProject = async (projectId: string) => {
    if (projectId === currentProjectId) {
      navigate(`/p/${projectId}/tasks`)
      return
    }
    try {
      const r = await api<{ token: string; project: { id: string } }>(`/api/v1/projects/${projectId}/enter`, {
        method: 'POST',
        body: JSON.stringify({ acceptRules: false }),
      })
      setProjectToken(r.token)
      window.location.hash = `#/p/${r.project.id}/tasks`
      window.location.reload()
    } catch {
      toast.error(t('inbox.openFailed'))
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="relative rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground" title={t('inbox.title')}>
          <Bell className="size-4" />
          {unread > 0 && (
            <span className="absolute -end-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] font-bold leading-4 text-brand-foreground">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[70vh] w-80 overflow-y-auto p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">{t('inbox.title')}</span>
          {unread > 0 && (
            <button onClick={() => markRead.mutate({ all: true })} className="text-xs text-muted-foreground hover:text-foreground">
              {t('inbox.markAllRead')}
            </button>
          )}
        </div>

        {groups.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t('inbox.empty')}</p>}

        {groups.map((g) => (
          <div key={g.projectId} className="border-b last:border-0">
            {/* Заголовок проекта со счётчиком */}
            <div className="flex items-center gap-2 bg-muted/40 px-3 py-1.5">
              <span className="truncate text-xs font-semibold">{g.projectName}</span>
              <span className="grid min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] font-bold leading-4 text-brand-foreground">
                {g.items.length}
              </span>
              <div className="ms-auto flex items-center gap-1">
                <button onClick={() => markRead.mutate({ projectId: g.projectId })} title={t('inbox.markProjectRead')} className="text-muted-foreground hover:text-foreground">
                  <Check className="size-3.5" />
                </button>
                <button onClick={() => openProject(g.projectId)} title={t('inbox.openProject')} className="text-muted-foreground hover:text-foreground">
                  <ExternalLink className="size-3.5" />
                </button>
              </div>
            </div>

            {/* Уведомления проекта */}
            <ul>
              {g.items.map((n) => (
                <li key={n.id}>
                  <button
                    onClick={() => openNotification(n)}
                    className={cn('flex w-full items-start gap-2 px-3 py-2 text-start transition-colors hover:bg-accent', !n.readAt && 'bg-brand/5')}
                  >
                    <Avatar name={n.actor?.name ?? 'AI'} src={n.actor?.avatarUrl} size={22} className="mt-0.5" />
                    <span className="min-w-0 flex-1">
                      {/* если ИИ понял суть запроса — показываем её, а не «X упомянул вас» */}
                      <span className="block truncate text-sm">{n.summary || n.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {n.summary ? n.title : n.body}
                      </span>
                      <span className="block text-[10px] text-muted-foreground">{new Date(n.createdAt).toLocaleString(i18n.language)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
