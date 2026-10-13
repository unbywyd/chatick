import { useEffect } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, API_URL, ApiError, getSessionToken, type Me } from '@/lib/api'

/**
 * Данные веба v2: всё на сессии и на всю компанию сразу.
 *
 * Старый клиент жил внутри проекта и слал проект заголовком. v2 — один экран
 * на компанию, проект в нём только фильтр, поэтому основа — /api/v1/ball
 * (списки мяча по всем проектам) и ручки по сессии. Там, где сервер требует
 * проект (комментарии, ход), он берётся из самой задачи — см. inProject.
 */

export type Move = 'do' | 'review' | 'answer'
export type Person = { id: string; name: string; avatarUrl: string | null }
export type ProjectRef = { id: string; name: string; color: string | null; logoUrl: string | null }

export type BallItem = {
  id: string
  number: string
  title: string
  status: string
  priority: string
  dueDate: string | null
  createdAt: string
  estimateMinutes?: number | null
  /** Сколько вложений у задачи. */
  files?: number
  /** Сколько незакрытых задач её держат: больше нуля — замок в строке. */
  blockedBy?: number
  /** Только у закрытой задачи — когда закрыли. */
  closedAt?: string | null
  project: ProjectRef | null
  owner: Person | null
  holder: Person | null
  ball: { move: Move; round: number; heldSince: string | null; waitingClientSince: string | null; onTable: boolean; askFromId: string | null }
  isNew: boolean
  last: { action: string; note: string; via: string; at: string; actor: Person | null } | null
}

export type CompanyRole = 'admin' | 'manager' | 'member'
export type Company = {
  id: string
  name: string
  logoUrl: string | null
  myRole: CompanyRole
  isOwner: boolean
  projectsCount: number
  mainProjectId?: string | null
  /** Язык писем приглашённым и умолчание для новых проектов. */
  locale?: string
  externalSystemName?: string | null
  externalProjectUrl?: string | null
  projectsViaApiOnly?: boolean
  membersViaApiOnly?: boolean
}

export type CompanyProject = ProjectRef & {
  companyId: string
  myRole?: string | null
  /** Скрыт человеком (хранится на сервере); с непрочитанным сервер снова его показывает. */
  hidden?: boolean
}

export type HandoffAction = 'review' | 'accept' | 'return' | 'ask' | 'answer' | 'pass' | 'take' | 'wait_client' | 'client_replied' | 'cancel' | 'reopen'

export type TaskFull = {
  task: {
    id: string
    number: string
    title: string
    description: string
    status: string
    priority: string
    dueDate: string | null
    estimateMinutes: number | null
    createdAt: string
    updatedAt: string
    closed: boolean
    project: (ProjectRef & { companyId: string }) | null
    owner: Person | null
    holder: Person | null
    askFrom: Person | null
    returnTo: Person | null
    ball: { move: Move; round: number; heldSince: string | null; waitingClientSince: string | null; onTable: boolean }
    isNew: boolean
  }
  team: Person[]
  can: Partial<Record<HandoffAction | 'table' | 'edit', boolean>>
}

export type Handoff = {
  id: string
  action: string
  note: string
  round: number
  moveBefore: Move | null
  moveAfter: Move | null
  createdAt: string
  actor: Person | null
  from: Person | null
  to: Person | null
}

export type Comment = { id: string; body: string; createdAt: string; author: Person | null }

export type Notice = {
  id: string
  projectId: string | null
  projectName: string | null
  event: string
  title: string
  summary: string | null
  body: string | null
  link: string | null
  entityType: string | null
  entityId: string | null
  readAt: string | null
  createdAt: string
  actor: Person | null
}

export type TimeRun = { id: string; projectId: string | null; projectName: string; startedAt: string; description?: string }

/** Заголовок проекта для ручек, которые живут внутри проекта. */
export const inProject = (projectId: string) => ({ headers: { 'X-Project': projectId } })

export const keys = {
  me: ['v2', 'me'] as const,
  companies: ['v2', 'companies'] as const,
  projects: (companyId: string) => ['v2', 'projects', companyId] as const,
  mine: (companyId: string) => ['v2', 'ball', 'mine', companyId] as const,
  fromMe: (companyId: string) => ['v2', 'ball', 'from-me', companyId] as const,
  all: (companyId: string) => ['v2', 'ball', 'all', companyId] as const,
  closed: (companyId: string, tab: string, project: string | null) => ['v2', 'ball', 'closed', companyId, tab, project ?? ''] as const,
  closedCount: (companyId: string, tab: string, project: string | null) => ['v2', 'ball', 'closed-count', companyId, tab, project ?? ''] as const,
  task: (id: string) => ['v2', 'task', id] as const,
  handoffs: (id: string) => ['v2', 'handoffs', id] as const,
  comments: (id: string) => ['v2', 'comments', id] as const,
  inbox: (companyId: string) => ['v2', 'inbox', companyId] as const,
  running: ['v2', 'time', 'running'] as const,
  today: ['v2', 'time', 'today'] as const,
}

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: () => api<Me>('/api/v1/auth/me'), staleTime: 5 * 60_000 })
}

export function useCompanies() {
  return useQuery({
    queryKey: keys.companies,
    queryFn: () => api<{ companies: Company[] }>('/api/v1/companies').then((r) => r.companies),
    staleTime: 5 * 60_000,
  })
}

/**
 * Проекты компании, которые человек видит. Менеджер и админ видят все,
 * участник — только свои: это решает сервер, клиент только показывает.
 */
export function useProjects(companyId: string) {
  return useQuery({
    queryKey: keys.projects(companyId),
    queryFn: () =>
      api<{ projects?: CompanyProject[] } | CompanyProject[]>(`/api/v1/projects?companyId=${encodeURIComponent(companyId)}`).then((r) =>
        Array.isArray(r) ? r : (r.projects ?? []),
      ),
    staleTime: 60_000,
  })
}

export function useMine(companyId: string) {
  return useQuery({
    queryKey: keys.mine(companyId),
    queryFn: () => api<{ table: BallItem[]; items: BallItem[] }>(`/api/v1/ball/mine?companyId=${encodeURIComponent(companyId)}`),
    // Стола в вебе пока нет: задачи «на столе» — обычные строки списка.
    select: (r) => [...r.table, ...r.items],
  })
}

export function useFromMe(companyId: string) {
  return useQuery({
    queryKey: keys.fromMe(companyId),
    queryFn: () => api<{ items: BallItem[] }>(`/api/v1/ball/from-me?companyId=${encodeURIComponent(companyId)}`).then((r) => r.items),
  })
}

/**
 * «Все» — открытые задачи всех видимых проектов (руководителю — всей
 * компании). Грузится, только когда вкладку открыли: список большой, а нужен
 * не каждый раз.
 */
export function useAllTasks(companyId: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.all(companyId),
    queryFn: () => api<{ items: BallItem[] }>(`/api/v1/ball/all?companyId=${encodeURIComponent(companyId)}`).then((r) => r.items),
    enabled,
  })
}

export type ClosedTab = 'mine' | 'from' | 'all'
const CLOSED_PAGE = 30
const closedUrl = (companyId: string, tab: ClosedTab, project: string | null, limit: number, offset = 0) =>
  `/api/v1/ball/closed?companyId=${encodeURIComponent(companyId)}&tab=${tab}&limit=${limit}&offset=${offset}${project ? `&project=${encodeURIComponent(project)}` : ''}`

/** Сколько закрытых — для свёрнутого блока: число без строк. */
export function useClosedCount(companyId: string, tab: ClosedTab, project: string | null) {
  return useQuery({
    queryKey: keys.closedCount(companyId, tab, project),
    queryFn: () => api<{ total: number }>(closedUrl(companyId, tab, project, 0)).then((r) => r.total),
    staleTime: 60_000,
  })
}

/** Закрытые — порциями, только когда блок раскрыли. */
export function useClosed(companyId: string, tab: ClosedTab, project: string | null, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: keys.closed(companyId, tab, project),
    queryFn: ({ pageParam }) => api<{ items: BallItem[]; total: number }>(closedUrl(companyId, tab, project, CLOSED_PAGE, pageParam)),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0)
      return last.items.length && loaded < last.total ? loaded : undefined
    },
    enabled,
  })
}

export function useTask(id: string | null) {
  return useQuery({
    queryKey: keys.task(id ?? ''),
    queryFn: () => api<TaskFull>(`/api/v1/ball/task/${id}`),
    enabled: Boolean(id),
  })
}

export function useHandoffs(task: TaskFull['task'] | undefined) {
  return useQuery({
    queryKey: keys.handoffs(task?.id ?? ''),
    queryFn: () => api<{ items: Handoff[] } | Handoff[]>(`/api/v1/tasks/${task!.id}/handoffs`, inProject(task!.project!.id)),
    select: (r) => (Array.isArray(r) ? r : r.items),
    enabled: Boolean(task?.project),
  })
}

export function useComments(task: TaskFull['task'] | undefined) {
  return useQuery({
    queryKey: keys.comments(task?.id ?? ''),
    queryFn: () => api<{ items?: Comment[] } | Comment[]>(`/api/v1/tasks/${task!.id}/comments`, inProject(task!.project!.id)),
    select: (r) => (Array.isArray(r) ? r : (r.items ?? [])),
    enabled: Boolean(task?.project),
  })
}

export function useInbox(companyId: string) {
  return useQuery({
    queryKey: keys.inbox(companyId),
    queryFn: () => api<{ unreadTotal: number; items: Notice[] }>(`/api/v1/inbox?limit=50&companyId=${encodeURIComponent(companyId)}`),
  })
}

export function useRunning() {
  return useQuery({
    queryKey: keys.running,
    queryFn: () => api<{ items: TimeRun[] }>('/api/v1/my/time/running').then((r) => r.items[0] ?? null),
  })
}

/** Сколько набежало за сегодня — минуты, без идущего таймера (его клиент досчитывает сам). */
export function useToday() {
  return useQuery({
    queryKey: keys.today,
    queryFn: () => {
      const from = new Date()
      from.setHours(0, 0, 0, 0)
      return api<{ totalMinutes: number }>(`/api/v1/my/time/summary?from=${encodeURIComponent(from.toISOString())}`).then((r) => r.totalMinutes ?? 0)
    },
    staleTime: 60_000,
  })
}

/** Всё, что меняет мяч, перечитывает списки, задачу и колокольчик. */
export function useRefreshBall() {
  const qc = useQueryClient()
  return (taskId?: string) => {
    void qc.invalidateQueries({ queryKey: ['v2', 'ball'] })
    void qc.invalidateQueries({ queryKey: ['v2', 'inbox'] })
    if (taskId) {
      void qc.invalidateQueries({ queryKey: keys.task(taskId) })
      void qc.invalidateQueries({ queryKey: keys.handoffs(taskId) })
    }
  }
}

export type HandoffError =
  | 'note_required'
  | 'target_required'
  | 'closed'
  | 'wrong_move'
  | 'forbidden'
  | 'conflict'
  | 'self'
  | 'not_member'
  | 'no_owner'
  | string

export function useHandoff() {
  const refresh = useRefreshBall()
  return useMutation({
    mutationFn: (v: { taskId: string; projectId: string; action: HandoffAction; to?: string | null; note?: string }) =>
      api(`/api/v1/tasks/${v.taskId}/handoff`, {
        method: 'POST',
        body: JSON.stringify({ action: v.action, to: v.to, note: v.note }),
        ...inProject(v.projectId),
      }),
    onSettled: (_d, _e, v) => refresh(v.taskId),
  })
}

export function errorCode(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { error?: string } | undefined
    return body?.error ?? String(e.status)
  }
  return 'network'
}

/**
 * Сокет на всё приложение: уведомления и перемены задач приходят человеку
 * адресно, где бы он ни был. Подписчики слушают оконное событие — так
 * ассистенту не нужен свой сокет.
 */
export const SOCKET_EVENT = 'chatick:v2-socket'
export type SocketMessage = { event: string; payload: unknown }

export function useUserSocket(enabled: boolean) {
  const qc = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    let ws: WebSocket | null = null
    let closed = false
    let attempt = 0
    let retry: number | undefined
    const connect = () => {
      const token = getSessionToken()
      if (closed || !token) return
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
      ws = new WebSocket(`${API_URL.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`)
      ws.onopen = () => {
        // Пока связи не было, события ушли в никуда — перечитываем.
        if (attempt > 0) void qc.invalidateQueries({ queryKey: ['v2'] })
        attempt = 0
      }
      ws.onmessage = (e) => {
        let msg: SocketMessage
        try {
          msg = JSON.parse(String(e.data)) as SocketMessage
        } catch {
          return
        }
        if (msg.event === 'tasks_changed' || msg.event === 'tasks') {
          void qc.invalidateQueries({ queryKey: ['v2', 'ball'] })
          void qc.invalidateQueries({ queryKey: ['v2', 'task'] })
          void qc.invalidateQueries({ queryKey: ['v2', 'handoffs'] })
        }
        if (msg.event === 'notification') void qc.invalidateQueries({ queryKey: ['v2', 'inbox'] })
        if (msg.event === 'time') {
          void qc.invalidateQueries({ queryKey: keys.running })
          void qc.invalidateQueries({ queryKey: keys.today })
        }
        if (msg.event === 'membership_changed') {
          void qc.invalidateQueries({ queryKey: ['v2', 'projects'] })
          void qc.invalidateQueries({ queryKey: keys.companies })
        }
        window.dispatchEvent(new CustomEvent<SocketMessage>(SOCKET_EVENT, { detail: msg }))
      }
      ws.onclose = () => {
        if (!closed) retry = window.setTimeout(connect, Math.min(1000 * 2 ** attempt++, 15_000))
      }
    }
    connect()
    const wake = () => {
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        attempt = Math.max(attempt, 1)
        connect()
      }
    }
    window.addEventListener('focus', wake)
    window.addEventListener('online', wake)
    return () => {
      closed = true
      if (retry) window.clearTimeout(retry)
      window.removeEventListener('focus', wake)
      window.removeEventListener('online', wake)
      ws?.close()
    }
  }, [enabled, qc])
}
