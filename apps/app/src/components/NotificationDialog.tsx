import { createPortal } from 'react-dom'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, X } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'

/**
 * Детали уведомления перед переходом.
 *
 * Раньше клик по карточке гасил уведомление и, если ссылки не было, просто
 * убирал его с экрана: тыкнул — пропало, никуда не привело. Уведомление без
 * ссылки нельзя было даже дочитать, а длинный текст в карточку не влезает.
 *
 * Теперь клик всегда показывает, о чём речь: полный текст, кто и когда, и
 * кнопка перехода — если есть куда идти. Прочитанным уведомление становится
 * при закрытии, а не при показе: человек его увидел и закончил с ним.
 */

export type NotificationDetails = {
  id: string
  title: string
  summary?: string | null
  body: string
  link: string
  createdAt?: string
  projectName?: string
  actor: { id: string; name: string; avatarUrl: string | null } | null
}

export function NotificationDialog({
  notification,
  onClose,
  onOpen,
}: {
  notification: NotificationDetails
  /** Закрыть окно. Здесь же уведомление помечается прочитанным. */
  onClose: () => void
  /** Перейти по ссылке — только когда она есть. */
  onOpen?: () => void
}) {
  const { t, i18n } = useTranslation()

  // Escape закрывает: окно поверх всего, и мышью до крестика ещё добираться.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start gap-3 border-b p-4">
          <Avatar name={notification.actor?.name ?? 'AI'} src={notification.actor?.avatarUrl} size={36} />
          <div className="min-w-0 flex-1">
            {/* Сводка от ИИ, если есть: она говорит, чего от человека хотят,
                а заголовок — лишь «X упомянул вас». */}
            <p className="text-sm font-semibold leading-snug">{notification.summary || notification.title}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              {notification.actor && <span>{notification.actor.name}</span>}
              {notification.projectName && (
                <>
                  <span aria-hidden>·</span>
                  <span className="text-brand-ink">{notification.projectName}</span>
                </>
              )}
              {notification.createdAt && (
                <>
                  <span aria-hidden>·</span>
                  <span>{new Date(notification.createdAt).toLocaleString(i18n.language)}</span>
                </>
              )}
            </p>
          </div>
          <Button variant="ghost" size="icon" className="shrink-0" onClick={onClose} title={t('rules.decline')}>
            <X className="size-4" />
          </Button>
        </header>

        {/* Полный текст, а не обрезанный: ради него окно и открывают.
            whitespace-pre-wrap — переносы строк в сообщении значимы. */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{notification.body}</p>
        </div>

        <footer className="flex justify-end gap-2 border-t p-3">
          <Button variant="outline" onClick={onClose}>
            {t('inbox.detailsClose')}
          </Button>
          {/* Кнопки перехода нет, когда идти некуда: пустая кнопка обещала бы
              то, чего не будет. */}
          {onOpen && (
            <Button variant="brand" onClick={onOpen}>
              {t('inbox.detailsGo')}
              <ArrowRight className="size-3.5 rtl:-scale-x-100" />
            </Button>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  )
}
