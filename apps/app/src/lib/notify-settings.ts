// Настройки системных уведомлений (SPEC §8.22).
//
// Локально, как и горячие клавиши: «шуметь ли на этой машине» — свойство
// места, а не учётной записи. За рабочим ноутбуком и домашним компьютером
// ответ обычно разный.

export type NotifySettings = {
  /** показывать системные уведомления */
  enabled: boolean
  /** молчать, когда окно и так на виду */
  muteWhenFocused: boolean
  /** звук — отдельно: всплывашка мешает меньше, чем звук */
  sound: boolean
}

export const DEFAULT_NOTIFY: NotifySettings = {
  enabled: true,
  muteWhenFocused: true,
  sound: false,
}

const KEY = 'notify-settings'

export function loadNotifySettings(): NotifySettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_NOTIFY
    const p = JSON.parse(raw) as Partial<NotifySettings>
    return {
      enabled: typeof p.enabled === 'boolean' ? p.enabled : DEFAULT_NOTIFY.enabled,
      muteWhenFocused:
        typeof p.muteWhenFocused === 'boolean' ? p.muteWhenFocused : DEFAULT_NOTIFY.muteWhenFocused,
      sound: typeof p.sound === 'boolean' ? p.sound : DEFAULT_NOTIFY.sound,
    }
  } catch {
    return DEFAULT_NOTIFY
  }
}

export function saveNotifySettings(next: NotifySettings) {
  localStorage.setItem(KEY, JSON.stringify(next))
  window.dispatchEvent(new CustomEvent('notify-settings:changed'))
}
