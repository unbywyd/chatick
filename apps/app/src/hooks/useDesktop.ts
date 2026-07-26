import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, getSessionToken } from '@/lib/api'

// Связь веб-приложения с десктопной оболочкой (SPEC §8.33).
//
// В браузере всего этого просто нет: window.chatickDesktop не определён, и хук
// молча ничего не делает. Один и тот же код работает в обоих местах.

type DesktopBridge = {
  version: string
  platform: string
  setState: (s: { unread: number; timer: { description: string } | null }) => void
  notify: (p: { title: string; body?: string; link?: string }) => void
  show: () => void
  info: () => Promise<{ version: string; platform: string; openAtLogin: boolean }>
  onToggleTimer: (fn: () => void) => () => void
  onNavigate: (fn: (link: string) => void) => () => void
}

declare global {
  interface Window {
    chatickDesktop?: DesktopBridge
  }
}

export const desktop = (): DesktopBridge | undefined =>
  typeof window !== 'undefined' ? window.chatickDesktop : undefined

export const isDesktop = () => Boolean(desktop())

type Inbox = { unreadTotal: number; items: { id: string; title: string; summary?: string | null; body: string; link: string }[] }
type Running = { items: { id: string; description: string; projectId: string }[] }

/**
 * Держит десктоп в курсе: бейдж, трей, уведомления о новом.
 * Вешается один раз на корень приложения.
 */
export function useDesktopSync() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const bridge = desktop()
  const authed = Boolean(getSessionToken())

  // Непрочитанные — то же, что показывает колокольчик: только адресованное мне.
  const inbox = useQuery({
    queryKey: ['inbox'],
    enabled: Boolean(bridge) && authed,
    queryFn: () => api<Inbox>('/api/v1/inbox?onlyUnread=1&limit=50'),
    refetchInterval: 30_000,
  })

  const running = useQuery({
    queryKey: ['desktop-running'],
    enabled: Boolean(bridge) && authed,
    queryFn: () => api<Running>('/api/v1/time/running', {}, 'project'),
    refetchInterval: 60_000,
    retry: false, // без project-токена запрос вернёт 401 — это нормально
  })

  // --- трей и бейдж ----------------------------------------------------------
  useEffect(() => {
    if (!bridge) return
    const timer = running.data?.items[0]
    bridge.setState({
      unread: inbox.data?.unreadTotal ?? 0,
      timer: timer ? { description: timer.description } : null,
    })
  }, [bridge, inbox.data?.unreadTotal, running.data?.items])

  // --- системные уведомления -------------------------------------------------
  useEffect(() => {
    if (!bridge || !inbox.data) return
    const seen = readSeen()
    const fresh = inbox.data.items.filter((n) => !seen.has(n.id))
    if (!fresh.length) return

    // Показываем только то, чего человек ещё не видел: иначе при каждом опросе
    // сыпались бы одни и те же уведомления.
    for (const n of fresh.slice(0, 3)) {
      bridge.notify({
        // summary — фраза ИИ о том, чего от человека хотят; она полезнее заголовка
        title: n.summary || n.title,
        body: n.summary ? n.title : n.body,
        link: n.link,
      })
      seen.add(n.id)
    }
    writeSeen(seen)
  }, [bridge, inbox.data])

  // --- команды из главного процесса -----------------------------------------
  useEffect(() => {
    if (!bridge) return
    const offNav = bridge.onNavigate((link) => {
      if (link) navigate(link)
    })
    const offTimer = bridge.onToggleTimer(async () => {
      const current = running.data?.items[0]
      try {
        if (current) {
          await api(`/api/v1/time/${current.id}/stop`, { method: 'POST' }, 'project')
        } else {
          await api('/api/v1/time/start', { method: 'POST', body: '{}' }, 'project')
        }
      } catch {
        // проект не выбран или нет прав — окно откроется, человек разберётся
        bridge.show()
      }
      qc.invalidateQueries({ queryKey: ['desktop-running'] })
      qc.invalidateQueries({ queryKey: ['time-running'] })
      qc.invalidateQueries({ queryKey: ['time-entries'] })
    })
    return () => {
      offNav()
      offTimer()
    }
  }, [bridge, navigate, qc, running.data?.items])
}

// --- что уже показывали -------------------------------------------------------
// Держим в localStorage: пережить перезапуск важнее, чем занять память.

const SEEN_KEY = 'chatick_desktop_seen'

function readSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]') as string[])
  } catch {
    return new Set()
  }
}

function writeSeen(seen: Set<string>) {
  // Храним последние 200: список уведомлений не бесконечен, а localStorage да.
  const list = [...seen].slice(-200)
  localStorage.setItem(SEEN_KEY, JSON.stringify(list))
}
