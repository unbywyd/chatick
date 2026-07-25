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

// Приглашение, открытое до входа: запоминаем токен и возвращаемся к нему после логина.
const PENDING_INVITE_KEY = 'chatick_pending_invite'
export const setPendingInvite = (token: string) => localStorage.setItem(PENDING_INVITE_KEY, token)
export function consumePendingInvite(): string | null {
  const token = localStorage.getItem(PENDING_INVITE_KEY)
  if (token) localStorage.removeItem(PENDING_INVITE_KEY)
  return token
}

export function logout() {
  setSessionToken(null)
  setProjectToken(null)
}

// Ссылка на изображение внутри документа (SPEC §8.25).
// В HTML документа сохраняется БЕЗ токена — доступ авторизуется самим документом.
// Приватный документ в приложении: токен добавляется только на рендере (см. withDocImageAuth).
export const docImageUrl = (documentId: string, fileId: string) => `${API_URL}/files/doc/${documentId}/${fileId}`

// <img> не умеет слать Authorization → для приватного документа подставляем project-токен в URL.
// Делается на лету при показе, в сохранённый контент токен не попадает.
export function withDocImageAuth(html: string): string {
  const token = getProjectToken()
  if (!token) return html
  return html.replace(
    new RegExp(`(src=")(${API_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/files/doc/[^"?]+)(")`, 'g'),
    (_m, a: string, url: string, b: string) => `${a}${url}?t=${encodeURIComponent(token)}${b}`,
  )
}

// Обратная операция — снять токен перед сохранением, чтобы он не осел в контенте.
export const stripDocImageAuth = (html: string) =>
  html.replace(/(src="[^"]*\/files\/doc\/[^"?]+)\?t=[^"]*(")/g, '$1$2')

// Инлайн-картинки в задачах и комментариях (SPEC §8.25).
// Тот же принцип: в тексте лежит ссылка без токена, токен добавляется на рендере.
export const inlineImageUrl = (fileId: string) => `${API_URL}/files/inline/${fileId}`

const INLINE_RE = /(\/files\/inline\/[A-Za-z0-9_-]+)(\?t=[^\s")]*)?/g

/** Подставить project-токен в ссылки картинок (markdown или HTML). */
export function withInlineImageAuth(text: string): string {
  const token = getProjectToken()
  if (!token) return text
  return text.replace(INLINE_RE, (_m, path: string) => `${path}?t=${encodeURIComponent(token)}`)
}

/** Снять токен перед сохранением, чтобы он не осел в контенте. */
export const stripInlineImageAuth = (text: string) => text.replace(INLINE_RE, (_m, path: string) => path)

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

// Загрузка инлайн-картинки из редактора (документы, задачи, комментарии).
// manager=1 — файл постоянный, а не временное вложение композера (SPEC §8.17).
// Возвращает стабильный URL для вставки в контент.
export async function uploadInlineImage(file: File): Promise<{ id: string; url: string }> {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('manager', '1')
  const res = await fetch(`${API_URL}/api/v1/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getProjectToken()}` },
    body: fd,
  })
  if (!res.ok) throw new ApiError(res.status, 'upload failed')
  const created = (await res.json()) as { id: string }
  return { id: created.id, url: inlineImageUrl(created.id) }
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
