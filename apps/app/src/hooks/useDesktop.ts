import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueries, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, API_URL, getSessionToken, logout, type Me } from '@/lib/api'
import { activeFromLocation, toV2Link } from '@/lib/v2-links'
import { useTheme } from '@/providers/theme'
import { keys, type BallItem, type Notice } from '@/v2/data'
import { dueDiff, dueText, heatOf, letterOf, moveKey, personColor, projectColor, shortProject, timeAgo, waitText } from '@/v2/util'
// Подписи панели — из пространства v2: ходы, «от кого», «вся компания».
import '@/v2/i18n'
import '@/v2/i18n/tray'

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
  onNavigate: (
    fn: (p: string | { link: string; notificationId?: string | null; projectId?: string | null }) => void,
  ) => () => void
  /** Ответ панели про введённый код подключения. */
  connectResult: (payload: ConnectResult) => void
  onConnectCheck: (fn: (code: string) => void) => () => void
  onConnectApprove: (
    fn: (p: { code: string; projectId?: string; companyId?: string; all?: boolean }) => void,
  ) => () => void
  onSetProject: (fn: (id: string) => void) => () => void
  onTaskStatus: (fn: (p: { taskId: string; status: string }) => void) => () => void
  onTaskTimer: (fn: (taskId: string) => void) => () => void
  /**
   * Необязательный: preload.cjs живёт ВНУТРИ установленного приложения, а веб
   * обновляется отдельно. У того, кто не переустанавливал, метода нет — и
   * прямой вызов ронял весь useDesktop, оставляя чёрный экран и пустую панель.
   * Веб не имеет права требовать свежую оболочку.
   */
  onTimerElapsed?: (fn: (p: { id: string; seconds: number }) => void) => () => void
  onStateRefresh: (fn: () => void) => () => void
  onConnectRefresh: (fn: () => void) => () => void
  /**
   * Ассистент просит одобрить свой код через установленное приложение —
   * человеку не надо переписывать код из чата. Токен здесь не участвует:
   * ассистент забирает его у сервера сам, как в обычном device flow.
   */
  onGrantRequest?: (fn: (p: { id: string; client: string; code: string }) => void) => () => void
  grantResult?: (payload: { id: string; approved: boolean }) => void
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
  /**
   * Идущий таймер. projectId = null — время на компанию без проекта (v2);
   * тогда companyId говорит, на какую.
   */
  timer: {
    id: string
    description: string
    startedAt: string
    projectId: string | null
    projectName?: string
    taskId?: string | null
    companyId?: string | null
    taskNumber?: string | null
  } | null
  /**
   * Уведомления. Поля после unread — для панели v2; старая панель их не
   * знает и не ломается. Их нельзя выносить в новые поля верхнего уровня:
   * установленная оболочка пересобирает состояние по списку полей
   * (main.cjs, state:update) и всё незнакомое выбрасывает. Внутри массивов
   * и объектов она ничего не трогает — туда и кладём.
   */
  notifications: {
    id: string
    title: string
    summary?: string | null
    link: string
    projectId: string | null
    projectName?: string
    unread: boolean
    companyId?: string | null
    /** Кто сделал — жирным в начале строки; text — заголовок без его имени. */
    who?: string
    text?: string
    /** Записка к передаче или выжимка — цитатой под строкой. */
    note?: string | null
    when?: string
    color?: string
    letter?: string
  }[]
  /**
   * Задачи, где мяч у меня (v2, /ball/mine по всем компаниям). Подписи
   * посчитаны здесь: склонения и даты живут в i18n веба, а у панели его нет.
   */
  tasks: {
    id: string
    number: string
    title: string
    status: string
    link: string
    projectId: string
    projectName?: string
    due?: string
    companyId?: string
    move?: string
    moveLabel?: string
    round?: string
    from?: string
    wait?: string
    long?: boolean
    late?: boolean
    soon?: boolean
    isNew?: boolean
    /**
     * Кнопка в строке по правилам мяча: держатель, но не владелец — «На
     * проверку» (status review); владелец или проверяющий — «Принять» /
     * «Готово» (status done). null — без записки нельзя (ответить, клиент).
     */
    action?: { status: 'review' | 'done'; label: string } | null
  }[]
  projects: { id: string; name: string; short?: string; companyId?: string; color?: string; logoUrl?: string | null; letter?: string; unread: number }[]
  project: { id: string; name: string } | null
  /**
   * Компания, открытая в окне (а если окно не в компании — первая). Роль в
   * ней: доступ ко всей компании выдают только админы и менеджеры, и панель
   * не должна предлагать то, что сервер отклонит.
   */
  company: { id: string; name: string; canGrantCompany: boolean } | null
  /** все компании человека: подключаться можно к любой, не только к первой */
  companies: {
    id: string
    name: string
    canGrantCompany: boolean
    mainProjectId?: string | null
    logoUrl?: string | null
    letter?: string
    /** «5 задач» — подпись в списке компаний панели. */
    meta?: string
    unread?: number
    /** Проект, выбранный для таймера в этой компании (тот же, что в шапке v2). */
    timerProjectId?: string | null
  }[]
  /** Кто вошёл: аватар в шапке панели отвечает на «от чьего имени всё это». */
  user: { name: string; email: string; avatarUrl: string | null; todayMinutes?: number | null } | null
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
/**
 * Идущая запись — как её отдаёт /my/time/running. Ключ общий с шапкой v2
 * (keys.running) и данные те же: первая запись или null. Свой тип, а не
 * TimeRun из v2, только ради полей, которые там не описаны (компания, задача).
 */
type RunningItem = {
  id: string
  description?: string
  startedAt: string
  projectId: string | null
  projectName?: string
  companyId?: string | null
  task?: { id: string; number?: string; title?: string } | null
}
type BallMine = { table: BallItem[]; items: BallItem[] }
type CompanyInbox = { unreadTotal: number; items: Notice[] }

/** Где хранится выбранный для таймера проект — тот же ключ, что у шапки v2. */
const timerChoiceKey = (companyId: string) => `chatick_v2_timer_${companyId}`
const readTimerChoice = (companyId: string): string | null => {
  try {
    return localStorage.getItem(timerChoiceKey(companyId))
  } catch {
    return null
  }
}
const saveTimerChoice = (companyId: string, projectId: string | null) => {
  try {
    if (projectId) localStorage.setItem(timerChoiceKey(companyId), projectId)
    else localStorage.removeItem(timerChoiceKey(companyId))
  } catch {
    // хранилище недоступно — выбор просто не запомнится
  }
}

/**
 * Склейка ответов по компаниям. Функция — на уровне модуля, а не в теле
 * хука: useQueries пересчитывает combine заново, только если сменилась
 * ссылка на неё или чей-то ответ. Стрелка в теле давала бы новый массив на
 * каждую отрисовку — и состояние летело бы в трей без всякого повода.
 */
const mineData = (rs: UseQueryResult<BallMine>[]) => rs.map((r) => r.data)
const inboxData = (rs: UseQueryResult<CompanyInbox>[]) => rs.map((r) => r.data)
type ProjectLite = {
  id: string
  name: string
  companyId?: string
  color?: string
  logoUrl?: string | null
  isMember: boolean
  stats?: { unread: number }
}
type BridgeSessionLite = {
  id: string
  clientName: string
  scope: 'company' | 'project' | 'all'
  project: { id: string; name: string } | null
  company: { id: string; name: string } | null
  lastUsedAt: string
}
type CompanyLite = { id: string; name: string; logoUrl?: string | null; myRole: 'admin' | 'manager' | 'member'; mainProjectId?: string | null }
/** Задача «на мне» вместе с компанией: компания известна из запроса, в ответе её нет. */
type TrayTask = BallItem & { companyId: string }
type TrayNotice = Notice & { companyId: string }
/** Куда пойдёт время: проект или компания целиком (v2). */
type TimerTarget = { companyId: string | null; projectId: string | null }

/**
 * Отмечает, в каком проекте человек сейчас (SPEC §8.33).
 *
 * Нужно ассистенту с доступом на всю компанию: без этого он либо
 * переспрашивает «в каком проекте?», либо угадывает. Работает и в браузере,
 * и в десктопе — присутствие не имеет отношения к оболочке.
 *
 * Проект — из адреса: в v2 это фильтр ?p=, на старых экранах /c/…/p/<id>.
 * Раньше искали /p/<id> в начале адреса, а такого адреса нет с тех пор, как
 * в него попала компания, — ассистент всегда видел «нигде».
 */
export function usePresence() {
  const location = useLocation()
  const authed = Boolean(getSessionToken())
  const projectId = activeFromLocation(location.pathname, location.search).projectId

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
  const { t: tv } = useTranslation('v2')
  const { resolved: theme } = useTheme()
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
  const liveRef = useRef<{
    timer?: RunningItem | null
    /** компания, открытая в окне (или первая) */
    companyId?: string | null
    tasks?: TrayTask[]
    /** проекты с их компаниями: адрес перехода из панели без компании не собрать */
    projects?: ProjectLite[]
    companies?: CompanyLite[]
    notifications?: TrayNotice[]
  }>({})
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

  // Где сейчас окно (l10). В v2 проект — фильтр ?p= на экране компании,
  // задача — панель ?t=; старое /c/<co>/p/<id> тоже понимаем.
  const here = activeFromLocation(location.pathname, location.search)
  const on = Boolean(bridge) && authed

  // Кто вошёл — для аватарки в шапке панели. Ключ общий с приложением.
  const me = useQuery({
    queryKey: ['me'],
    enabled: on,
    queryFn: () => api<Me>('/api/v1/auth/me'),
    staleTime: 5 * 60_000,
    // Свой опрос, как у остальных запросов панели. Без него единственная
    // неудачная попытка (перезапуск API, спящая сеть) оставляла шапку без
    // имени и с вопросительным знаком вместо аватарки — до перезапуска
    // программы, потому что повторить её было уже нечему.
    refetchInterval: 5 * 60_000,
  })

  // Непрочитанные по всем компаниям — бейдж на значке и в панели задач.
  const inbox = useQuery({
    queryKey: ['inbox'],
    enabled: on,
    queryFn: () => api<Inbox>('/api/v1/inbox?onlyUnread=1&limit=50'),
    // Только для трея и бейджа: показ уведомлений идёт по сокету, мгновенно.
    refetchInterval: 60_000,
  })

  // Таймер — тем же ключом и тем же запросом, что шапка v2 (useRunning):
  // остановил там — панель узнала сразу, и наоборот. По сессии, а не по
  // проекту: часы идут у человека, а не у окна.
  const running = useQuery({
    queryKey: keys.running,
    enabled: on,
    queryFn: () => api<{ items: RunningItem[] }>('/api/v1/my/time/running').then((r) => r.items[0] ?? null),
    refetchInterval: 30_000,
  })

  // «Сегодня 4:54» под таймером. Ключ и запрос — как у шапки v2 (useToday):
  // минуты без идущего таймера, его панель досчитывает сама.
  const today = useQuery({
    queryKey: keys.today,
    enabled: on,
    queryFn: () => {
      const from = new Date()
      from.setHours(0, 0, 0, 0)
      return api<{ totalMinutes: number }>(`/api/v1/my/time/summary?from=${encodeURIComponent(from.toISOString())}`).then(
        (r) => r.totalMinutes ?? 0,
      )
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  })

  // Проекты нужны панели и для списка, и чтобы подписать, где что произошло.
  const companies = useQuery({
    queryKey: ['companies'],
    enabled: on,
    queryFn: () => api<{ companies: CompanyLite[] }>('/api/v1/companies'),
    // Этот опрос — единственное, что оживляет панель после падения запроса:
    // проверено на самой библиотеке. Упавший запрос оставляет data пустым, из
    // пустого списка компаний собирается пустой ключ, а он ВЫКЛЮЧАЕТ запрос
    // проектов (enabled ниже) вместе с его собственным опросом. Без строки
    // ниже чинить панель нечему — она пуста до перезапуска программы.
    refetchInterval: 60_000,
  })
  const myCompanies = companies.data?.companies ?? []
  const companyIds = myCompanies.map((c) => c.id)

  // Проекты СО ВСЕХ компаний: человек может состоять в нескольких — своей и
  // тех, куда его позвали. Брать проекты только первой значило, что половину
  // его работы панель просто не показывает, а подключить к ним ассистента
  // нельзя вовсе.
  const projects = useQuery({
    queryKey: ['tray-projects', companyIds.join(',')],
    enabled: on && companyIds.length > 0,
    queryFn: async () => {
      const lists = await Promise.all(
        companyIds.map((id) =>
          api<ProjectLite[]>(`/api/v1/projects?companyId=${id}`)
            // Компания известна из самого запроса: сервер её в ответе не
            // возвращает, а панели она нужна — без неё проекты из разных
            // компаний не подписать, особенно когда компании одноимённые.
            .then((list) => list.map((p) => ({ ...p, companyId: id })))
            .catch(() => [] as ProjectLite[]),
        ),
      )
      return lists.flat()
    },
    refetchInterval: 60_000,
  })

  // Задачи, где мяч у меня, — по каждой компании (v2). Ключ и запрос те же,
  // что у списка «На мне»: любое движение мяча в приложении (и по сокету)
  // освежает и панель, без своего опроса вдогонку.
  const mine = useQueries({
    queries: companyIds.map((id) => ({
      queryKey: keys.mine(id),
      queryFn: () => api<BallMine>(`/api/v1/ball/mine?companyId=${encodeURIComponent(id)}`),
      enabled: on,
      refetchInterval: 120_000,
    })),
    combine: mineData,
  })

  // Лента компании — как у колокольчика v2 (useInbox), тем же ключом:
  // прочитал там — панель погасила сразу (n09).
  const inboxes = useQueries({
    queries: companyIds.map((id) => ({
      queryKey: keys.inbox(id),
      queryFn: () => api<CompanyInbox>(`/api/v1/inbox?limit=50&companyId=${encodeURIComponent(id)}`),
      enabled: on,
      refetchInterval: 60_000,
    })),
    combine: inboxData,
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
    enabled: on,
    queryFn: () => api<{ items: BridgeSessionLite[] }>('/api/v1/auth/bridge/sessions'),
    refetchInterval: awaitingTunnel ? 2000 : 60_000,
  })

  /**
   * Прочитанное — одно на оба клиента (n09).
   *
   * Колокольчик v2 сбрасывает ['v2','inbox',…], старые экраны и переходы из
   * трея — ['inbox']. Каждый трогал только своё, и бейдж в трее отставал от
   * прочитанного в приложении до минуты, а лента v2 — от прочитанного в трее.
   *
   * Мост в обе стороны. Флаг не даёт семьям гонять друг друга по кругу:
   * оповещения кеша приходят синхронно, прямо внутри invalidateQueries. И
   * пересылаем, только пока другая семья ещё свежая: на пять компаний пять
   * пересылок дали бы пять одинаковых запросов.
   */
  useEffect(() => {
    if (!bridge) return
    let relaying = false
    const cache = qc.getQueryCache()
    return cache.subscribe((event) => {
      if (relaying || event.type !== 'updated' || event.action?.type !== 'invalidate') return
      const [a, b] = event.query.queryKey as unknown[]
      const other = a === 'inbox' ? ['v2', 'inbox'] : a === 'v2' && b === 'inbox' ? ['inbox'] : null
      if (!other || !cache.findAll({ queryKey: other }).some((q) => !q.state.isInvalidated)) return
      relaying = true
      try {
        void qc.invalidateQueries({ queryKey: other })
      } finally {
        relaying = false
      }
    })
  }, [bridge, qc])

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
    const projectBy = new Map(projectList.map((p) => [p.id, p]))
    const nameOf = (id: string | null | undefined) => (id ? projectBy.get(id)?.name : undefined)
    const companyOf = (id: string | null | undefined) => (id ? projectBy.get(id)?.companyId : undefined)
    const companyList = authed ? myCompanies : []
    // Компания окна; окно не в компании (вход, список компаний) — первая.
    const activeCompany = companyList.find((c) => c.id === here.companyId) ?? companyList[0]
    const run = authed ? (running.data ?? null) : null
    const myId = me.data?.id
    const lng = i18n.resolvedLanguage ?? i18n.language

    const ball: TrayTask[] = authed
      ? companyIds.flatMap((cid, i) => {
          const d = mine[i]
          return d ? [...d.table, ...d.items].map((x) => ({ ...x, companyId: cid })) : []
        })
      : []
    const notices: TrayNotice[] = authed
      ? companyIds.flatMap((cid, i) => (inboxes[i]?.items ?? []).slice(0, 30).map((n) => ({ ...n, companyId: cid })))
      : []
    // Проект, на который смотрит окно: фильтр ?p= или проект открытой задачи.
    const activeProjectId = here.projectId ?? (here.taskId ? ball.find((x) => x.id === here.taskId)?.project?.id : null) ?? null

    liveRef.current = { timer: run, companyId: activeCompany?.id ?? null, tasks: ball, projects: projectList, companies: companyList, notifications: notices }

    bridge.setState({
      authed,
      unread: authed ? inbox.data?.unreadTotal ?? 0 : 0,
      timer: run
        ? {
            id: run.id,
            description: run.description ?? '',
            startedAt: run.startedAt,
            // Панели нужен id: по нему она узнаёт идущий проект в списке и
            // ставит галочку. null — время на компанию.
            projectId: run.projectId,
            projectName: nameOf(run.projectId) ?? run.projectName,
            taskId: run.task?.id ?? null,
            taskNumber: run.task?.number ?? null,
            companyId: run.companyId ?? companyOf(run.projectId) ?? null,
          }
        : null,
      notifications: notices.map((n) => {
        const who = n.actor?.name?.trim() ?? ''
        // Заголовок сервер собирает как «{кто} {что}» — имя выносим жирным в
        // начало, как в макете. Иначе строка идёт как есть.
        const named = Boolean(who) && n.title.startsWith(who)
        // Уведомление о задаче открывает её панелью — по id, а не разбором
        // старой ссылки: так надёжнее.
        const link =
          n.entityType === 'task' && n.entityId
            ? `/c/${n.companyId}?t=${encodeURIComponent(n.entityId)}`
            : n.link
              ? toV2Link(n.link, { companyId: n.companyId, companyOf })
              : `/c/${n.companyId}/notifications`
        return {
          id: n.id,
          title: n.title,
          summary: n.summary,
          link,
          projectId: n.projectId,
          projectName: n.projectName ? shortProject(n.projectName) : undefined,
          unread: !n.readAt,
          companyId: n.companyId,
          who: named ? who : undefined,
          text: named ? n.title.slice(who.length).trim() : n.title,
          note: (n.summary || n.body || '').trim().slice(0, 240) || null,
          when: timeAgo(lng, n.createdAt),
          color: n.actor ? personColor(n.actor.id) : undefined,
          letter: letterOf(n.actor?.name ?? 'C'),
        }
      }),
      tasks: ball.slice(0, 150).map((x) => {
        const mk = moveKey(x)
        const client = Boolean(x.ball.waitingClientSince)
        const n = dueDiff(x.dueDate)
        // Владелец сам себе задачу не проверяет: «готово» закрывает. Задачу
        // без владельца — тоже: отдать на проверку некому.
        const owner = !x.owner || (Boolean(myId) && x.owner.id === myId)
        // «От кого» — как в списке «На мне»: кто прислал последним, иначе владелец.
        const person = x.last?.actor ?? x.owner
        return {
          id: x.id,
          number: x.number,
          title: x.title,
          status: x.status,
          // v2: задача открывается панелью поверх списка компании (l03).
          link: `/c/${x.companyId}?t=${encodeURIComponent(x.id)}`,
          projectId: x.project?.id ?? '',
          projectName: x.project ? shortProject(x.project.name) : undefined,
          due: x.dueDate ? dueText(tv, x.dueDate, lng) : undefined,
          late: n !== null && n < 0,
          soon: n !== null && n >= 0 && n <= 1,
          companyId: x.companyId,
          move: mk,
          moveLabel: tv(`mv.${mk}`),
          round: x.ball.round > 1 ? tv('round', { n: x.ball.round }) : undefined,
          from: !person ? undefined : person.id === myId ? tv('tasks.yourTask') : tv('tasks.from', { name: person.name }),
          wait: client
            ? tv('wait.since', { date: new Date(x.ball.waitingClientSince!).toLocaleDateString(lng, { month: 'short', day: 'numeric' }) })
            : waitText(tv, x.ball.heldSince),
          long: !client && heatOf(x.ball.move, x.ball.heldSince) === 'burn',
          isNew: x.isNew,
          // Кнопка по правилам мяча (п. 5). Статусы — те, что понимает ручка
          // трея: review — «на проверку» владельцу, done — принять/закрыть.
          // Ответ на вопрос и «клиент ответил» требуют записки — только в приложении.
          action:
            client || mk === 'answer'
              ? null
              : mk === 'review'
                ? { status: 'done' as const, label: tv('act.accept') }
                : owner
                  ? { status: 'done' as const, label: tv('tray.done') }
                  : { status: 'review' as const, label: tv('act.review') },
        }
      }),
      projects: projectList.map((p) => ({
        id: p.id,
        name: p.name,
        short: shortProject(p.name),
        companyId: p.companyId,
        color: projectColor({ id: p.id, color: p.color ?? null }),
        logoUrl: p.logoUrl,
        letter: letterOf(p.name),
        unread: p.stats?.unread ?? 0,
      })),
      project: authed && activeProjectId ? { id: activeProjectId, name: nameOf(activeProjectId) ?? '' } : null,
      user:
        authed && me.data
          ? { name: me.data.name, email: me.data.email, avatarUrl: me.data.avatarUrl, todayMinutes: today.data ?? null }
          : null,
      company: activeCompany
        ? {
            id: activeCompany.id,
            name: activeCompany.name,
            // Подключиться к своей компании может любой её участник: туннель
            // открывает только те проекты, где человек состоит, и с его же
            // правами — больше своего он ассистенту не выдаст.
            canGrantCompany: true,
          }
        : null,
      companies: companyList.map((c, i) => ({
        id: c.id,
        name: c.name,
        canGrantCompany: true,
        // Главный проект компании — для старой панели: она подставляла его,
        // когда человек ещё ничего не выбрал сам.
        mainProjectId: c.mainProjectId ?? null,
        logoUrl: c.logoUrl ?? null,
        letter: letterOf(c.name),
        meta: tv('tray.tasks', { count: ball.filter((x) => x.companyId === c.id).length }),
        unread: inboxes[i]?.unreadTotal ?? 0,
        timerProjectId: readTimerChoice(c.id),
      })),
      connections: (authed ? bridgeSessions.data?.items ?? [] : []).map((x) => ({
        id: x.id,
        clientName: x.clientName,
        scope: x.scope,
        where: (x.scope === 'all' ? t('connect.allProjects') : x.scope === 'company' ? x.company?.name : x.project?.name) ?? '',
      })),
      strings: {
        // --- общие с оболочкой: меню трея и подсказка над значком (main.cjs) ---
        start: t('desktop.start'),
        stop: t('desktop.stop'),
        idle: t('desktop.idle'),
        idleNoProject: t('desktop.idleNoProject'),
        minShort: t('desktop.minShort'),
        noTask: t('time.noTask'),
        openApp: t('desktop.openApp'),
        close: t('desktop.close'),
        unreadOne: t('desktop.unread'),
        launchAtLogin: t('desktop.launchAtLogin'),
        reload: t('desktop.reload'),
        about: t('desktop.about'),
        notifySettings: t('notif.system'),
        updateReady: t('desktop.updateReady'),
        quit: t('desktop.quit'),
        signIn: t('desktop.signIn'),
        // --- прежняя панель: она остаётся запасной копией внутри оболочки ---
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
        emptyInbox: t('desktop.emptyInbox'),
        emptyTasks: t('desktop.emptyTasks'),
        emptyProjects: t('desktop.emptyProjects'),
        openHours: t('desktop.openHours'),
        openProfile: t('profile.title'),
        allRead: t('desktop.allRead'),
        due: t('desktop.due'),
        pickProject: t('desktop.pickProject'),
        showDone: t('desktop.showDone'),
        timerRunning: t('desktop.timerRunning'),
        signedOut: t('desktop.signedOut'),
        signedOutHint: t('desktop.signedOutHint'),
        // --- подключение ассистента (есть и в новой панели) ---
        editElapsed: t('desktop.editElapsed'),
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
        connectGroupCompanies: t('connect.groupCompanies'),
        connectGroupProjects: t('connect.groupProjects'),
        connectAllProjectsOf: t('connect.allProjectsOf'),
        connectMasterTitle: t('connect.masterTitle'),
        connectMasterNote: t('connect.masterNote'),
        connectMasterBadge: t('connect.allProjects'),
        connectSearch: t('connect.search'),
        connectNothingFound: t('connect.nothingFound'),
        // --- панель v2 ---
        mine: tv('tray.mine'),
        waiting: tv('tray.waiting'),
        notices: tv('tray.notices'),
        all: tv('tray.all'),
        openInApp: tv('tray.openInApp'),
        emptyH: tv('tray.emptyH'),
        emptyP: tv('tray.emptyP'),
        inboxEmpty: tv('tray.inboxEmpty'),
        allNotes: tv('tray.allNotes'),
        loginH: tv('tray.loginH'),
        loginP: tv('tray.loginP'),
        loginBtn: tv('tray.loginBtn'),
        startShort: tv('tray.startShort'),
        timerIdle: tv('tray.idle'),
        startTimer: tv('timer.start'),
        stopTimer: tv('timer.stop'),
        wholeCompany: tv('timer.company'),
        trackTo: tv('timer.pickHead'),
        findProj: tv('timer.find'),
        // {{q}} подставляет панель: искомое она знает, а веб — нет.
        noProj: tv('timer.none', { q: '{{q}}', interpolation: { escapeValue: false } }),
        today: tv('head.today'),
        companies: tv('head.companies'),
        switchCo: tv('head.switchCompany'),
        account: tv('tray.account'),
        hours: tv('tray.hours'),
        profile: tv('tray.profile'),
        notifyPrefs: tv('tray.notifySettings'),
        connectTitle: tv('tray.connect'),
        back: tv('tray.back'),
        sent: tv('tray.sent'),
        logout: tv('me.logout'),
        loading: tv('common.loading'),
        // на иврите панель должна разворачиваться, как и всё приложение
        dir: i18n.dir(),
        lang: lng,
        // Тема — та, что выбрана в приложении: панель — его продолжение.
        theme,
      },
    })
  }, [
    bridge,
    authed,
    inbox.data,
    running.data,
    today.data,
    projects.data,
    companies.data,
    mine,
    inboxes,
    bridgeSessions.data,
    me.data,
    here.companyId,
    here.projectId,
    here.taskId,
    t,
    tv,
    i18n,
    theme,
    stateNonce,
  ])

  // Системные уведомления показывает useSystemNotifications — общий хук для
  // веба и десктопа. Раньше это жило здесь и работало только в Electron.

  // --- команды из главного процесса -----------------------------------------
  useEffect(() => {
    if (!bridge) return

    /** Таймер сменился — перечитать его везде, где он показан. */
    const refreshTime = () => {
      void qc.invalidateQueries({ queryKey: keys.running })
      void qc.invalidateQueries({ queryKey: keys.today })
      // старые экраны держат таймер под своими ключами
      void qc.invalidateQueries({ queryKey: ['desktop-running'] })
      void qc.invalidateQueries({ queryKey: ['time-running'] })
      void qc.invalidateQueries({ queryKey: ['time-entries'] })
    }

    /**
     * Цель таймера по id: панель шлёт то, что выбрал человек, — проект или
     * компанию целиком (v2); старая панель — только проекты. Отличаем по
     * своим спискам.
     *
     * Без id — как кнопка в шапке v2: выбранный там проект открытой
     * компании, а если его нет — сама компания. Проект, которого нет в
     * списке (список ещё грузится), отдаём серверу как есть: членство он
     * проверит сам.
     */
    const targetOf = (id: string | null | undefined): TimerTarget | null => {
      const live = liveRef.current
      if (id) {
        if (live.companies?.some((c) => c.id === id)) return { companyId: id, projectId: null }
        return { companyId: live.projects?.find((p) => p.id === id)?.companyId ?? null, projectId: id }
      }
      const companyId = live.companyId ?? live.companies?.[0]?.id
      if (!companyId) return null
      const chosen = readTimerChoice(companyId)
      const member = Boolean(chosen) && Boolean(live.projects?.some((p) => p.id === chosen && p.companyId === companyId))
      return { companyId, projectId: member ? chosen : null }
    }

    /**
     * Старт по сессии — /my/time, как у шапки v2: проектный заголовок и
     * правила чата здесь не нужны, а время на компанию иначе и не завести.
     */
    const startOn = async (target: TimerTarget, extra: { taskId?: string; description?: string } = {}) => {
      const body = target.projectId ? { projectId: target.projectId, ...extra } : { companyId: target.companyId }
      await api('/api/v1/my/time/start', { method: 'POST', body: JSON.stringify(body) })
      // Выбор запоминаем там же, где шапка v2: следующий «плей» — в шапке,
      // в панели или по Ctrl+Shift+T — пойдёт туда же.
      if (target.companyId) saveTimerChoice(target.companyId, target.projectId)
    }
    const stopRun = (run: RunningItem) => api(`/api/v1/my/time/${run.id}/stop`, { method: 'POST' })

    const offNav = bridge.onNavigate((payload) => {
      // Панель присылает объект; строка — от старых вызовов (переход в проект)
      // и от меню трея в оболочке.
      const raw = typeof payload === 'string' ? payload : payload?.link
      const notificationId = typeof payload === 'string' ? null : payload?.notificationId
      const projectId = typeof payload === 'string' ? null : payload?.projectId
      if (!raw) return

      // «Выйти» из меню панели. Своего вызова у оболочки для этого нет, а
      // обновлять её ради одной кнопки нельзя — панель просит выход тем же
      // путём, что и переход.
      if (raw === '/logout') {
        logout()
        setAuthed(false)
        navigate('/login')
        return
      }

      // Старые адреса — в v2 (l03): сервер пишет в уведомления
      // /c/<co>/p/<p>/tasks/<id>, меню трея в оболочке шлёт
      // /settings/notifications и /start. Компания для адресов без неё — та,
      // откуда уведомление, иначе открытая в окне.
      const live = liveRef.current
      const companyOfProject = (pid: string) => live.projects?.find((p) => p.id === pid)?.companyId
      const notice = notificationId ? live.notifications?.find((n) => n.id === notificationId) : undefined
      const companyId =
        notice?.companyId ?? (projectId ? companyOfProject(projectId) : undefined) ?? live.companyId ?? live.companies?.[0]?.id ?? null
      navigate(toV2Link(raw, { companyId, companyOf: companyOfProject }))

      // Клик из панели — это прочтение: уведомление привело человека на место,
      // и висеть непрочитанным ему больше незачем. id приходит от панели: по
      // ссылке уведомления не различить, несколько ведут в одно место.
      //
      // Уход в проект целиком (старая панель, заголовок группы) гасит все его
      // уведомления: под заголовком показаны именно они, и человек их видел.
      const readBody = notificationId
        ? { ids: [notificationId] }
        : projectId
          ? { projectId }
          : null
      if (!readBody) return
      api('/api/v1/inbox/read', { method: 'POST', body: JSON.stringify(readBody) })
        .then(() => {
          // Обе семьи ключей (n09): бейдж трея и старые экраны — ['inbox'],
          // колокольчик и списки v2 — ['v2', …].
          void qc.invalidateQueries({ queryKey: ['inbox'] })
          void qc.invalidateQueries({ queryKey: ['v2', 'inbox'] })
          void qc.invalidateQueries({ queryKey: ['v2', 'ball'] })
          void qc.invalidateQueries({ queryKey: ['sidebar-projects'] })
          void qc.invalidateQueries({ queryKey: ['tray-projects'] })
        })
        .catch(() => {})
    })

    /**
     * Старт/стоп из панели и по Ctrl+Shift+T (l06).
     *
     * В v2 таймер по умолчанию идёт «на компанию», без проекта. Раньше здесь
     * требовался проект: идущий на компанию таймер из трея было не
     * остановить, а старт без выбранного проекта отвечал «откройте проект».
     *
     *   идёт, цель не названа или та же → стоп, что бы ни шло;
     *   идёт, названа другая цель       → перенос: стоп и старт на ней
     *                                      (выбор в панели и есть старт — как в шапке v2);
     *   не идёт                          → старт на названной цели, а без неё —
     *                                      как «плей» в шапке v2 (см. targetOf).
     */
    const offTimer = bridge.onToggleTimer(async (wanted) => {
      // Из ref, а не из замыкания: на момент нажатия данные могли смениться.
      const current = liveRef.current.timer ?? null
      try {
        if (current) {
          await stopRun(current)
          const runningOn = current.projectId ?? current.companyId ?? null
          const next = wanted && wanted !== runningOn ? targetOf(wanted) : null
          if (next) await startOn(next)
        } else {
          const target = targetOf(wanted)
          if (!target) {
            // Компании нет вовсе — запускать некуда, говорим прямо.
            bridge.show()
            toast.info(t('desktop.pickProjectForTimer'))
            return
          }
          await startOn(target)
        }
      } catch (e) {
        // Молчаливый отказ — худшее, что здесь может быть: кнопка выглядит
        // нажатой, а не происходит ничего. Говорим, что пошло не так.
        toast.error(e instanceof Error ? e.message : String(e))
        bridge.show()
      }
      refreshTime()
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

    const offApprove = bridge.onConnectApprove(async ({ code, projectId, companyId: cid, all }) => {
      try {
        // Проект, вся компания или все проекты человека — сервер сам проверит
        // роль. Мастер-доступ первым: при нём остальные поля уже не значат
        // ничего, и отправить их вместе значило бы сузить выданное.
        const target = all ? { all: true } : cid ? { companyId: cid } : { projectId }
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

    /**
     * Правка натикавшего из панели трея.
     *
     * Панель присылает СЕКУНДЫ, а не новую дату: считает веб — здесь и токен,
     * и права, и показ ошибки. Новое начало получается как «сейчас минус
     * столько-то», поэтому день выставляется сам и отдельно его не трогаем —
     * ровно то, на чём горели в TASK-6, когда сдвиг одного края делал из трёх
     * минут сутки.
     */
    const offTimerElapsed = bridge.onTimerElapsed?.(async ({ id, seconds }) => {
      const current = liveRef.current.timer
      // Таймер мог остановиться, пока человек набирал.
      if (!current || current.id !== id) return
      /**
       * Отсчитываем назад ТОЧНО, без округления.
       *
       * В базе лежат метки времени, а не минуты, — секунды там хранятся. Раньше
       * я обнулял их и сохранял только минуты: правка одних секунд ничего не
       * меняла, «10:10» и «10:20» давали одинаковый результат, и человек видел,
       * что ввод не применился.
       */
      const startedAt = new Date(Date.now() - seconds * 1000)
      try {
        await api(`/api/v1/my/time/${id}`, { method: 'PATCH', body: JSON.stringify({ startedAt: startedAt.toISOString() }) })
      } catch (e) {
        // Панель ошибок не показывает — выводим в приложении, иначе правка
        // молча не применяется и человек считает, что всё получилось.
        toast.error(e instanceof Error ? e.message : String(e))
        bridge.show()
      }
      // Все ключи таймера: панель и шапка v2 читают keys.running, старые
      // экраны — свои. Инвалидируя один, я оставлял панель ждать следующего
      // опроса — до 30 секунд со старым числом на экране.
      refreshTime()
    })

    // Таймер прямо на задаче: перебивает текущий, потому что работают над
    // чем-то одним, а два счётчика на одного человека — это уже путаница.
    const offTaskTimer = bridge.onTaskTimer(async (taskId) => {
      // Из ref: список задач и текущий таймер к моменту нажатия могли смениться.
      const task = liveRef.current.tasks?.find((x) => x.id === taskId)
      if (!task?.project) return
      const current = liveRef.current.timer
      try {
        if (current) await stopRun(current)
        // Уже шёл таймер именно по этой задаче — значит нажатие было «стоп».
        if (current?.task?.id !== taskId) {
          await startOn({ companyId: task.companyId, projectId: task.project.id }, { taskId, description: task.title })
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
        bridge.show()
      }
      refreshTime()
    })

    // Кнопка в строке задачи: ручка трея переводит статус в ход мяча
    // (review — на проверку владельцу, done — принять). Ради «отдал на
    // проверку» открывать приложение и искать задачу — лишняя дорога.
    const offTaskStatus = bridge.onTaskStatus(async ({ taskId, status }) => {
      try {
        await api(`/api/v1/inbox/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ status }) })
      } catch (e) {
        // Отказ сервера показываем: кнопка в панели уже «нажата», и без
        // объяснения человек решит, что всё ушло.
        toast.error(e instanceof Error ? e.message : String(e))
        bridge.show()
      }
      void qc.invalidateQueries({ queryKey: ['v2', 'ball'] })
      void qc.invalidateQueries({ queryKey: keys.task(taskId) })
      void qc.invalidateQueries({ queryKey: keys.handoffs(taskId) })
      void qc.invalidateQueries({ queryKey: ['v2', 'inbox'] })
      void qc.invalidateQueries({ queryKey: ['desktop-tasks'] })
      void qc.invalidateQueries({ queryKey: ['tasks'] })
    })

    // Проект выбрали из старой панели: в v2 проект — фильтр на экране
    // компании. Окно не поднимаем — человек остался в панели намеренно.
    const offSetProject = bridge.onSetProject((id) => {
      if (!id) return
      // Компания — из того же списка, что панель показывает; из ref, потому что
      // подписка живёт дольше данных, на которых её создали.
      const cid = liveRef.current.projects?.find((p) => p.id === id)?.companyId
      if (cid) navigate(`/c/${cid}?p=${encodeURIComponent(id)}`)
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
      void qc.invalidateQueries({ queryKey: keys.running })
      void qc.invalidateQueries({ queryKey: keys.today })
      void qc.invalidateQueries({ queryKey: ['inbox'] })
      void qc.invalidateQueries({ queryKey: ['v2', 'inbox'] })
      void qc.invalidateQueries({ queryKey: ['v2', 'ball', 'mine'] })
      // И то, на чём держится сама панель. Раньше кнопка обновляла только
      // три запроса выше — те, что и так опрашивают себя сами. Когда человек
      // жмёт «обновить», он смотрит на пустую панель: сломано как раз то,
      // чего в этом списке не было.
      void qc.invalidateQueries({ queryKey: ['companies'] })
      void qc.invalidateQueries({ queryKey: ['tray-projects'] })
      void qc.invalidateQueries({ queryKey: ['me'] })
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
      offTimerElapsed?.()
      offRefresh()
      offStateRefresh()
      offAbout()
      offRevoke()
    }
    // Данных таймера в зависимостях нет намеренно: обработчики читают их из
    // liveRef. Иначе каждая смена проекта снимала и вешала подписки заново, и
    // нажатие в этот момент уходило в никуда.
  }, [bridge, navigate, qc, t])
}
