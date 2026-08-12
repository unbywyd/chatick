import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Bell, Check, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { useOpenNotification, type InboxNotification } from '@/hooks/useOpenNotification'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from '@/components/ui/dropdown-menu'

// Колокольчик уведомлений (SPEC §8.22): глобальные уведомления из всех проектов,
// сгруппированные по проекту, со счётчиками; клик ведёт к задаче/сообщению.
type Inbox = { unreadTotal: number; unreadByProject: Record<string, number>; items: InboxNotification[] }

export function NotificationBell({ currentProjectId }: { currentProjectId?: string }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const inbox = useQuery({
    queryKey: ['inbox'],
    queryFn: () => api<Inbox>('/api/v1/inbox?onlyUnread=1&limit=100'),
    refetchInterval: 60_000, // подстраховка; WS-событие обновляет мгновенно
  })

  // Переходы и пометка прочитанным — общие со страницей уведомлений.
  const { openNotification, openProject, markRead } = useOpenNotification(currentProjectId)

  // группируем по проектам
  const groups = useMemo(() => {
    const map = new Map<string, { projectId: string; projectName: string; items: InboxNotification[] }>()
    for (const n of inbox.data?.items ?? []) {
      const g = map.get(n.projectId) ?? { projectId: n.projectId, projectName: n.projectName, items: [] }
      g.items.push(n)
      map.set(n.projectId, g)
    }
    return [...map.values()]
  }, [inbox.data])

  const unread = inbox.data?.unreadTotal ?? 0

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
      <DropdownMenuContent align="end" className="flex max-h-[70vh] w-80 flex-col p-0">
        <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">{t('inbox.title')}</span>
          {unread > 0 && (
            <button onClick={() => markRead.mutate({ all: true })} className="text-xs text-muted-foreground hover:text-foreground">
              {t('inbox.markAllRead')}
            </button>
          )}
        </div>

        {/* Прокручивается только список. Раньше скроллилась вся панель, и
            «Смотреть все» уезжало под сотню непрочитанных: ссылка на страницу
            со всей историей была, но добраться до неё можно было лишь
            пролистав всё, ради чего на страницу и идут. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
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
        </div>

        {/* Модалка показывает только непрочитанное — за историей отсюда */}
        <button
          onClick={() => navigate('/inbox')}
          className="w-full shrink-0 cursor-pointer border-t px-3 py-2 text-center text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {t('inbox.seeAll')}
        </button>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
