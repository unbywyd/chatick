import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { API_URL, getProjectToken } from '@/lib/api'

export type PresenceUser = { id: string; name: string; avatarUrl: string | null }
export type MessageAttachment = { id: string; name: string; mime: string; size: number; deleted?: boolean }
/**
 * Приложенная к сообщению сущность. Название историческое: сначала пинились
 * только задачи. У старых записей kind нет — это они и есть.
 */
export type TaskPin = {
  id: string
  kind?: 'task' | 'note' | 'document' | 'resource'
  number?: string
  title: string
  status?: string
}
export type ChatMessage = {
  id: string
  mode: 'group' | 'ai'
  status: string
  rawSend?: boolean
  text: string
  replyToId: string | null
  createdAt: string
  attachments?: MessageAttachment[]
  taskPins?: TaskPin[]
  systemEvent?: string | null // task_done | task_assigned (SPEC §8.23)
  authorId?: string | null
  author: { id: string; name: string; avatarUrl: string | null } | null // null = ИИ
}

export type TaskLockEvent = { taskId: string; user: PresenceUser | null } // null = разблокирована
export type SocketEvents = {
  onMessage: (m: ChatMessage) => void
  onChecking?: (p: { userId: string; name: string }) => void
  onCheckingDone?: (p: { userId: string }) => void
  onHeld?: (p: { messageId: string }) => void
  onSandboxChunk?: (p: { messageId: string; delta: string }) => void
  onMessageDeleted?: (p: { messageId: string }) => void
  /** таймер запустили/остановили — в том числе ИИ или другой клиент */
  onTime?: (p: { action: string; id: string; userId: string }) => void
  onTaskLock?: (p: TaskLockEvent) => void
  onTaskLockDenied?: (p: { taskId: string }) => void
  onDocPresence?: (p: { docId: string; users: PresenceUser[] }) => void
}

// Realtime проекта: presence + сообщения + пайплайн-события. Реконнект с бэкоффом.
export function useProjectSocket(projectId: string | undefined, events: SocketEvents) {
  const [online, setOnline] = useState<PresenceUser[]>([])
  const [connected, setConnected] = useState(false)
  const qc = useQueryClient()
  const eventsRef = useRef(events)
  eventsRef.current = events
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!projectId) return
    const token = getProjectToken()
    if (!token) return

    let ws: WebSocket | null = null
    let closed = false
    let attempt = 0

    const connect = () => {
      const wsUrl = API_URL.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(token)}`
      ws = new WebSocket(wsUrl)
      wsRef.current = ws
      ws.onopen = () => {
        attempt = 0
        setConnected(true)
      }
      ws.onmessage = (e) => {
        try {
          const { event, payload } = JSON.parse(e.data as string) as { event: string; payload: unknown }
          if (event === 'presence') setOnline(payload as PresenceUser[])
          if (event === 'message') eventsRef.current.onMessage(payload as ChatMessage)
          if (event === 'checking') eventsRef.current.onChecking?.(payload as { userId: string; name: string })
          if (event === 'checking_done') eventsRef.current.onCheckingDone?.(payload as { userId: string })
          if (event === 'held') eventsRef.current.onHeld?.(payload as { messageId: string })
          if (event === 'sandbox_chunk') eventsRef.current.onSandboxChunk?.(payload as { messageId: string; delta: string })
          if (event === 'message_deleted') eventsRef.current.onMessageDeleted?.(payload as { messageId: string })
          if (event === 'time') eventsRef.current.onTime?.(payload as { action: string; id: string; userId: string })
          // реал-тайм задач: ИИ или другой участник изменил доску / комментарии
          if (event === 'tasks_changed') {
            qc.invalidateQueries({ queryKey: ['tasks', projectId] })
            qc.invalidateQueries({ queryKey: ['task-groups', projectId] })
          }
          if (event === 'task_comments_changed') {
            const p = payload as { taskId?: string }
            if (p.taskId) qc.invalidateQueries({ queryKey: ['task-comments', p.taskId] })
          }
          // блокировка редактирования задачи (кто правит) — обновляем состояние локов
          if (event === 'task_lock') {
            eventsRef.current.onTaskLock?.(payload as TaskLockEvent)
          }
          if (event === 'task_lock_denied') {
            eventsRef.current.onTaskLockDenied?.(payload as { taskId: string })
          }
          // документы: кто-то изменил содержимое / кто открыл документ (SPEC §8.25)
          if (event === 'documents_changed') {
            const p = payload as { id?: string }
            qc.invalidateQueries({ queryKey: ['documents', projectId] })
            if (p.id) qc.invalidateQueries({ queryKey: ['document', p.id] })
          }
          if (event === 'doc_presence') {
            eventsRef.current.onDocPresence?.(payload as { docId: string; users: PresenceUser[] })
          }
          // новое in-app уведомление → колокольчик и системная всплывашка.
          // Через событие окна: показом занимается отдельный хук уровня
          // приложения, а сокет живёт здесь и знать о нём не должен.
          if (event === 'notification') {
            qc.invalidateQueries({ queryKey: ['inbox'] })
            window.dispatchEvent(new CustomEvent('chatick:notification'))
          }
        } catch {
          /* ignore */
        }
      }
      ws.onclose = () => {
        setConnected(false)
        setOnline([])
        if (!closed) {
          const delay = Math.min(1000 * 2 ** attempt++, 15_000)
          setTimeout(connect, delay)
        }
      }
    }
    connect()

    return () => {
      closed = true
      ws?.close()
      wsRef.current = null
    }
  }, [projectId])

  const sendLock = (event: 'lock' | 'unlock' | 'lock_heartbeat', taskId: string) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event, taskId }))
  }
  const sendDoc = (event: 'doc_open' | 'doc_close', docId: string) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event, docId }))
  }

  return {
    online,
    connected,
    lockTask: (id: string) => sendLock('lock', id),
    unlockTask: (id: string) => sendLock('unlock', id),
    heartbeatLock: (id: string) => sendLock('lock_heartbeat', id),
    openDoc: (id: string) => sendDoc('doc_open', id),
    closeDoc: (id: string) => sendDoc('doc_close', id),
  }
}

// Presence внутри одного документа: пока открыт редактор, держим собственный
// сокет и сообщаем серверу, какой документ смотрим (SPEC §8.25).
// Себя из списка убираем — показываем «кто ещё здесь».
export function useDocPresence(projectId: string | undefined, docId: string | undefined, myId?: string): PresenceUser[] {
  const [viewers, setViewers] = useState<PresenceUser[]>([])

  const { openDoc, closeDoc, connected } = useProjectSocket(docId ? projectId : undefined, {
    onMessage: () => {},
    onDocPresence: (p) => {
      if (p.docId !== docId) return
      setViewers(myId ? p.users.filter((u) => u.id !== myId) : p.users)
    },
  })

  useEffect(() => {
    if (!docId || !connected) return
    openDoc(docId)
    return () => closeDoc(docId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, connected])

  return viewers
}
