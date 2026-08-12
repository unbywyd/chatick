import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Check, X } from 'lucide-react'
import { api } from '@/lib/api'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
// Формат адреса один на всё приложение: своя копия здесь уже расходилась
// с общей — она не знала про вкладку /chat в ссылках старого вида.
import { normalizeLink } from '@/hooks/useOpenNotification'

// Полоса «что меня касается» внутри проекта (SPEC §8.22).
//
// Бейдж говорит, что что-то есть, но не что именно — за подробностями
// приходилось идти в колокольчик, хотя человек уже открыл нужный проект.
// Здесь показываем непрочитанное этого проекта прямо над работой: прочитал,
// кликнул, бейдж погас.

type Notification = {
  id: string
  projectId: string
  event: string
  title: string
  /** суть запроса словами ИИ — важнее заголовка «X упомянул вас» */
  summary?: string | null
  body: string
  link: string
  readAt: string | null
  actor: { id: string; name: string; avatarUrl: string | null } | null
}
type Inbox = { unreadTotal: number; items: Notification[] }

export function ProjectInbox({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // Полоса живёт внутри проекта — компания известна из адреса.
  const { companyId } = useParams()
  const qc = useQueryClient()

  const inbox = useQuery({
    queryKey: ['inbox'],
    queryFn: () => api<Inbox>('/api/v1/inbox?onlyUnread=1&limit=100'),
    refetchInterval: 60_000,
  })

  const markRead = useMutation({
    mutationFn: (body: { ids?: string[]; projectId?: string }) =>
      api('/api/v1/inbox/read', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inbox'] })
      // Бейджи в сайдбаре считаются из stats.unread списка проектов —
      // без этого число там осталось бы прежним.
      qc.invalidateQueries({ queryKey: ['sidebar-projects'] })
      qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  // Только этот проект: человек открыл его, чужие дела здесь — шум.
  const items = (inbox.data?.items ?? []).filter((n) => n.projectId === projectId && !n.readAt)
  if (!items.length) return null

  // Сначала переход, потом пометка: карточка не должна исчезать раньше, чем
  // человек окажется на месте — иначе клик выглядит как «просто пропало».
  const open = (n: Notification) => {
    navigate(normalizeLink(n.link, n.projectId, companyId))
    markRead.mutate({ ids: [n.id] })
  }

  return (
    <div className="border-b bg-brand/5">
      <div className="flex items-center justify-between gap-3 px-3 pt-2">
        <span className="text-xs font-semibold text-muted-foreground">
          {t('inbox.hereTitle', { count: items.length })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs text-muted-foreground"
          onClick={() => markRead.mutate({ projectId })}
        >
          <Check className="size-3" />
          {t('inbox.markAllRead')}
        </Button>
      </div>

      {/* Горизонтальная лента: уведомлений обычно немного, а вертикальный
          список отодвинул бы работу вниз. */}
      <div className="flex gap-2 overflow-x-auto px-3 pb-2 pt-1.5">
        {items.map((n) => (
          <div
            key={n.id}
            className="flex w-64 shrink-0 items-start gap-2 rounded-lg border bg-card p-2 transition-colors hover:border-brand/50"
          >
            <button onClick={() => open(n)} className="flex min-w-0 flex-1 items-start gap-2 text-start">
              <Avatar name={n.actor?.name ?? 'AI'} src={n.actor?.avatarUrl} size={24} />
              <span className="min-w-0 flex-1">
                {/* Ни block, ни truncate рядом с line-clamp: оба ставят свой
                    display и отменяют -webkit-box, на котором line-clamp
                    держится. Карточка тогда растёт без предела.

                    break-words — вторая половина: обрезать line-clamp умеет
                    только строки, а ссылка на фигму это одно слово без
                    пробелов, шире карточки, и рвать его браузеру негде. */}
                <span className="line-clamp-1 break-all text-xs font-medium">{n.summary || n.title}</span>
                <span className="mt-0.5 line-clamp-2 break-all text-[11px] leading-snug text-muted-foreground">
                  {n.body}
                </span>
              </span>
            </button>
            {/* Прочитать, не открывая: не всё требует перехода. */}
            <button
              onClick={() => markRead.mutate({ ids: [n.id] })}
              title={t('inbox.markRead')}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
