import { useEffect, useRef, useState } from 'react'
import { API_URL, getProjectToken } from '@/lib/api'

export type PresenceUser = { id: string; name: string; avatarUrl: string | null }
export type ChatMessage = {
  id: string
  mode: 'group' | 'ai'
  status: string
  text: string
  replyToId: string | null
  createdAt: string
  author: { id: string; name: string; avatarUrl: string | null } | null // null = ИИ
}

// Realtime проекта: presence + новые сообщения. Реконнект с бэкоффом.
export function useProjectSocket(projectId: string | undefined, onMessage: (m: ChatMessage) => void) {
  const [online, setOnline] = useState<PresenceUser[]>([])
  const [connected, setConnected] = useState(false)
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

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
      ws.onopen = () => {
        attempt = 0
        setConnected(true)
      }
      ws.onmessage = (e) => {
        try {
          const { event, payload } = JSON.parse(e.data as string) as { event: string; payload: unknown }
          if (event === 'presence') setOnline(payload as PresenceUser[])
          if (event === 'message') onMessageRef.current(payload as ChatMessage)
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
    }
  }, [projectId])

  return { online, connected }
}
