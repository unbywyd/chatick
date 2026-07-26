import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, getSessionToken } from '@/lib/api'

// Связь веб-приложения с десктопной оболочкой (SPEC §8.33).
//
// В браузере всего этого просто нет: window.chatickDesktop не определён, и хук
// молча ничего не делает. Один и тот же код работает в обоих местах.

type DesktopBridge = {
  version: string
  platform: string
  setState: (s: DesktopState) => void
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

/** Всё, что панель в трее рисует без обращения к API. */
type DesktopState = {
  /**
   * До входа панели нечего показывать: списки пусты не потому, что дел нет, а
   * потому, что мы не знаем, чьи они. Разводим эти два случая явно, иначе
   * панель врёт («всё прочитано») незалогиненному человеку.
   */
  authed: boolean
  unread: number
  timer: { id: string; description: string; startedAt: string; projectName?: string } | null
  notifications: { id: string; title: string; summary?: string | null; link: string; projectName?: string; unread: boolean }[]
  tasks: { id: string; number: string; title: string; link: string; projectName?: string; due?: string }[]
  projects: { id: string; name: string; color?: string; logoUrl?: string | null; unread: number }[]
  project: { id: string; name: string } | null
  /**
   * Подписи для панели и трея. Своего i18n у них нет и быть не должно: язык
   * выбирают в приложении, а панель — его продолжение, а не отдельный продукт.
   */
  strings: Record<string, string>
}

type InboxItem = {
  id: string
  title: string
  summary?: string | null
  body: string
  link: string
  projectId: string
  readAt?: string | null
}
type Inbox = { unreadTotal: number; items: InboxItem[] }
type Running = { items: { id: string; description: string; startedAt: string; projectId: string }[] }
type ProjectLite = {
  id: string
  name: string
  color?: string
  logoUrl?: string | null
  isMember: boolean
  stats?: { unread: number }
}
type TaskLite = { id: string; number: string; title: string; status: string; dueDate?: string | null; assignee?: { id: string } | null }

/**
 * Держит десктоп в курсе: бейдж, трей, уведомления о новом.
 * Вешается один раз на корень приложения.
 */
export function useDesktopSync() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const qc = useQueryClient()
  const bridge = desktop()
  const authed = Boolean(getSessionToken())

  // Активный проект — из адреса: /p/<id>/...
  const activeProjectId = location.pathname.match(/^\/p\/([^/]+)/)?.[1]

  const me = useQuery({
    queryKey: ['me'],
    enabled: Boolean(bridge) && authed,
    queryFn: () => api<{ id: string }>('/api/v1/auth/me'),
  })
  const meId = me.data?.id

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

  // Проекты нужны панели и для списка, и чтобы подписать, где что произошло.
  const companies = useQuery({
    queryKey: ['companies'],
    enabled: Boolean(bridge) && authed,
    queryFn: () => api<{ companies: { id: string }[] }>('/api/v1/companies'),
  })
  const companyId = companies.data?.companies[0]?.id
  const projects = useQuery({
    queryKey: ['sidebar-projects', companyId],
    enabled: Boolean(bridge) && authed && Boolean(companyId),
    queryFn: () => api<ProjectLite[]>(`/api/v1/projects?companyId=${companyId}`),
    refetchInterval: 60_000,
  })

  // Мои открытые задачи текущего проекта: панель показывает то, за что я взялся.
  const tasks = useQuery({
    queryKey: ['desktop-tasks', activeProjectId],
    enabled: Boolean(bridge) && authed && Boolean(activeProjectId),
    queryFn: () => api<TaskLite[]>('/api/v1/tasks', {}, 'project'),
    refetchInterval: 120_000,
    retry: false,
  })

  // --- состояние для трея и панели -------------------------------------------
  useEffect(() => {
    if (!bridge) return

    // Кеш запросов переживает выход из аккаунта; в панель ничего из прошлой
    // сессии попасть не должно.
    const projectList = authed ? (projects.data ?? []).filter((p) => p.isMember) : []
    const nameOf = (id: string) => projectList.find((p) => p.id === id)?.name
    const timer = authed ? running.data?.items[0] : undefined

    bridge.setState({
      authed,
      unread: authed ? inbox.data?.unreadTotal ?? 0 : 0,
      timer: timer
        ? {
            id: timer.id,
            description: timer.description,
            startedAt: timer.startedAt,
            projectName: nameOf(timer.projectId),
          }
        : null,
      notifications: (authed ? inbox.data?.items ?? [] : []).slice(0, 20).map((n) => ({
        id: n.id,
        title: n.title,
        summary: n.summary,
        link: n.link,
        projectName: nameOf(n.projectId),
        unread: !n.readAt,
      })),
      // только мои и только незакрытые: панель отвечает на «что мне делать»
      tasks: (authed ? tasks.data ?? [] : [])
        .filter((t) => t.status !== 'done' && (!meId || t.assignee?.id === meId))
        .slice(0, 30)
        .map((t) => ({
          id: t.id,
          number: t.number,
          title: t.title,
          link: `/p/${activeProjectId}/tasks/${t.id}`,
          projectName: activeProjectId ? nameOf(activeProjectId) : undefined,
          due: t.dueDate ? new Date(t.dueDate).toLocaleDateString() : undefined,
        })),
      projects: projectList.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        logoUrl: p.logoUrl,
        unread: p.stats?.unread ?? 0,
      })),
      project: authed && activeProjectId ? { id: activeProjectId, name: nameOf(activeProjectId) ?? '' } : null,
      strings: {
        start: t('desktop.start'),
        stop: t('desktop.stop'),
        idle: t('desktop.idle'),
        idleHint: t('desktop.idleHint'),
        noTask: t('time.noTask'),
        tabInbox: t('desktop.tabInbox'),
        tabTasks: t('desktop.tabTasks'),
        tabProjects: t('desktop.tabProjects'),
        emptyInbox: t('desktop.emptyInbox'),
        emptyTasks: t('desktop.emptyTasks'),
        emptyProjects: t('journal.empty'),
        openApp: t('desktop.openApp'),
        close: t('desktop.close'),
        unreadOne: t('desktop.unread'),
        allRead: t('desktop.allRead'),
        due: t('desktop.due'),
        launchAtLogin: t('desktop.launchAtLogin'),
        quit: t('desktop.quit'),
        timerRunning: t('desktop.timerRunning'),
        signIn: t('desktop.signIn'),
        signedOut: t('desktop.signedOut'),
        signedOutHint: t('desktop.signedOutHint'),
        // на иврите панель должна разворачиваться, как и всё приложение
        dir: i18n.dir(),
      },
    })
  }, [bridge, authed, inbox.data, running.data?.items, projects.data, tasks.data, activeProjectId, meId, t, i18n])

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
