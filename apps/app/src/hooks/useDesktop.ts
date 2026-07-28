import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, API_URL, getSessionToken, setProjectToken } from '@/lib/api'

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
  onToggleTimer: (fn: (projectId?: string | null) => void) => () => void
  onNavigate: (fn: (p: string | { link: string; notificationId?: string | null }) => void) => () => void
  /** Ответ панели про введённый код подключения. */
  connectResult: (payload: ConnectResult) => void
  onConnectCheck: (fn: (code: string) => void) => () => void
  onConnectApprove: (fn: (p: { code: string; projectId?: string; companyId?: string }) => void) => () => void
  onSetProject: (fn: (id: string) => void) => () => void
  onTaskStatus: (fn: (p: { taskId: string; status: string }) => void) => () => void
  onTaskTimer: (fn: (taskId: string) => void) => () => void
  onStateRefresh: (fn: () => void) => () => void
  onConnectRefresh: (fn: () => void) => () => void
  onOpenAbout: (fn: () => void) => () => void
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
  timer: { id: string; description: string; startedAt: string; projectId: string; projectName?: string; taskId?: string | null } | null
  notifications: { id: string; title: string; summary?: string | null; link: string; projectId: string; projectName?: string; unread: boolean }[]
  tasks: { id: string; number: string; title: string; status: string; link: string; projectId: string; projectName?: string; due?: string }[]
  projects: { id: string; name: string; companyId?: string; color?: string; logoUrl?: string | null; unread: number }[]
  project: { id: string; name: string } | null
  /**
   * Компания и роль в ней: доступ ко всей компании выдают только админы и
   * менеджеры, и панель не должна предлагать то, что сервер отклонит.
   */
  company: { id: string; name: string; canGrantCompany: boolean } | null
  /** все компании человека: подключаться можно к любой, не только к первой */
  companies: { id: string; name: string; canGrantCompany: boolean }[]
  /** Действующие туннели ассистентов — их видно и можно закрыть из панели. */
  connections: { id: string; clientName: string; scope: 'company' | 'project' | 'all'; where: string }[]
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
type Running = {
  items: { id: string; description: string; startedAt: string; projectId: string; task?: { id: string } | null }[]
}
type ProjectLite = {
  id: string
  name: string
  companyId?: string
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
  scope: 'company' | 'project' | 'all'
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
  // Признак входа пересчитывается, а не берётся один раз при монтировании:
  // окно приложения открывается раньше, чем человек вошёл, и запросы к трею
  // не включались бы уже никогда — панель оставалась пустой.
  const [authed, setAuthed] = useState(() => Boolean(getSessionToken()))
  // Счётчик-повод переслать состояние в трей. Панель просит его сама, когда
  // открылась и не увидела надписей.
  const [stateNonce, setStateNonce] = useState(0)
  // Последний непустой список проектов: показываем его, пока грузится новый.
  const lastProjects = useRef<ProjectLite[]>([])
  // Обработчики из трея живут дольше, чем данные, на которых их создали:
  // эффект пересоздаётся при смене проекта, и между переходом и приходом
  // новых данных нажатие читало устаревшее замыкание — «плей» отвечал
  // «таймер уже идёт», а «стоп» промахивался мимо записи.
  const liveRef = useRef<{ timer?: Running['items'][0]; projectId?: string; tasks?: TaskLite[] }>({})
  useEffect(() => {
    const check = () => setAuthed(Boolean(getSessionToken()))
    const timer = window.setInterval(check, 2000)
    window.addEventListener('storage', check)
    window.addEventListener('focus', check)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('storage', check)
      window.removeEventListener('focus', check)
    }
  }, [])

  // Активный проект — из адреса: /p/<id>/...
  const activeProjectId = location.pathname.match(/^\/p\/([^/]+)/)?.[1]

  // Непрочитанные — то же, что показывает колокольчик: только адресованное мне.
  const inbox = useQuery({
    queryKey: ['inbox'],
    enabled: Boolean(bridge) && authed,
    queryFn: () => api<Inbox>('/api/v1/inbox?onlyUnread=1&limit=50'),
    // Только для трея и бейджа: показ уведомлений идёт по сокету, мгновенно.
    refetchInterval: 60_000,
  })

  const running = useQuery({
    queryKey: ['desktop-running'],
    enabled: Boolean(bridge) && authed,
    // По сессии, а не по project-токену: часы идут у человека, а не у окна.
    // Со старым запросом панель не знала о таймере, пока не открыт проект —
    // показывала «не запущен» и не давала остановить идущий.
    queryFn: () => api<Running>('/api/v1/my/time/running'),
    refetchInterval: 30_000,
  })

  // Проекты нужны панели и для списка, и чтобы подписать, где что произошло.
  const companies = useQuery({
    queryKey: ['companies'],
    enabled: Boolean(bridge) && authed,
    queryFn: () =>
      api<{ companies: { id: string; name: string; myRole: 'admin' | 'manager' | 'member' }[] }>('/api/v1/companies'),
  })
  const myCompanies = companies.data?.companies ?? []
  const company = myCompanies[0]
  const companyIds = myCompanies.map((c) => c.id)

  // Проекты СО ВСЕХ компаний: человек может состоять в нескольких — своей и
  // тех, куда его позвали. Брать проекты только первой значило, что половину
  // его работы панель просто не показывает, а подключить к ним ассистента
  // нельзя вовсе.
  const projects = useQuery({
    queryKey: ['tray-projects', companyIds.join(',')],
    enabled: Boolean(bridge) && authed && companyIds.length > 0,
    queryFn: async () => {
      const lists = await Promise.all(
        companyIds.map((id) =>
          api<ProjectLite[]>(`/api/v1/projects?companyId=${id}`).catch(() => [] as ProjectLite[]),
        ),
      )
      return lists.flat()
    },
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
    // Пока запрос перезагружается, data пуст — и панель рисовала «Проектов
    // пока нет» вместо списка, который был секунду назад. Особенно заметно
    // при смене проекта из панели: она вызывает переход, компоненты
    // перемонтируются, и список исчезал на ровном месте.
    const projectList = authed ? (projects.data ?? lastProjects.current).filter((p) => p.isMember) : []
    if (projects.data) lastProjects.current = projects.data
    const nameOf = (id: string) => projectList.find((p) => p.id === id)?.name
    const timer = authed ? running.data?.items[0] : undefined
    liveRef.current = { timer, projectId: activeProjectId, tasks: tasks.data?.items }

    bridge.setState({
      authed,
      unread: authed ? inbox.data?.unreadTotal ?? 0 : 0,
      timer: timer
        ? {
            id: timer.id,
            description: timer.description,
            startedAt: timer.startedAt,
            // Панели нужен id: по нему она блокирует выбор проекта на бегущем
            // таймере и оставляет его выбранным после паузы.
            projectId: timer.projectId,
            projectName: nameOf(timer.projectId),
            taskId: timer.task?.id ?? null,
          }
        : null,
      notifications: (authed ? inbox.data?.items ?? [] : []).slice(0, 20).map((n) => ({
        id: n.id,
        title: n.title,
        summary: n.summary,
        link: n.link,
        projectId: n.projectId,
        projectName: nameOf(n.projectId),
        unread: !n.readAt,
      })),
      // сервер уже отдал только мои и только незакрытые, из всех проектов
      tasks: (authed ? tasks.data?.items ?? [] : []).slice(0, 30).map((t) => ({
        id: t.id,
        number: t.number,
        title: t.title,
        status: t.status,
        link: `/p/${t.project.id}/tasks/${t.id}`,
        projectId: t.project.id,
        projectName: t.project.name,
        due: t.dueDate ? new Date(t.dueDate).toLocaleDateString() : undefined,
      })),
      projects: projectList.map((p) => ({
        id: p.id,
        name: p.name,
        companyId: p.companyId,
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
              // Подключиться к своей компании может любой её участник: туннель
              // открывает только те проекты, где человек состоит, и с его же
              // правами — больше своего он ассистенту не выдаст.
              canGrantCompany: true,
            }
          : null,
      companies: authed
        ? myCompanies.map((c) => ({
            id: c.id,
            name: c.name,
            canGrantCompany: true,
          }))
        : [],
      connections: (authed ? bridgeSessions.data?.items ?? [] : []).map((x) => ({
        id: x.id,
        clientName: x.clientName,
        scope: x.scope,
        where: (x.scope === 'all' ? t('connect.allProjects') : x.scope === 'company' ? x.company?.name : x.project?.name) ?? '',
      })),
      strings: {
        start: t('desktop.start'),
        stop: t('desktop.stop'),
        idle: t('desktop.idle'),
        idleNoProject: t('desktop.idleNoProject'),
        minShort: t('desktop.minShort'),
        noTask: t('time.noTask'),
        tabInbox: t('desktop.tabInbox'),
        tabTasks: t('desktop.tabTasks'),
        tabProjects: t('desktop.tabProjects'),
        tabConnect: t('desktop.tabConnect'),
        projectOpen: t('desktop.projectOpen'),
        projectHere: t('desktop.projectHere'),
        taskSetStatus: t('desktop.taskSetStatus'),
        statusTodo: t('tasks.status.todo'),
        statusInProgress: t('tasks.status.in_progress'),
        statusReview: t('tasks.status.review'),
        statusDone: t('tasks.status.done'),
        connectHint: t('desktop.connectHint'),
        // строка-приглашение для ассистента — та же, что на вкладке «Подключение»
        inviteLine: `${t('connect.pastePrefix')} ${API_URL.replace(/\/$/, '')}/x`,
        connectInviteHint: t('connect.pastePrefix'),
        connectCopy: t('connect.copy'),
        connectCopied: t('connect.copied'),
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
        emptyProjects: t('desktop.emptyProjects'),
        openApp: t('desktop.openApp'),
        close: t('desktop.close'),
        unreadOne: t('desktop.unread'),
        allRead: t('desktop.allRead'),
        due: t('desktop.due'),
        launchAtLogin: t('desktop.launchAtLogin'),
        reload: t('desktop.reload'),
        notifySettings: t('notif.system'),
        connectGroupCompanies: t('connect.groupCompanies'),
        connectGroupProjects: t('connect.groupProjects'),
        connectAllProjectsOf: t('connect.allProjectsOf'),
        connectSearch: t('connect.search'),
        pickProject: t('desktop.pickProject'),
        updateReady: t('desktop.updateReady'),
        quit: t('desktop.quit'),
        timerRunning: t('desktop.timerRunning'),
        signIn: t('desktop.signIn'),
        signedOut: t('desktop.signedOut'),
        signedOutHint: t('desktop.signedOutHint'),
        // на иврите панель должна разворачиваться, как и всё приложение
        dir: i18n.dir(),
      },
    })
  }, [bridge, authed, inbox.data, running.data?.items, projects.data, tasks.data, bridgeSessions.data, company, activeProjectId, t, i18n, stateNonce])

  // Системные уведомления показывает useSystemNotifications — общий хук для
  // веба и десктопа. Раньше это жило здесь и работало только в Electron.

  // --- команды из главного процесса -----------------------------------------
  useEffect(() => {
    if (!bridge) return
    const offNav = bridge.onNavigate((payload) => {
      // Панель присылает объект; строка — от старых вызовов (переход в проект).
      const link = typeof payload === 'string' ? payload : payload?.link
      const notificationId = typeof payload === 'string' ? null : payload?.notificationId
      if (!link) return
      navigate(link)

      // Клик из панели — это прочтение: уведомление привело человека на место,
      // и висеть непрочитанным ему больше незачем. id приходит от панели: по
      // ссылке уведомления не различить, несколько ведут в одно место.
      if (!notificationId) return
      api('/api/v1/inbox/read', { method: 'POST', body: JSON.stringify({ ids: [notificationId] }) })
        .then(() => {
          qc.invalidateQueries({ queryKey: ['inbox'] })
          qc.invalidateQueries({ queryKey: ['sidebar-projects'] })
        })
        .catch(() => {})
    })
    // Токен того проекта, в котором собираемся работать. В localStorage лежит
    // токен последнего открытого — с ним запрос в другой проект падает, а
    // человек видит лишь неподвижную кнопку.
    const enterProject = async (projectId: string) => {
      const { token } = await api<{ token: string }>(
        `/api/v1/projects/${projectId}/enter`,
        { method: 'POST', body: JSON.stringify({ acceptRules: true }) },
      )
      setProjectToken(token)
    }

    const offTimer = bridge.onToggleTimer(async (panelProjectId) => {
      // Из ref, а не из замыкания: на момент нажатия данные могли смениться.
      const current = liveRef.current.timer

      // Проект, в котором работаем: для остановки — тот, где идёт таймер;
      // для запуска — выбранный в панели (дропдаун в шапке), и лишь как
      // запасной вариант — открытый в окне.
      const target = current?.projectId ?? panelProjectId ?? liveRef.current.projectId
      if (!target) {
        // Запускать «куда-нибудь» нельзя: часы молча ушли бы не туда.
        bridge.show()
        toast.info(t('desktop.pickProjectForTimer'))
        return
      }

      try {
        // Токен нужного проекта, а не тот, что лежит с прошлого раза. Без
        // этого «плей» и «стоп» молча не срабатывали: запрос уходил с чужим
        // токеном и падал, а человек видел лишь неподвижную кнопку.
        await enterProject(target)

        if (current) {
          await api(`/api/v1/time/${current.id}/stop`, { method: 'POST' }, 'project')
        } else {
          // projectId передаём явно — по той же причине, что и в веб-контроле
          await api('/api/v1/time/start', { method: 'POST', body: JSON.stringify({ projectId: target }) }, 'project')
        }
      } catch (e) {
        // Молчаливый отказ — худшее, что здесь может быть: кнопка выглядит
        // нажатой, а не происходит ничего. Говорим, что пошло не так.
        toast.error(e instanceof Error ? e.message : String(e))
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

    // Таймер прямо на задаче: перебивает текущий, потому что работают над
    // чем-то одним, а два счётчика на одного человека — это уже путаница.
    const offTaskTimer = bridge.onTaskTimer(async (taskId) => {
      // Из ref: список задач и текущий таймер к моменту нажатия могли смениться.
      const task = liveRef.current.tasks?.find((x) => x.id === taskId)
      if (!task) return
      const current = liveRef.current.timer
      try {
        // Остановить надо в том проекте, где часы идут, а запустить — в том,
        // которому принадлежит задача. Это разные проекты, и токен нужен свой.
        if (current) {
          await enterProject(current.projectId)
          await api(`/api/v1/time/${current.id}/stop`, { method: 'POST' }, 'project')
        }
        // Уже шёл таймер именно по этой задаче — значит нажатие было «стоп».
        if (current?.task?.id !== taskId) {
          await enterProject(task.project.id)
          await api(
            '/api/v1/time/start',
            { method: 'POST', body: JSON.stringify({ projectId: task.project.id, taskId, description: task.title }) },
            'project',
          )
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
        bridge.show()
      }
      qc.invalidateQueries({ queryKey: ['desktop-running'] })
      qc.invalidateQueries({ queryKey: ['time-running'] })
      qc.invalidateQueries({ queryKey: ['time-entries'] })
    })

    // Статус задачи меняют прямо из панели: ради «взял в работу» открывать
    // приложение и искать задачу — лишняя дорога.
    const offTaskStatus = bridge.onTaskStatus(async ({ taskId, status }) => {
      try {
        await api(`/api/v1/inbox/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ status }) })
      } catch {
        bridge.show()
      }
      qc.invalidateQueries({ queryKey: ['desktop-tasks'] })
      qc.invalidateQueries({ queryKey: ['tasks'] })
    })

    // Проект выбрали из панели: переходим в него, но окно не поднимаем —
    // человек остался в панели намеренно.
    const offSetProject = bridge.onSetProject((id) => {
      if (id) navigate(`/p/${id}/chat`)
    })

    // «О проекте» из трея: окно уже поднято главным процессом, здесь только
    // открываем диалог — адресом, чтобы это работало из любого места.
    const offAbout = bridge.onOpenAbout(() => {
      const url = new URL(window.location.href)
      url.hash = `${window.location.hash.split('?')[0]}?about=1`
      window.location.href = url.toString()
    })

    // Вкладку открыли — обновляем немедленно: минутный опрос показывал бы
    // вчерашнюю картину как раз тогда, когда на неё смотрят.
    const offRefresh = bridge.onConnectRefresh(() => {
      qc.invalidateQueries({ queryKey: ['bridge-sessions'] })
    })
    // Панель открылась и не увидела состояния — шлём заново. Иначе первое
    // открытие трея после запуска показывает пустоту, и только второе работает.
    const offStateRefresh = bridge.onStateRefresh(() => {
      // Панель открыли — значит на неё смотрят прямо сейчас. Пересылать старое
      // состояние мало: таймер мог запуститься минуту назад, а опрос идёт раз
      // в полминуты. Перезапрашиваем то, что панель показывает.
      qc.invalidateQueries({ queryKey: ['desktop-running'] })
      qc.invalidateQueries({ queryKey: ['inbox'] })
      setStateNonce((n) => n + 1)
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
      offSetProject()
      offTaskStatus()
      offTaskTimer()
      offRefresh()
      offStateRefresh()
      offAbout()
      offRevoke()
    }
    // Данных таймера в зависимостях нет намеренно: обработчики читают их из
    // liveRef. Иначе каждая смена проекта снимала и вешала подписки заново, и
    // нажатие в этот момент уходило в никуда.
  }, [bridge, navigate, qc])
}
