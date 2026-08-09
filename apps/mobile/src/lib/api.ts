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
    /** Тело ответа целиком: у 428 в нём лежат правила чата, а у 409 — причина. */
    public body: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

export async function api<T>(
  path: string,
  init: RequestInit = {},
  /**
   * Проектный токен вместо сессионного: ручки внутри проекта сессионный не
   * принимают. Передаём явно, а не подменяем глобально — иначе один запрос
   * к проекту молча ломал бы все следующие запросы уровня компании.
   */
  token?: string,
): Promise<T> {
  const auth = token ?? (await getToken())
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...init.headers,
    },
  })

  if (res.status === 401) {
    // Сессия кончилась — забываем токен, иначе приложение будет биться в
    // 401 до перезапуска, показывая пустые экраны вместо экрана входа.
    //
    // Но только свой, сессионный: у проектного токена свой срок, и его 401
    // не значит, что человека разлогинило.
    if (!token) await setToken(null)
    throw new ApiError(401, 'Unauthorized')
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    throw new ApiError(res.status, (body.error as string) ?? `HTTP ${res.status}`, body)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

// --- типы, общие для экранов -------------------------------------------------

export type Me = { id: string; name: string; email: string; avatarUrl: string | null }

export type Company = {
  id: string
  name: string
  logoUrl: string | null
  myRole: string
  /** своя — та, которую человек завёл сам, а не та, где он админ */
  isOwner: boolean
  projectsCount: number
}

/** Приглашение в компанию: пришло на почту, но ещё не принято. */
export type CompanyInvite = {
  id: string
  token: string
  role: string
  company: { id: string; name: string; logoUrl: string | null }
}

export type CompaniesResponse = { companies: Company[]; invites: CompanyInvite[] }

export type Project = {
  id: string
  name: string
  companyId?: string
  color?: string | null
  logoUrl?: string | null
  isMember: boolean
  lastMessage: { text: string; author: string; at: string } | null
  stats?: { unread: number }
}

/** Уведомление из общей ленты по всем проектам (GET /inbox). */
export type InboxItem = {
  id: string
  projectId: string
  projectName: string
  event: string
  title: string
  summary: string | null
  body: string | null
  link: string | null
  entityType: string | null
  entityId: string | null
  readAt: string | null
  createdAt: string
  actor: { id: string; name: string; avatarUrl: string | null } | null
}

export type InboxResponse = {
  unreadTotal: number
  unreadByProject: Record<string, number>
  items: InboxItem[]
}

/** Идущий таймер — по всем проектам, не только по открытому. */
export type RunningEntry = {
  id: string
  projectId: string
  projectName: string
  startedAt: string
  description: string | null
  task: { id: string; number: string; title: string } | null
}
