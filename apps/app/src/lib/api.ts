export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3200'

// Двухступенчатая auth (SPEC §5): session-токен (личность) + project-токен (внутри проекта)
const SESSION_KEY = 'chatick_session'
const PROJECT_KEY = 'chatick_project_token'

export const getSessionToken = () => localStorage.getItem(SESSION_KEY)
export const setSessionToken = (t: string | null) =>
  t ? localStorage.setItem(SESSION_KEY, t) : localStorage.removeItem(SESSION_KEY)

export const getProjectToken = () => localStorage.getItem(PROJECT_KEY)
export const setProjectToken = (t: string | null) =>
  t ? localStorage.setItem(PROJECT_KEY, t) : localStorage.removeItem(PROJECT_KEY)

export function logout() {
  setSessionToken(null)
  setProjectToken(null)
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message)
  }
}

type Scope = 'session' | 'project'

export async function api<T>(path: string, init: RequestInit = {}, scope: Scope = 'session'): Promise<T> {
  const token = scope === 'project' ? getProjectToken() : getSessionToken()
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  })
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText, body)
  return body as T
}

// --- types ---
export type Me = { id: string; email: string; name: string; locale: string; phone: string | null; avatarUrl: string | null }
export type Company = { id: string; name: string; logoUrl: string | null; myRole: 'admin' | 'manager' | 'member' }
export type CompanyInvite = { id: string; token: string; role: string; company: { id: string; name: string; logoUrl: string | null } }
export type ProjectListItem = {
  id: string
  name: string
  slug: string
  about: string
  chatRules: string
  isMember: boolean
  myRole: 'owner' | 'admin' | 'member' | null
  rulesAccepted: boolean
}
