import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api, API_URL, getSessionToken } from '@/lib/api'
import { loadNotifySettings, type NotifySettings } from '@/lib/notify-settings'
import type { InboxNotification } from '@/hooks/useOpenNotification'
import { normalizeLink } from '@/hooks/useOpenNotification'

// Системные уведомления — общие для веба и десктопа (SPEC §8.22).
//
// В десктопе всплывашку рисует Electron через мост, в браузере — Notification
// API. Различаются только эти две строки; всё остальное — что показывать, чего
// не повторять, когда молчать — одинаково, и держать это в двух копиях значило
// бы чинить дважды.

type Inbox = { unreadTotal: number; items: InboxNotification[] }

type DesktopBridge = {
  notify: (p: {
    title: string
    body?: string
    link?: string
    silent?: boolean
    /** чтобы клик по всплывашке пометил уведомление прочитанным */
    notificationId?: string
  }) => void
}

const SEEN_KEY = 'chatick_desktop_seen'

/**
 * Разовая чистка списка показанных.
 *
 * Прежняя версия записывала уведомление в «уже видел», даже когда решала
 * промолчать, — и оно не показывалось уже никогда. У всех, кто пользовался
 * приложением в те дни, список испорчен, и починка кода сама по себе их не
 * спасёт: непоказанное так и останется отфильтрованным. Чистим один раз.
 */
const SEEN_REPAIRED = 'chatick_seen_repaired_v1'

function repairSeenOnce() {
  if (localStorage.getItem(SEEN_REPAIRED)) return
  localStorage.removeItem(SEEN_KEY)
  localStorage.setItem(SEEN_REPAIRED, '1')
  console.info('[chatick] список показанных уведомлений очищен после исправления ошибки')
}

/**
 * Что человек уже видел. Общий ключ с десктопом: в Electron открыт тот же
 * localStorage, и без общей памяти одно уведомление показалось бы дважды.
 */
function readSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]') as string[])
  } catch {
    return new Set()
  }
}

function writeSeen(seen: Set<string>) {
  // Храним последние 200: список уведомлений не бесконечен, а localStorage да.
  localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-200)))
}

/** Пометить прочитанным и обновить всё, что показывает счётчики. */
export async function markNotificationRead(id: string, qc: QueryClient) {
  try {
    await api('/api/v1/inbox/read', { method: 'POST', body: JSON.stringify({ ids: [id] }) })
    qc.invalidateQueries({ queryKey: ['inbox'] })
    qc.invalidateQueries({ queryKey: ['inbox-system'] })
    qc.invalidateQueries({ queryKey: ['sidebar-projects'] })
  } catch {
    /* не дошло — счётчик поправится следующим опросом */
  }
}

/** Разрешение браузера: в Electron не спрашиваем — там своё, системное. */
export function browserPermission(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  return Notification.permission
}

export async function requestBrowserPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!('Notification' in window)) return 'unsupported'
  try {
    return await Notification.requestPermission()
  } catch {
    return Notification.permission
  }
}

/** Настройки с подпиской на изменения со страницы настройки. */
export function useNotifySettings(): NotifySettings {
  const [s, setS] = useState<NotifySettings>(loadNotifySettings)
  useEffect(() => {
    const reload = () => setS(loadNotifySettings())
    window.addEventListener('notify-settings:changed', reload)
    window.addEventListener('storage', reload)
    return () => {
      window.removeEventListener('notify-settings:changed', reload)
      window.removeEventListener('storage', reload)
    }
  }, [])
  return s
}

/**
 * Показывает системные уведомления о новом в инбоксе.
 *
 * Вызывается один раз на приложение. Опрос оставлен подстраховкой на редкую
 * минуту: основной сигнал — событие по сокету, которое приходит сразу.
 */
export function useSystemNotifications() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const settings = useNotifySettings()
  // Токен появляется после входа, а хук монтируется до него — считать один
  // раз нельзя: в десктопе окно открывается раньше, чем человек вошёл, и
  // запрос не включился бы уже никогда.
  const [authed, setAuthed] = useState(() => Boolean(getSessionToken()))
  useEffect(() => {
    const check = () => setAuthed(Boolean(getSessionToken()))
    const timer = window.setInterval(check, 2000)
    window.addEventListener('storage', check)
    window.addEventListener('focus', check)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('storage', check)
      window.removeEventListener('focus', check)
    }
  }, [])

  const bridge: DesktopBridge | undefined =
    typeof window !== 'undefined'
      ? (window as unknown as { chatickDesktop?: DesktopBridge }).chatickDesktop
      : undefined

  const inbox = useQuery({
    // Свой ключ: ['inbox'] уже занят колокольчиком и трейем с другими
    // условиями enabled, а React Query склеивает запросы по ключу — чьё
    // условие победит, зависело бы от порядка монтирования.
    queryKey: ['inbox-system'],
    enabled: authed,
    queryFn: () => api<Inbox>('/api/v1/inbox?onlyUnread=1&limit=50'),
    // Подстраховка, а не основной путь: событие по сокету приходит сразу.
    refetchInterval: 60_000,
  })

  // Настройки в ref: показ вызывается из обработчика сокета, и пересоздавать
  // подписку на каждое изменение галочки незачем.
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  /** последняя причина отказа — чтобы не повторять её в консоли */
  const lastSkipRef = useRef<string | null>(null)

  /**
   * Показать уведомление. Возвращает false, если показать не удалось или
   * решили промолчать, — такие НЕ помечаем показанными, иначе уведомление
   * пропало бы навсегда: замолчали при активном окне, записали в «видел», и
   * человек не увидит его уже никогда.
   */
  const show = useCallback(
    (n: InboxNotification): boolean => {
      const s = settingsRef.current
      // Почему промолчали — видно в консоли. Без этого «не работает» и
      // «молчим намеренно» выглядят одинаково, и разобраться нельзя.
      const skip = (why: string) => {
        // Одна причина — одна строка: сорок одинаковых сообщений подряд
        // скрывают всё остальное в консоли.
        if (lastSkipRef.current !== why) {
          lastSkipRef.current = why
          console.info('[chatick] уведомление не показано:', why)
        }
        return false
      }
      if (!s.enabled) return skip('выключено в настройках')
      // Окно на виду — человек и так всё видит; всплывашка только отвлекает.
      if (s.muteWhenFocused && document.visibilityState === 'visible' && document.hasFocus())
        return skip('окно активно, включено «молчать когда приложение передо мной»')

      // summary — фраза ИИ о том, чего от человека хотят; она полезнее заголовка
      const title = n.summary || n.title
      const body = n.summary ? n.title : n.body
      const link = normalizeLink(n.link, n.projectId)

      if (bridge) {
        bridge.notify({ title, body, link, silent: !s.sound, notificationId: n.id })
        return true
      }
      if (!('Notification' in window)) return skip('браузер не поддерживает Notification API')
      if (Notification.permission === 'denied')
        return skip('уведомления запрещены в настройках сайта — разрешить можно только там')
      if (Notification.permission === 'default') {
        // Просить разрешение отсюда нельзя. Браузер показывает диалог только в
        // ответ на действие человека; запрос из кода он молча игнорирует, а за
        // повторы включает защиту от навязчивых сайтов — после неё диалог не
        // появится уже никогда, и кнопка «Разрешить» перестанет работать.
        // Поэтому спрашиваем только по клику — из полоски и настроек.
        return skip('разрешение не выдано — нажмите «Разрешить» в полоске внизу')
      }
      const notification = new Notification(title, {
        body,
        icon: '/logo-small.png',
        // tag — чтобы десять событий не выстроились в десять всплывашек:
        // система заменит предыдущую по тому же проекту.
        tag: `chatick-${n.projectId}`,
        silent: !s.sound,
      })
      notification.onclick = () => {
        window.focus()
        navigate(link)
        notification.close()
        // Клик — это прочтение: уведомление привело человека на место, и
        // висеть непрочитанным ему больше незачем.
        void markNotificationRead(n.id, qc)
      }
      return true
    },
    [bridge, navigate, qc],
  )

  // Чистка испорченного списка — до первого показа, иначе непоказанные
  // уведомления так и останутся отфильтрованными.
  useEffect(() => {
    repairSeenOnce()
  }, [])

  // Показ новых: и после опроса, и после обновления по сокету — сюда приходит
  // всё, что попало в инбокс.
  useEffect(() => {
    if (!inbox.data) {
      console.info('[chatick] уведомления ещё не загружены')
      return
    }
    const seen = readSeen()
    const fresh = inbox.data.items.filter((n) => !seen.has(n.id))
    if (!fresh.length) {
      console.info(
        `[chatick] новых нет: пришло ${inbox.data.items.length}, все уже показывали ранее`,
      )
      return
    }
    // Не больше трёх за раз: если накопилось двадцать, показывать двадцать
    // всплывашек — наказание, а не помощь.
    let shown = 0
    for (const n of fresh) {
      if (shown >= 3) break
      if (show(n)) {
        seen.add(n.id)
        shown++
      }
    }
    if (shown) writeSeen(seen)
  }, [inbox.data, show])

  // Сокет проекта присылает 'notification' — обновляем инбокс сразу.
  useEffect(() => {
    if (!authed) return
    const onPing = () => qc.invalidateQueries({ queryKey: ['inbox-system'] })
    window.addEventListener('chatick:notification', onPing)
    return () => window.removeEventListener('chatick:notification', onPing)
  }, [authed, qc])

  // Своё подключение на всё приложение: сокет проекта живёт только внутри
  // проекта, а уведомления должны доходить и на списке компаний, и в инбоксе —
  // человек в программе, значит он онлайн. Без него там оставался бы опрос
  // раз в минуту.
  useEffect(() => {
    if (!authed) return
    const token = getSessionToken()
    if (!token) return

    let ws: WebSocket | null = null
    let closed = false
    let attempt = 0
    let retry: number | undefined

    const connect = () => {
      if (closed) return
      ws = new WebSocket(`${API_URL.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`)
      ws.onopen = () => {
        attempt = 0
      }
      ws.onmessage = (e) => {
        try {
          const { event } = JSON.parse(e.data as string) as { event?: string }
          if (event === 'notification') qc.invalidateQueries({ queryKey: ['inbox-system'] })
          // Часы человека — его собственные, и панель в трее живёт вне
          // проекта: без личного события она узнавала об остановке только
          // из опроса, показывая до полуминуты уже остановленный таймер.
          // Задачи в трее собраны из всех проектов, поэтому и событие о них
          // приходит личное, а не в комнату проекта.
          if (event === 'tasks_changed') {
            qc.invalidateQueries({ queryKey: ['desktop-tasks'] })
            qc.invalidateQueries({ queryKey: ['inbox'] })
          }
          if (event === 'time') {
            qc.invalidateQueries({ queryKey: ['desktop-running'] })
            qc.invalidateQueries({ queryKey: ['time-running'] })
          }
        } catch {
          /* чужое сообщение — не наша забота */
        }
      }
      ws.onclose = () => {
        // Сеть отвалилась — возвращаемся, увеличивая паузу, но не молча
        // навсегда: иначе уведомления тихо перестанут приходить.
        if (!closed) retry = window.setTimeout(connect, Math.min(1000 * 2 ** attempt++, 15_000))
      }
    }
    connect()

    return () => {
      closed = true
      if (retry) window.clearTimeout(retry)
      ws?.close()
    }
  }, [authed, qc])
}
