import Constants from 'expo-constants'
import * as SecureStore from 'expo-secure-store'

// Обращения к серверу Chatick.
//
// Тот же API, что у веба и десктопа: мобильному приложению своих ручек не
// нужно. Токен — сессионный, уровня компании: отдельного входа в проект нет,
// доступ сразу ко всем проектам компании.

export const API_URL: string =
  (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? 'https://api.chatick.com'

// Хранилище ключей ОС, а не AsyncStorage: токен даёт доступ ко всей рабочей
// переписке, и лежать в открытом виде он не должен.
const TOKEN_KEY = 'chatick.session'

let cached: string | null = null

export async function getToken(): Promise<string | null> {
  if (cached !== null) return cached
  cached = await SecureStore.getItemAsync(TOKEN_KEY)
  return cached
}

export async function setToken(token: string | null): Promise<void> {
  cached = token
  if (token) await SecureStore.setItemAsync(TOKEN_KEY, token)
  else await SecureStore.deleteItemAsync(TOKEN_KEY)
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken()
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  })

  if (res.status === 401) {
    // Сессия кончилась — забываем токен, иначе приложение будет биться в
    // 401 до перезапуска, показывая пустые экраны вместо экрана входа.
    await setToken(null)
    throw new ApiError(401, 'Unauthorized')
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

// --- типы, общие для экранов -------------------------------------------------

export type Me = { id: string; name: string; email: string; avatarUrl: string | null }

export type Company = { id: string; name: string; role: string }

export type Project = {
  id: string
  name: string
  companyId?: string
  color?: string
  logoUrl?: string | null
  isMember: boolean
  stats?: { unread: number }
}
