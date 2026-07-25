import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import { eq } from 'drizzle-orm'
import { verifyToken } from './auth.js'
import { db } from './db/client.js'
import { users } from './db/schema.js'

// Realtime-хаб: presence (кто онлайн в проекте) + бродкаст событий (новые сообщения и т.п.).
// Подключение: /ws?token=<project-JWT> — комната = projectId из токена.

type Client = {
  ws: WebSocket
  userId: string
  projectId: string
  docId?: string // открытый сейчас документ (SPEC §8.25)
}

type PresenceUser = { id: string; name: string; avatarUrl: string | null }

const rooms = new Map<string, Set<Client>>() // projectId -> clients

function roomClients(projectId: string): Set<Client> {
  let set = rooms.get(projectId)
  if (!set) {
    set = new Set()
    rooms.set(projectId, set)
  }
  return set
}

/** Бродкаст события всем в проекте (используется и HTTP-роутами, напр. messages). */
export function broadcast(projectId: string, event: string, payload: unknown, opts?: { except?: string }) {
  const msg = JSON.stringify({ event, payload })
  for (const c of rooms.get(projectId) ?? []) {
    if (opts?.except && c.userId === opts.except) continue
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg)
  }
}

/** Событие конкретному юзеру проекта (все его вкладки). */
export function sendToUser(projectId: string, userId: string, event: string, payload: unknown) {
  const msg = JSON.stringify({ event, payload })
  for (const c of rooms.get(projectId) ?? []) {
    if (c.userId === userId && c.ws.readyState === WebSocket.OPEN) c.ws.send(msg)
  }
}

// --- Блокировка редактирования задачи (эфемерная, в памяти) ---
// key = `${projectId}:${taskId}` → { userId, user, expiresAt }
type Lock = { userId: string; user: PresenceUser; expiresAt: number }
const taskLocks = new Map<string, Lock>()
const LOCK_TTL = 90_000 // сбрасывается, если клиент не продлил (heartbeat)

function lockKey(projectId: string, taskId: string) {
  return `${projectId}:${taskId}`
}

async function acquireLock(client: Client, taskId: string): Promise<boolean> {
  const key = lockKey(client.projectId, taskId)
  const existing = taskLocks.get(key)
  const now = Date.now()
  if (existing && existing.userId !== client.userId && existing.expiresAt > now) return false // занято другим
  const u = await db.query.users.findFirst({ where: eq(users.id, client.userId) })
  const user: PresenceUser = { id: client.userId, name: u?.name ?? '', avatarUrl: u?.avatarUrl ?? null }
  taskLocks.set(key, { userId: client.userId, user, expiresAt: now + LOCK_TTL })
  broadcast(client.projectId, 'task_lock', { taskId, user })
  return true
}

function releaseLock(client: Client, taskId: string) {
  const key = lockKey(client.projectId, taskId)
  const existing = taskLocks.get(key)
  if (existing && existing.userId === client.userId) {
    taskLocks.delete(key)
    broadcast(client.projectId, 'task_lock', { taskId, user: null })
  }
}

function releaseAllLocksOf(client: Client) {
  for (const [key, lock] of taskLocks) {
    if (key.startsWith(client.projectId + ':') && lock.userId === client.userId) {
      taskLocks.delete(key)
      const taskId = key.slice(client.projectId.length + 1)
      broadcast(client.projectId, 'task_lock', { taskId, user: null })
    }
  }
}

/** Текущие локи проекта — для первичной синхронизации при открытии доски. */
export function locksOf(projectId: string): { taskId: string; user: PresenceUser }[] {
  const now = Date.now()
  const out: { taskId: string; user: PresenceUser }[] = []
  for (const [key, lock] of taskLocks) {
    if (key.startsWith(projectId + ':') && lock.expiresAt > now) out.push({ taskId: key.slice(projectId.length + 1), user: lock.user })
  }
  return out
}

async function presenceList(projectId: string): Promise<PresenceUser[]> {
  const ids = [...new Set([...(rooms.get(projectId) ?? [])].map((c) => c.userId))]
  if (ids.length === 0) return []
  const rows = await Promise.all(ids.map((id) => db.query.users.findFirst({ where: eq(users.id, id) })))
  return rows.filter(Boolean).map((u) => ({ id: u!.id, name: u!.name, avatarUrl: u!.avatarUrl }))
}

async function pushPresence(projectId: string) {
  broadcast(projectId, 'presence', await presenceList(projectId))
}

// --- Presence внутри документа (SPEC §8.25): кто сейчас открыл документ ---
async function docPresenceList(projectId: string, docId: string): Promise<PresenceUser[]> {
  const ids = [...new Set([...(rooms.get(projectId) ?? [])].filter((c) => c.docId === docId).map((c) => c.userId))]
  if (ids.length === 0) return []
  const rows = await Promise.all(ids.map((id) => db.query.users.findFirst({ where: eq(users.id, id) })))
  return rows.filter(Boolean).map((u) => ({ id: u!.id, name: u!.name, avatarUrl: u!.avatarUrl }))
}

async function pushDocPresence(projectId: string, docId: string) {
  broadcast(projectId, 'doc_presence', { docId, users: await docPresenceList(projectId, docId) })
}

export function attachWs(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    const token = url.searchParams.get('token')
    const payload = token ? await verifyToken(token) : null
    if (!payload || payload.typ !== 'project') {
      ws.close(4001, 'unauthorized')
      return
    }

    const client: Client = { ws, userId: payload.sub, projectId: payload.projectId }
    roomClients(client.projectId).add(client)
    void pushPresence(client.projectId)
    // отдать текущие локи новому клиенту
    for (const l of locksOf(client.projectId)) ws.send(JSON.stringify({ event: 'task_lock', payload: { taskId: l.taskId, user: l.user } }))

    // входящие команды: лок редактирования задачи + presence внутри документа
    ws.on('message', (data) => {
      try {
        const { event, taskId, docId } = JSON.parse(String(data)) as { event?: string; taskId?: string; docId?: string }

        // документ открыт/закрыт — обновляем список «кто здесь» (SPEC §8.25)
        if (event === 'doc_open' && docId) {
          const prev = client.docId
          client.docId = docId
          if (prev && prev !== docId) void pushDocPresence(client.projectId, prev)
          void pushDocPresence(client.projectId, docId)
          return
        }
        if (event === 'doc_close') {
          const prev = client.docId
          client.docId = undefined
          if (prev) void pushDocPresence(client.projectId, prev)
          return
        }

        if (!taskId) return
        if (event === 'lock' || event === 'lock_heartbeat') {
          void acquireLock(client, taskId).then((ok) => {
            if (!ok) ws.send(JSON.stringify({ event: 'task_lock_denied', payload: { taskId } }))
          })
        } else if (event === 'unlock') {
          releaseLock(client, taskId)
        }
      } catch {
        /* ignore */
      }
    })

    // keep-alive: nginx proxy_read_timeout большой, но пинги не помешают
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping()
    }, 30_000)

    ws.on('close', () => {
      clearInterval(ping)
      releaseAllLocksOf(client)
      const set = rooms.get(client.projectId)
      set?.delete(client)
      const openDoc = client.docId
      if (set?.size === 0) rooms.delete(client.projectId)
      void pushPresence(client.projectId)
      if (openDoc) void pushDocPresence(client.projectId, openDoc)
    })
    ws.on('error', () => ws.close())
  })

  console.log('🔌 ws hub attached at /ws')
}
