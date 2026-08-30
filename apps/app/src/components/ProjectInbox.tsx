import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowRight, Check, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
// Формат адреса один на всё приложение: своя копия здесь уже расходилась
// с общей — она не знала про вкладку /chat в ссылках старого вида.
import { normalizeLink } from '@/hooks/useOpenNotification'
import { NotificationDialog } from '@/components/NotificationDialog'

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
  /** Имя проекта: на уровне компании карточки идут вперемешку. */
  projectName?: string
}
type Inbox = { unreadTotal: number; items: Notification[] }

/**
 * Полоса «что меня касается».
 *
 * Одна и та же и внутри проекта, и на странице компании: projectId=null
 * означает «все проекты», и тогда на карточке появляется имя проекта.
 * Второй такой же компонент со своей вёрсткой разошёлся бы с этим на первой
 * же правке — а человек читал бы одни и те же уведомления по-разному.
 */
export function ProjectInbox({
  projectId,
  companyId: companyIdProp,
}: {
  /** null — показываем всё, что касается человека, из любого проекта. */
  projectId: string | null
  /** Нужен, когда компонент стоит вне проекта: там его нет в адресе. */
  companyId?: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // Полоса живёт внутри проекта — компания известна из адреса.
  const params = useParams()
  const companyId = companyIdProp ?? params.companyId
  const qc = useQueryClient()

  const inbox = useQuery({
    // Компания в ключе И в запросе. Без неё лента компании показывала
    // события ВСЕХ компаний человека: на главной StartPlan висели
    // уведомления «Личных проектов», а отличить своё от чужого было нельзя —
    // проект в подписи есть, чья он компания, не сказано.
    queryKey: ['inbox', companyId ?? 'all'],
    queryFn: () =>
      api<Inbox>(
        `/api/v1/inbox?onlyUnread=1&limit=100${companyId ? `&companyId=${encodeURIComponent(companyId)}` : ''}`,
      ),
    refetchInterval: 60_000,
  })

  const markRead = useMutation({
    mutationFn: (body: { ids?: string[]; projectId?: string; all?: boolean; companyId?: string }) =>
      api('/api/v1/inbox/read', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inbox'] })
      // Бейджи в сайдбаре считаются из stats.unread списка проектов —
      // без этого число там осталось бы прежним.
      qc.invalidateQueries({ queryKey: ['sidebar-projects'] })
      qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  // Внутри проекта — только он: человек открыл его, чужие дела здесь шум.
  // На уровне компании — всё, ради того и заходят: «что меня касается».
  const items = (inbox.data?.items ?? []).filter((n) => (projectId ? n.projectId === projectId : true) && !n.readAt)

  /**
   * Прочитанным уведомление делает только человек.
   *
   * Была автопометка: карточка гасла, продержавшись 2.5 секунды на экране.
   * Задумка «разглядел — значит прочитал» на деле работала иначе. Лента
   * горизонтальная, на широком экране видно сразу несколько карточек, и они
   * гасли пачками просто оттого, что человек смотрит на страницу. На обзоре
   * компании, где лента собирает все проекты, за десяток секунд молча уходило
   * два десятка уведомлений — ни одного из них не открывали.
   *
   * Хуже всего, что потерю нельзя ни заметить, ни отменить: уведомление
   * исчезает без следа, и вернуть его можно только правкой в базе.
   *
   * Остались два явных действия: переход по уведомлению и кнопка «прочитать».
   */

  /**
   * Открытое окно деталей: null — закрыто.
   *
   * Объявлено ДО раннего return: без уведомлений компонент выходил раньше, и
   * хук не вызывался вовсе. Стоило первому уведомлению прийти — число хуков
   * менялось между отрисовками, и React падал с «Rendered more hooks than
   * during the previous render».
   */
  const [details, setDetails] = useState<Notification | null>(null)

  if (!items.length) return null

  /**
   * Клик открывает детали, а не гасит уведомление.
   *
   * Прежде клик сразу вёл по ссылке и помечал прочитанным. Если ссылки не
   * было, normalizeLink подставлял /tasks — человек тыкал в уведомление и
   * оказывался неизвестно где, а само оно исчезало. Прочитать длинный текст
   * было негде: в карточку он не влезает.
   *
   * Прочитанным делаем при ЗАКРЫТИИ окна: человек прочёл и закончил.
   */
  const close = () => {
    if (details) markRead.mutate({ ids: [details.id] })
    setDetails(null)
  }
  const goTo = (n: Notification) => {
    navigate(normalizeLink(n.link, n.projectId, companyId))
    markRead.mutate({ ids: [n.id] })
    setDetails(null)
  }

  return (
    <div className={cn(projectId ? 'border-b' : 'rounded-lg border bg-card')}>
      <div className="flex items-center justify-between gap-3 px-3 pt-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          {t('inbox.here')}
          {/* Число баджем, а не в тексте: его ищут глазами первым, и в строке
              «Вас касается здесь: 5» пятёрка теряется среди слов. */}
          <span className="grid min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] font-bold leading-4 text-brand-foreground">
            {items.length}
          </span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs text-muted-foreground"
          // На странице компании гасим только её проекты: кнопка стоит под
          // лентой одной компании, а { all } стирал бы и остальные.
          onClick={() => markRead.mutate(projectId ? { projectId } : { all: true, companyId })}
        >
          <Check className="size-3" />
          {t('inbox.markAllRead')}
        </Button>
        {/* Когда их сотня, листать вбок бессмысленно: разбирать такую пачку
            идут на отдельный экран, где есть фильтры и вертикальный список. */}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs text-muted-foreground"
          onClick={() => navigate('/inbox')}
        >
          {t('inbox.seeAll')}
          <ArrowRight className="size-3 rtl:-scale-x-100" />
        </Button>
      </div>

      {/* Горизонтальная лента: уведомлений обычно немного, а вертикальный
          список отодвинул бы работу вниз.

          pb-3 вместо pb-2 — под полосу прокрутки: она рисуется поверх нижнего
          края карточек и срезала их. touch-pan-x — чтобы на трекпаде и
          тачскрине лента листалась вбок, а не пыталась прокрутить страницу.

          scrollbar-thin: полоса по умолчанию волосяная, и при сотне карточек
          за неё не ухватиться мышью — а именно мышью её и тянут, когда
          карточек много. */}
      <div className="scrollbar-thin flex touch-pan-x gap-2 overflow-x-auto overscroll-x-contain px-3 pb-3 pt-1.5">
        {items.map((n) => (
          <div
            key={n.id}
            className="flex w-64 shrink-0 items-start gap-2 rounded-lg border bg-card p-2 transition-colors hover:border-brand/50"
          >
            <button onClick={() => setDetails(n)} className="flex min-w-0 flex-1 items-start gap-2 text-start">
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
                {/* Имя проекта — только вне проекта: внутри него это очевидно,
                    а на странице компании карточки идут вперемешку, и без
                    подписи непонятно, куда ведёт клик. */}
                {!projectId && n.projectName && (
                  <span className="mt-1 line-clamp-1 text-[10px] font-medium text-brand-ink">{n.projectName}</span>
                )}
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

      {details && (
        <NotificationDialog
          notification={details}
          onClose={close}
          // Кнопки перехода нет, когда ссылки нет: normalizeLink подставил бы
          // /tasks, и «перейти» уводило бы в никуда конкретное.
          onOpen={details.link ? () => goTo(details) : undefined}
        />
      )}
    </div>
  )
}
