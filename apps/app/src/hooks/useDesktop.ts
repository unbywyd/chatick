import { useEffect, useState } from 'react'
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
  /** Открыть ссылку в системном браузере (нужно для входа через Google). */
  openExternal: (url: string) => void
  info: () => Promise<{ version: string; platform: string; openAtLogin: boolean }>
  onToggleTimer: (fn: () => void) => () => void
  onNavigate: (fn: (link: string) => void) => () => void
  /** Ответ панели про введённый код подключения. */
  connectResult: (payload: ConnectResult) => void
  onConnectCheck: (fn: (code: string) => void) => () => void
  onConnectApprove: (fn: (p: { code: string; projectId?: string; companyId?: string }) => void) => () => void
  onConnectRefresh: (fn: () => void) => () => void
  onConnectRevoke: (fn: (id: string) => void) => () => void
}

/** Что панель узнаёт о введённом коде: кто просит доступ и чем кончилось. */
type ConnectResult =
  | { step: 'found'; code: string; clientName: string }
  | { step: 'invalid'; code: string }
  | { step: 'approved'; code: string }
  | { step: 'revoked'; code: string }
  | { step: 'failed'; code: string; error: string }

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
   * Компания и роль в ней: доступ ко всей компании выдают только админы и
   * менеджеры, и панель не должна предлагать то, что сервер отклонит.
   */
  company: { id: string; name: string; canGrantCompany: boolean } | null
  /** Действующие туннели ассистентов — их видно и можно закрыть из панели. */
  connections: { id: string; clientName: string; scope: 'company' | 'project'; where: string }[]
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
type TaskLite = {
  id: string
  number: string
  title: string
  status: string
  dueDate?: string | null
  project: { id: string; name: string; color?: string }
}
type BridgeSessionLite = {
  id: string
  clientName: string
  scope: 'company' | 'project'
  project: { id: string; name: string } | null
  company: { id: string; name: string } | null
  lastUsedAt: string
}

/**
 * Отмечает, в каком проекте человек сейчас (SPEC §8.33).
 *
 * Нужно ассистенту с доступом на всю компанию: без этого он либо
 * переспрашивает «в каком проекте?», либо угадывает. Работает и в браузере,
 * и в десктопе — присутствие не имеет отношения к оболочке.
 */
export function usePresence() {
  const location = useLocation()
  const authed = Boolean(getSessionToken())
  const projectId = location.pathname.match(/^\/p\/([^/]+)/)?.[1] ?? null

  useEffect(() => {
    if (!authed) return
    const send = () =>
      api('/api/v1/auth/presence', { method: 'POST', body: JSON.stringify({ projectId }) }).catch(() => {})
    send()
    // Отметка живёт 15 минут — подтверждаем, пока вкладка открыта.
    const timer = setInterval(send, 5 * 60_000)
    return () => clearInterval(timer)
  }, [authed, projectId])
}

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
    queryFn: () =>
      api<{ companies: { id: string; name: string; myRole: 'admin' | 'manager' | 'member' }[] }>('/api/v1/companies'),
  })
  const company = companies.data?.companies[0]
  const companyId = company?.id
  const projects = useQuery({
    queryKey: ['sidebar-projects', companyId],
    enabled: Boolean(bridge) && authed && Boolean(companyId),
    queryFn: () => api<ProjectLite[]>(`/api/v1/projects?companyId=${companyId}`),
    refetchInterval: 60_000,
  })

  // Действующие туннели ассистентов: их видно во вкладке «Доступ», и оттуда же
  // их можно закрыть — доступ от своего имени стоит держать на глазах.
  //
  // Подтверждение кода САМО ПО СЕБЕ сессию не создаёт: она появляется, когда
  // ассистент придёт за токеном. Поэтому сразу после выдачи какое-то время
  // опрашиваем часто — иначе список остаётся пустым, и человек думает, что
  // подключение не сработало.
  const [awaitingTunnel, setAwaitingTunnel] = useState(false)
  const bridgeSessions = useQuery({
    queryKey: ['bridge-sessions'],
    enabled: Boolean(bridge) && authed,
    queryFn: () => api<{ items: BridgeSessionLite[] }>('/api/v1/auth/bridge/sessions'),
    refetchInterval: awaitingTunnel ? 2000 : 60_000,
  })

  // Мои открытые задачи по ВСЕМ проектам: панель отвечает на «что мне делать»,
  // и заставлять сначала зайти в проект — значит не отвечать вовсе.
  const tasks = useQuery({
    queryKey: ['desktop-tasks'],
    enabled: Boolean(bridge) && authed,
    queryFn: () => api<{ items: TaskLite[] }>('/api/v1/inbox/tasks'),
    refetchInterval: 120_000,
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
      // сервер уже отдал только мои и только незакрытые, из всех проектов
      tasks: (authed ? tasks.data?.items ?? [] : []).slice(0, 30).map((t) => ({
        id: t.id,
        number: t.number,
        title: t.title,
        link: `/p/${t.project.id}/tasks/${t.id}`,
        projectName: t.project.name,
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
      company:
        authed && company
          ? {
              id: company.id,
              name: company.name,
              canGrantCompany: company.myRole === 'admin' || company.myRole === 'manager',
            }
          : null,
      connections: (authed ? bridgeSessions.data?.items ?? [] : []).map((x) => ({
        id: x.id,
        clientName: x.clientName,
        scope: x.scope,
        where: (x.scope === 'company' ? x.company?.name : x.project?.name) ?? '',
      })),
      strings: {
        start: t('desktop.start'),
        stop: t('desktop.stop'),
        idle: t('desktop.idle'),
        idleHint: t('desktop.idleHint'),
        idleNoProject: t('desktop.idleNoProject'),
        minShort: t('desktop.minShort'),
        noTask: t('time.noTask'),
        tabInbox: t('desktop.tabInbox'),
        tabTasks: t('desktop.tabTasks'),
        tabProjects: t('desktop.tabProjects'),
        tabConnect: t('desktop.tabConnect'),
        connectHint: t('desktop.connectHint'),
        connectActsAsYou: t('desktop.connectActsAsYou'),
        connectProject: t('desktop.connectProject'),
        connectWhere: t('desktop.connectWhere'),
        connectWholeCompany: t('desktop.connectWholeCompany'),
        connectActive: t('desktop.connectActive'),
        connectRevoke: t('desktop.connectRevoke'),
        connectRevoked: t('desktop.connectRevoked'),
        connectAllow: t('desktop.connectAllow'),
        connectCancel: t('desktop.connectCancel'),
        connectBadCode: t('desktop.connectBadCode'),
        connectDone: t('desktop.connectDone'),
        connectFailed: t('desktop.connectFailed'),
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
  }, [bridge, authed, inbox.data, running.data?.items, projects.data, tasks.data, bridgeSessions.data, company, activeProjectId, t, i18n])

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

      // Запускать «куда-нибудь» нельзя: project-токен остаётся от последнего
      // открытого проекта, и часы молча ушли бы не туда. Нет открытого
      // проекта — показываем окно, пусть человек выберет сам.
      if (!current && !activeProjectId) {
        bridge.show()
        return
      }

      try {
        if (current) {
          await api(`/api/v1/time/${current.id}/stop`, { method: 'POST' }, 'project')
        } else {
          // projectId передаём явно — по той же причине, что и в веб-контроле
          await api('/api/v1/time/start', { method: 'POST', body: JSON.stringify({ projectId: activeProjectId }) }, 'project')
        }
      } catch {
        // нет прав или проект недоступен — окно откроется, человек разберётся
        bridge.show()
      }
      qc.invalidateQueries({ queryKey: ['desktop-running'] })
      qc.invalidateQueries({ queryKey: ['time-running'] })
      qc.invalidateQueries({ queryKey: ['time-entries'] })
    })

    // --- подключение ассистента из панели ------------------------------------
    // Панель показывает поле для кода, но проверять и подтверждать может
    // только веб: у него сессия и права. Туда же уходит выбор проекта —
    // туннель открывается в конкретный проект, а не «в аккаунт».
    const offCheck = bridge.onConnectCheck(async (code) => {
      try {
        const r = await api<{ clientName: string }>(`/api/v1/auth/bridge/code/${encodeURIComponent(code)}`)
        bridge.connectResult({ step: 'found', code, clientName: r.clientName })
      } catch {
        bridge.connectResult({ step: 'invalid', code })
      }
    })

    const offApprove = bridge.onConnectApprove(async ({ code, projectId, companyId: cid }) => {
      try {
        // Либо проект, либо вся компания — сервер сам проверит роль.
        const target = cid ? { companyId: cid } : { projectId }
        await api('/api/v1/auth/bridge/approve', { method: 'POST', body: JSON.stringify({ code, ...target }) })
        bridge.connectResult({ step: 'approved', code })
        qc.invalidateQueries({ queryKey: ['bridge-sessions'] })
        // ассистент может прийти за токеном не мгновенно
        setAwaitingTunnel(true)
        setTimeout(() => setAwaitingTunnel(false), 60_000)
      } catch (e) {
        bridge.connectResult({ step: 'failed', code, error: e instanceof Error ? e.message : String(e) })
      }
    })

    // Вкладку открыли — обновляем немедленно: минутный опрос показывал бы
    // вчерашнюю картину как раз тогда, когда на неё смотрят.
    const offRefresh = bridge.onConnectRefresh(() => {
      qc.invalidateQueries({ queryKey: ['bridge-sessions'] })
    })

    // Закрыть туннель прямо из панели: если ассистент больше не нужен,
    // идти за этим в настройки — лишний шаг.
    const offRevoke = bridge.onConnectRevoke(async (id) => {
      try {
        await api(`/api/v1/auth/bridge/sessions/${id}`, { method: 'DELETE' })
        bridge.connectResult({ step: 'revoked', code: '' })
      } catch (e) {
        bridge.connectResult({ step: 'failed', code: '', error: e instanceof Error ? e.message : String(e) })
      }
      qc.invalidateQueries({ queryKey: ['bridge-sessions'] })
    })

    return () => {
      offNav()
      offTimer()
      offCheck()
      offApprove()
      offRefresh()
      offRevoke()
    }
  }, [bridge, navigate, qc, running.data?.items, activeProjectId])
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
