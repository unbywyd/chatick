import * as WebBrowser from 'expo-web-browser'
import { API_URL, api, setToken } from './api'

// Вход через Google.
//
// Тем же путём, что десктоп: приложение просит у сервера одноразовый код,
// открывает вход в СИСТЕМНОМ браузере и ждёт, пока там подтвердят. Google
// запрещает свой экран согласия во встроенных окнах — встроенный webview он
// просто отклонит.
//
// Токен при этом не едет через редирект и не оседает в истории браузера:
// приложение забирает его отдельным запросом по коду, который знает только оно.

type Started = { code: string; url: string }
type Poll = { status: 'pending' | 'approved' | 'denied' | 'expired'; token?: string }

/** Сколько ждём подтверждения. Дальше код всё равно протухнет на сервере. */
const DEADLINE_MS = 10 * 60_000
const POLL_MS = 2000

export type SignInResult = 'ok' | 'cancelled' | 'denied' | 'expired'

/**
 * @param isCancelled — способ прервать ожидание снаружи: человек мог закрыть
 *   браузер и нажать «Отмена», и опрос обязан это заметить, а не висеть
 *   десять минут, не давая начать заново.
 */
export async function signInWithGoogle(isCancelled: () => boolean): Promise<SignInResult> {
  const { code, url } = await api<Started>('/api/v1/auth/desktop', { method: 'POST' })

  await WebBrowser.openBrowserAsync(url)

  const deadline = Date.now() + DEADLINE_MS
  while (Date.now() < deadline) {
    if (isCancelled()) return 'cancelled'
    await new Promise((r) => setTimeout(r, POLL_MS))
    if (isCancelled()) return 'cancelled'

    const res = await api<Poll>(`/api/v1/auth/desktop/poll?code=${encodeURIComponent(code)}`)
    if (res.status === 'approved' && res.token) {
      await setToken(res.token)
      // Вкладка входа больше не нужна — на телефоне она осталась бы поверх
      // приложения, и человек решил бы, что вход не сработал.
      WebBrowser.dismissBrowser()
      return 'ok'
    }
    if (res.status === 'denied') return 'denied'
    if (res.status === 'expired') return 'expired'
  }
  return 'expired'
}

export async function signOut(): Promise<void> {
  await setToken(null)
}

export { API_URL }
