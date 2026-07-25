import * as Y from 'yjs'
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import { writeSyncStep1, writeUpdate, readSyncMessage, messageYjsSyncStep2 } from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { API_URL, getProjectToken } from './api'

// Клиент совместного редактирования (SPEC §8.25, шаг 2).
// Свой минимальный провайдер вместо y-websocket: протокол тот же, но нам нужен
// контроль над реконнектом и авторизацией project-токеном.

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

export type CollabUser = { name: string; color: string; avatarUrl?: string | null }

export class CollabProvider {
  readonly doc: Y.Doc
  readonly awareness: Awareness
  private ws: WebSocket | null = null
  private closed = false
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<(connected: boolean, synced: boolean) => void>()

  connected = false
  /** true после первого полного обмена — до этого редактор держим read-only. */
  synced = false

  constructor(
    private readonly documentId: string,
    doc?: Y.Doc,
  ) {
    this.doc = doc ?? new Y.Doc()
    this.awareness = new Awareness(this.doc)

    this.doc.on('update', this.onDocUpdate)
    this.awareness.on('update', this.onAwarenessUpdate)
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', this.onUnload)

    this.connect()
  }

  onStatus(cb: (connected: boolean, synced: boolean) => void) {
    this.listeners.add(cb)
    cb(this.connected, this.synced)
    return () => this.listeners.delete(cb)
  }

  private emit() {
    for (const cb of this.listeners) cb(this.connected, this.synced)
  }

  private send(data: Uint8Array) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data)
  }

  // локальная правка → всем остальным
  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return // пришло с сервера — назад не отправляем
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MESSAGE_SYNC)
    writeUpdate(enc, update)
    this.send(encoding.toUint8Array(enc))
  }

  // движение курсора/выделения → всем остальным
  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this) return
    const changed = added.concat(updated, removed)
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(enc, encodeAwarenessUpdate(this.awareness, changed))
    this.send(encoding.toUint8Array(enc))
  }

  private onUnload = () => {
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'unload')
  }

  private connect() {
    if (this.closed) return
    const token = getProjectToken()
    if (!token) return

    const url =
      API_URL.replace(/^http/, 'ws') +
      `/yjs?token=${encodeURIComponent(token)}&doc=${encodeURIComponent(this.documentId)}`
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      this.attempt = 0
      this.connected = true
      this.emit()

      // шаг 1: наш стейт-вектор серверу
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MESSAGE_SYNC)
      writeSyncStep1(enc, this.doc)
      this.send(encoding.toUint8Array(enc))

      // и наше awareness-состояние (курсор), если уже задано
      if (this.awareness.getLocalState()) {
        const aEnc = encoding.createEncoder()
        encoding.writeVarUint(aEnc, MESSAGE_AWARENESS)
        encoding.writeVarUint8Array(aEnc, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]))
        this.send(encoding.toUint8Array(aEnc))
      }
    }

    ws.onmessage = (event) => {
      try {
        const dec = decoding.createDecoder(new Uint8Array(event.data as ArrayBuffer))
        const type = decoding.readVarUint(dec)

        if (type === MESSAGE_SYNC) {
          const reply = encoding.createEncoder()
          encoding.writeVarUint(reply, MESSAGE_SYNC)
          // origin=this: апдейт с сервера не уйдёт обратно через onDocUpdate
          const subtype = readSyncMessage(dec, reply, this.doc, this)
          if (encoding.length(reply) > 1) this.send(encoding.toUint8Array(reply))
          // Синхронизированы ТОЛЬКО после SyncStep2 (1) — именно он несёт
          // содержимое. Считать синком серверный SyncStep1 (0) нельзя: на этот
          // момент документ ещё пуст, и мы бы залили HTML-снимок поверх
          // существующего контента, задваивая его на каждой перезагрузке.
          if (!this.synced && subtype === messageYjsSyncStep2) {
            this.synced = true
            this.emit()
          }
        } else if (type === MESSAGE_AWARENESS) {
          applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), this)
        }
      } catch {
        /* битый кадр игнорируем — следующий синк всё выровняет */
      }
    }

    ws.onclose = () => {
      this.connected = false
      this.emit()
      // чужие курсоры больше не актуальны
      removeAwarenessStates(
        this.awareness,
        [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID),
        'disconnect',
      )
      if (!this.closed) {
        const delay = Math.min(1000 * 2 ** this.attempt++, 15_000)
        this.reconnectTimer = setTimeout(() => this.connect(), delay)
      }
    }
    ws.onerror = () => ws.close()
  }

  destroy() {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', this.onUnload)
    this.doc.off('update', this.onDocUpdate)
    this.awareness.off('update', this.onAwarenessUpdate)
    this.onUnload()
    this.ws?.close()
    this.awareness.destroy()
    this.listeners.clear()
  }
}

// цвет курсора — стабильный по id пользователя, чтобы не прыгал между сессиями
const CURSOR_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316']
export function userColor(userId: string): string {
  let hash = 0
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0
  return CURSOR_COLORS[hash % CURSOR_COLORS.length]!
}
