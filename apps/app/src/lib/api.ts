const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3170'

export function getToken(): string | null {
  return localStorage.getItem('chatick_token')
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem('chatick_token', token)
  else localStorage.removeItem('chatick_token')
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
  const token = getToken()
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(res.status, body.error ?? res.statusText)
  }
  return res.json() as Promise<T>
}
