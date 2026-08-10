import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { apiBase, type Scope } from './bridge.js'

/**
 * Подключение к Chatick.
 *
 * Порядок такой:
 *  1. токен из памяти — внутри одной сессии он берётся отсюда;
 *  2. токен с диска — чтобы код не вводили каждый раз заново;
 *  3. запущенное десктопное приложение — оно спрашивает человека само;
 *  4. device flow — код в браузере, как раньше.
 *
 * Третий шаг и есть то, ради чего затевался MCP: у кого стоит приложение,
 * тот не набирает код вообще. У кого не стоит — работает по-старому, а не
 * упирается в «поставьте приложение».
 */

const TOKEN_FILE = join(homedir(), '.chatick', 'mcp-token.json')
/** Порт, на котором десктоп слушает просьбы о доступе. */
const DESKTOP_PORT = Number(process.env.CHATICK_DESKTOP_PORT ?? 17325)

type Stored = { token: string; user?: { id: string; name: string }; projectId?: string | null; savedAt: string }

let memory: Scope | null = null

function load(): Stored | null {
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as Stored
  } catch {
    return null
  }
}

function save(s: Stored): void {
  try {
    mkdirSync(join(homedir(), '.chatick'), { recursive: true })
    writeFileSync(TOKEN_FILE, JSON.stringify(s, null, 2))
    // Токен даёт доступ ко всей рабочей переписке: файл читает только владелец.
    // На Windows chmod почти ничего не значит, но и вреда не делает.
    chmodSync(TOKEN_FILE, 0o600)
  } catch {
    // Не сохранилось — работаем в памяти до конца сессии.
  }
}

/** Живой ли токен: дешёвый запрос, который заодно проверяет права. */
async function alive(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase()}/x/projects`, { headers: { authorization: `Bearer ${token}` } })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Спросить доступ у запущенного приложения.
 *
 * Возвращает null, если приложения нет — это не ошибка, а обычный случай:
 * дальше сработает device flow.
 */
async function askDesktop(): Promise<Stored | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${DESKTOP_PORT}/grant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client: 'Claude Code' }),
      // Человек должен успеть нажать кнопку, но и висеть вечно нельзя.
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { token?: string; user?: { id: string; name: string }; projectId?: string | null }
    if (!data.token) return null
    return { token: data.token, user: data.user, projectId: data.projectId ?? null, savedAt: new Date().toISOString() }
  } catch {
    // Приложение не запущено, отказало или человек закрыл окно.
    return null
  }
}

export type DeviceStart = { userCode: string; deviceCode: string; verifyUrl: string }

/** Шаг 1 device flow: получить код, который человек введёт в браузере. */
export async function startDeviceFlow(): Promise<DeviceStart> {
  const res = await fetch(`${apiBase()}/x/device`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client: 'Claude Code (MCP)' }),
  })
  if (!res.ok) throw new Error(`Chatick did not issue a code: HTTP ${res.status}`)
  return (await res.json()) as DeviceStart
}

/** Шаг 2: дождаться подтверждения. Возвращает null, если время вышло. */
export async function waitForApproval(deviceCode: string, maxMs = 300_000): Promise<Stored | null> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    const res = await fetch(`${apiBase()}/x/device/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCode }),
    })
    const data = (await res.json()) as { status: string; token?: string; user?: { id: string; name: string }; project?: { id: string } | null }
    if (data.status === 'approved' && data.token) {
      return {
        token: data.token,
        user: data.user,
        projectId: data.project?.id ?? null,
        savedAt: new Date().toISOString(),
      }
    }
    // denied и expired — конец: человек отказал или код протух. Дальше опрос
    // бессмысленен, и молчаливое ожидание выглядело бы как зависание.
    if (data.status === 'denied' || data.status === 'expired') return null
  }
  return null
}

/** Токен, если он уже есть и жив. Ничего не спрашивает. */
export async function currentScope(): Promise<Scope | null> {
  if (memory && (await alive(memory.token))) return memory
  const stored = load()
  if (stored && (await alive(stored.token))) {
    memory = { token: stored.token, projectId: stored.projectId }
    return memory
  }
  return null
}

/** Подключиться: сначала приложение, потом — вызов вернёт null и решает вызывающий. */
export async function connectViaDesktop(): Promise<Scope | null> {
  const granted = await askDesktop()
  if (!granted) return null
  save(granted)
  memory = { token: granted.token, projectId: granted.projectId }
  return memory
}

/** Записать токен, полученный device flow. */
export function acceptToken(stored: Stored): Scope {
  save(stored)
  memory = { token: stored.token, projectId: stored.projectId }
  return memory
}

export function forget(): void {
  memory = null
}
