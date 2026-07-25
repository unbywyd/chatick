import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import { and, eq, sql } from 'drizzle-orm'
import * as Y from 'yjs'
import { encoding, decoding } from 'lib0'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import { verifyToken } from './auth.js'
import { db } from './db/client.js'
import { documents } from './db/schema.js'
import { hasPermission } from './routes/projects.js'

// Совместное редактирование документов (SPEC §8.25, шаг 2).
// Свой минимальный y-websocket-сервер поверх нашего процесса — отдельный путь /yjs,
// потому что протокол Yjs бинарный, а хаб на /ws общается JSON-ом.
// Hocuspocus не нужен: комнаты живут в памяти, состояние персистится в documents.ycontent.

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

type Room = {
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  conns: Map<WebSocket, Set<number>> // соединение -> его awareness clientIDs
  projectId: string
  dirty: boolean
  saveTimer: NodeJS.Timeout | null
  destroyTimer: NodeJS.Timeout | null
}

const rooms = new Map<string, Room>() // documentId -> комната

const PERSIST_DEBOUNCE = 3000 // как часто скидываем состояние в БД
const EMPTY_ROOM_TTL = 60_000 // сколько держим комнату в памяти после ухода последнего

function send(ws: WebSocket, data: Uint8Array) {
  if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true })
}

function broadcastRoom(room: Room, data: Uint8Array, except?: WebSocket) {
  for (const ws of room.conns.keys()) {
    if (ws !== except) send(ws, data)
  }
}

/** Сохранить состояние комнаты в БД (base64 полного апдейта). */
async function persist(documentId: string, room: Room) {
  if (!room.dirty) return
  room.dirty = false
  try {
    const state = Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString('base64')
    await db.update(documents).set({ ycontent: state }).where(eq(documents.id, documentId))
  } catch (e) {
    room.dirty = true // не потеряем — попробуем на следующем тике
    console.error('[yjs] persist failed:', e)
  }
}

function schedulePersist(documentId: string, room: Room) {
  room.dirty = true
  if (room.saveTimer) return
  room.saveTimer = setTimeout(() => {
    room.saveTimer = null
    void persist(documentId, room)
  }, PERSIST_DEBOUNCE)
}

/** Загрузить/создать комнату. Первый вход мигрирует существующий HTML в Yjs. */
async function getRoom(documentId: string, projectId: string): Promise<Room | null> {
  const existing = rooms.get(documentId)
  if (existing) {
    if (existing.destroyTimer) {
      clearTimeout(existing.destroyTimer)
      existing.destroyTimer = null
    }
    return existing
  }

  const d = await db.query.documents.findFirst({
    where: and(eq(documents.id, documentId), eq(documents.projectId, projectId), sql`${documents.deletedAt} is null`),
  })
  if (!d) return null

  const doc = new Y.Doc()
  if (d.ycontent) {
    // уже есть Yjs-состояние — восстанавливаем как есть
    Y.applyUpdate(doc, new Uint8Array(Buffer.from(d.ycontent, 'base64')))
  }
  // Документов без ycontent НЕ инициализируем здесь: HTML -> ProseMirror-узлы
  // требует схему Tiptap, которой на сервере нет. Первый клиент зальёт контент сам
  // (см. DocEditor: если Y.Doc пуст, вставляем HTML-снимок).

  const room: Room = {
    doc,
    awareness: new awarenessProtocol.Awareness(doc),
    conns: new Map(),
    projectId,
    dirty: false,
    saveTimer: null,
    destroyTimer: null,
  }
  room.awareness.setLocalState(null) // сервер сам не участник

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MESSAGE_SYNC)
    syncProtocol.writeUpdate(enc, update)
    broadcastRoom(room, encoding.toUint8Array(enc), origin instanceof WebSocket ? origin : undefined)
    schedulePersist(documentId, room)
  })

  room.awareness.on(
    'update',
    ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = added.concat(updated, removed)
      // привязываем clientID к соединению-источнику, чтобы снять его курсор при обрыве
      if (origin instanceof WebSocket) {
        const ids = room.conns.get(origin)
        if (ids) {
          added.concat(updated).forEach((id) => ids.add(id))
          removed.forEach((id) => ids.delete(id))
        }
      }
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(room.awareness, changed))
      broadcastRoom(room, encoding.toUint8Array(enc), origin instanceof WebSocket ? origin : undefined)
    },
  )

  rooms.set(documentId, room)
  return room
}

function closeConn(documentId: string, room: Room, ws: WebSocket) {
  const ids = room.conns.get(ws)
  room.conns.delete(ws)
  if (ids && ids.size) {
    awarenessProtocol.removeAwarenessStates(room.awareness, [...ids], null)
  }

  if (room.conns.size === 0) {
    // сохраняем сразу и держим комнату ещё минуту — на случай реконнекта/перезагрузки
    void persist(documentId, room)
    room.destroyTimer = setTimeout(() => {
      void persist(documentId, room).then(() => {
        if (room.conns.size === 0) {
          room.awareness.destroy()
          room.doc.destroy()
          rooms.delete(documentId)
        }
      })
    }, EMPTY_ROOM_TTL)
  }
}

export function attachYjs(server: Server) {
  // noServer: маршрутизацию апгрейда делаем сами, иначе хабы /ws и /yjs
  // перехватывают события друг друга и отвечают 400
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '', 'http://localhost')
    if (pathname !== '/yjs') return
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    const token = url.searchParams.get('token')
    const documentId = url.searchParams.get('doc')
    const payload = token ? await verifyToken(token) : null

    if (!payload || payload.typ !== 'project' || !documentId) {
      ws.close(4001, 'unauthorized')
      return
    }
    // право на запись в документы обязательно — иначе это не co-editing, а инъекция
    if (!(await hasPermission(payload.projectId, payload.sub, 'documents.write'))) {
      ws.close(4003, 'forbidden')
      return
    }

    const room = await getRoom(documentId, payload.projectId)
    if (!room) {
      ws.close(4004, 'not found')
      return
    }

    ws.binaryType = 'arraybuffer'
    room.conns.set(ws, new Set())

    // шаг 1 синхронизации: отдать наш стейт-вектор
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(enc, room.doc)
    send(ws, encoding.toUint8Array(enc))

    // и текущие awareness-состояния (чужие курсоры)
    const states = room.awareness.getStates()
    if (states.size > 0) {
      const aEnc = encoding.createEncoder()
      encoding.writeVarUint(aEnc, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(
        aEnc,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]),
      )
      send(ws, encoding.toUint8Array(aEnc))
    }

    ws.on('message', (data: ArrayBuffer | Buffer) => {
      try {
        const bytes = data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data)
        const dec = decoding.createDecoder(bytes)
        const type = decoding.readVarUint(dec)

        if (type === MESSAGE_SYNC) {
          const reply = encoding.createEncoder()
          encoding.writeVarUint(reply, MESSAGE_SYNC)
          // origin = ws, чтобы не отправить апдейт обратно автору
          syncProtocol.readSyncMessage(dec, reply, room.doc, ws)
          if (encoding.length(reply) > 1) send(ws, encoding.toUint8Array(reply))
        } else if (type === MESSAGE_AWARENESS) {
          // applyAwarenessUpdate с origin=ws: обработчик 'update' ниже запишет
          // clientID в набор этого соединения, чтобы убрать курсор при обрыве
          awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(dec), ws)
        }
      } catch (e) {
        console.error('[yjs] message failed:', e)
      }
    })

    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping()
    }, 30_000)

    ws.on('close', () => {
      clearInterval(ping)
      closeConn(documentId, room, ws)
    })
    ws.on('error', () => ws.close())
  })

  console.log('🔗 yjs collab hub attached at /yjs')
}

/** Сохранить все комнаты — вызывается при остановке процесса, чтобы не потерять правки. */
export async function flushYjsRooms(): Promise<void> {
  await Promise.all([...rooms.entries()].map(([id, room]) => persist(id, room)))
}
