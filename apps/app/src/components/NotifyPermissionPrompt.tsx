import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Bell, X } from 'lucide-react'
import { getSessionToken } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { browserPermission, requestBrowserPermission, useNotifySettings } from '@/hooks/useSystemNotifications'

// Просьба разрешить системные уведомления (SPEC §8.22).
//
// Раньше запрос жил только на странице настроек — то есть не случался
// никогда: туда не заходят, а без разрешения браузер молчит по определению.
// Получалось «уведомления не работают» без единой подсказки, что делать.
//
// Спрашиваем не сразу при загрузке: непрошеный запрос браузеры прячут, а
// человек, которого дёрнули не вовремя, жмёт «Запретить» — и вернуть это
// можно только через настройки сайта. Поэтому сначала объясняем полоской, и
// только по кнопке зовём системный диалог.

const DISMISSED = 'notify-prompt-dismissed'

export function NotifyPermissionPrompt() {
  const { t } = useTranslation()
  const settings = useNotifySettings()
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(browserPermission)
  const [hidden, setHidden] = useState(() => localStorage.getItem(DISMISSED) === '1')

  // В Electron всплывашки рисует система, разрешение не нужно.
  const isDesktop =
    typeof window !== 'undefined' && Boolean((window as { chatickDesktop?: unknown }).chatickDesktop)

  useEffect(() => {
    const onChange = () => setPerm(browserPermission())
    window.addEventListener('focus', onChange)
    return () => window.removeEventListener('focus', onChange)
  }, [])

  const show =
    !hidden &&
    !isDesktop &&
    perm === 'default' &&
    settings.enabled &&
    Boolean(getSessionToken())

  if (!show) return null

  const dismiss = () => {
    localStorage.setItem(DISMISSED, '1')
    setHidden(true)
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center p-3">
      <div className="flex w-full max-w-md items-center gap-3 rounded-xl border bg-card p-3 shadow-lg">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand/15 text-brand">
          <Bell className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t('notif.promptTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('notif.promptHint')}</p>
        </div>
        <Button
          variant="brand"
          size="sm"
          onClick={async () => {
            const next = await requestBrowserPermission()
            setPerm(next)
            if (next === 'granted') {
              toast.success(t('notif.permGranted'))
              dismiss()
              return
            }
            if (next === 'denied') {
              toast.error(t('notif.systemDenied'))
              dismiss()
              return
            }
            // Остались на 'default' — браузер не показал диалог. Так он себя
            // ведёт, когда включает тихий режим запросов; разрешить можно
            // только вручную, через значок в адресной строке.
            toast.error(t('notif.permBlocked'))
          }}
        >
          {t('notif.systemAllow')}
        </Button>
        <button
          onClick={dismiss}
          title={t('files.cancel')}
          className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}
