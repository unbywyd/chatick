import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { ArrowLeft, Bell } from 'lucide-react'
import { saveNotifySettings } from '@/lib/notify-settings'
import {
  browserPermission,
  requestBrowserPermission,
  useNotifySettings,
} from '@/hooks/useSystemNotifications'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'

// Системные уведомления — настройка ПРОГРАММЫ, а не проекта (SPEC §8.22).
//
// Раньше эти переключатели жили на странице уведомлений проекта, и выходило,
// будто «шуметь ли всплывашками» настраивается для каждого проекта отдельно.
// На деле вопрос один на всё приложение: хочу ли я системные уведомления и со
// звуком ли. Подписки на события — те действительно про проект и остались там.
//
// Хранится локально: за рабочим ноутбуком и домашним компьютером ответ обычно
// разный, и держать его в учётной записи значило бы навязать один выбор всем
// машинам сразу.

export function NotifySettingsScreen() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const settings = useNotifySettings()
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(browserPermission)

  // В Electron разрешение выдаёт система при установке — просить нечего.
  const isDesktop =
    typeof window !== 'undefined' && Boolean((window as { chatickDesktop?: unknown }).chatickDesktop)

  const set = (patch: Partial<typeof settings>) => saveNotifySettings({ ...settings, ...patch })

  const ask = async () => {
    const next = await requestBrowserPermission()
    setPerm(next)
    if (next === 'granted') toast.success(t('notif.permGranted'))
    else if (next === 'denied') toast.error(t('notif.systemDenied'))
    // Остались на 'default' — браузер не показал диалог (тихий режим запросов).
    else toast.error(t('notif.permBlocked'))
  }

  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} title={t('connect.back')}>
          <ArrowLeft className="size-4 rtl:-scale-x-100" />
        </Button>
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <Bell className="size-5" />
          {t('notif.system')}
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{t('notif.systemHint')}</p>

      <section className="mt-6 space-y-2.5 rounded-xl border bg-card p-4">
        {/* Разрешение — только по кнопке: браузер показывает диалог лишь в
            ответ на действие человека, а запрос из кода молча игнорирует. */}
        {!isDesktop && perm !== 'granted' && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed p-3">
            <p className="text-xs text-muted-foreground">
              {perm === 'denied' ? t('notif.systemDenied') : t('notif.systemAsk')}
            </p>
            {perm !== 'denied' && perm !== 'unsupported' && (
              <Button variant="outline" size="sm" onClick={ask}>
                {t('notif.systemAllow')}
              </Button>
            )}
          </div>
        )}

        <label className="flex cursor-pointer items-center justify-between gap-3 py-1">
          <div>
            <span className="block text-sm">{t('notif.systemEnabled')}</span>
            <span className="block text-xs text-muted-foreground">{t('notif.systemEnabledHint')}</span>
          </div>
          <Switch checked={settings.enabled} onCheckedChange={(v) => set({ enabled: v })} />
        </label>

        <label className="flex cursor-pointer items-center justify-between gap-3 py-1">
          <div>
            <span className="block text-sm">{t('notif.systemSound')}</span>
            <span className="block text-xs text-muted-foreground">{t('notif.systemSoundHint')}</span>
          </div>
          <Switch
            checked={settings.sound}
            disabled={!settings.enabled}
            onCheckedChange={(v) => set({ sound: v })}
          />
        </label>

        <label className="flex cursor-pointer items-center justify-between gap-3 py-1">
          <div>
            <span className="block text-sm">{t('notif.systemMuteFocused')}</span>
            <span className="block text-xs text-muted-foreground">
              {t('notif.systemMuteFocusedHint')}
            </span>
          </div>
          <Switch
            checked={settings.muteWhenFocused}
            disabled={!settings.enabled}
            onCheckedChange={(v) => set({ muteWhenFocused: v })}
          />
        </label>
      </section>

      {/* Подписки на события — про проект, и живут в самом проекте */}
      <p className="mt-4 text-xs text-muted-foreground">{t('notif.perProjectHint')}</p>
    </div>
  )
}
