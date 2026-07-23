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

async function presenceList(projectId: string): Promise<PresenceUser[]> {
  const ids = [...new Set([...(rooms.get(projectId) ?? [])].map((c) => c.userId))]
  if (ids.length === 0) return []
  const rows = await Promise.all(ids.map((id) => db.query.users.findFirst({ where: eq(users.id, id) })))
  return rows.filter(Boolean).map((u) => ({ id: u!.id, name: u!.name, avatarUrl: u!.avatarUrl }))
}

async function pushPresence(projectId: string) {
  broadcast(projectId, 'presence', await presenceList(projectId))
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

    // keep-alive: nginx proxy_read_timeout большой, но пинги не помешают
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping()
    }, 30_000)

    ws.on('close', () => {
      clearInterval(ping)
      const set = rooms.get(client.projectId)
      set?.delete(client)
      if (set?.size === 0) rooms.delete(client.projectId)
      void pushPresence(client.projectId)
    })
    ws.on('error', () => ws.close())
  })

  console.log('🔌 ws hub attached at /ws')
}
