import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { API_URL, getProjectToken } from '@/lib/api'

export type PresenceUser = { id: string; name: string; avatarUrl: string | null }
export type MessageAttachment = { id: string; name: string; mime: string; size: number; deleted?: boolean }
export type TaskPin = { id: string; number: string; title: string; status: string }
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
  onTaskLock?: (p: TaskLockEvent) => void
  onTaskLockDenied?: (p: { taskId: string }) => void
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

  return { online, connected, lockTask: (id: string) => sendLock('lock', id), unlockTask: (id: string) => sendLock('unlock', id), heartbeatLock: (id: string) => sendLock('lock_heartbeat', id) }
}
