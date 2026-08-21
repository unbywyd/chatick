import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ExternalLink, Lock, MessagesSquare, X, FolderX } from 'lucide-react'
import { api, getSessionToken, setReturnTo, type Me } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useProjectToken } from '@/hooks/useProjectToken'
import { useResizable } from '@/hooks/useResizable'
import { useChatCollapsed } from '@/hooks/useChatCollapsed'
import { Tour, type TourStep } from '@/components/Tour'
import { TourWelcome } from '@/components/TourWelcome'
import { useProjectTour } from '@/hooks/useProjectTour'
import { useSidebarCollapsed } from '@/hooks/useSidebarCollapsed'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { ChatPanel, type ChatPanelHandle } from '@/components/chat/ChatPanel'
import { ProjectSidebar } from '@/components/ProjectSidebar'
import { Button } from '@/components/ui/button'
import { ProjectInbox } from '@/components/ProjectInbox'
import { ShortcutsCheatSheet } from '@/components/ShortcutsCheatSheet'
import { useShortcuts } from '@/hooks/useShortcuts'

/*
  Оболочка приложения — мессенджер, а не набор страниц (SPEC §8.29).

    ┌──────────┬────────────┬──────────────────┐
    │ проекты  │    чат     │  рабочая зона    │   ≥ xl: три колонки
    └──────────┴────────────┴──────────────────┘
    ┌──────────┬───────────────────────────────┐
    │ проекты  │ [Чат][Задачи][Файлы] …        │   md–xl: чат = вкладка
    └──────────┴───────────────────────────────┘
    ┌──────────────────────────────────────────┐
    │ одна колонка, список открывается поверх  │   < md
    └──────────────────────────────────────────┘

  projectId живёт в URL, project-токен подтягивается под него фоном — поэтому
  переключение между проектами мгновенное и не перезагружает страницу.
*/

// About и Team ушли в меню профиля: настройки — это администрирование, а не
// вкладка, и просмотр деталей проекта отдельно от формы не нужен.
const WORK_TABS = ['tasks', 'files', 'documents', 'notes', 'resources', 'history'] as const

/**
 * Страницы проекта, которых нет в полосе вкладок: сюда попадают из меню
 * профиля. Ни одна вкладка не подсвечена, и на широком экране выхода с них не
 * было вовсе — стрелка «назад» пряталась как ненужная рядом с чатом.
 */
const OFF_TAB_PAGES = ['shortcuts', 'ai', 'notifications', 'team', 'time'] as const

/**
 * Вкладки, которые включаются в проекте отдельно.
 *
 * Ставится перед «История»: версии — рабочий раздел, а история читается редко
 * и живёт в конце ряда.
 */
const OPTIONAL_TABS: Record<string, string> = { releases: 'releases' }

export type ProjectDetails = {
  /** Состав команды ведётся во внешней системе: видно, но не правится. */
  membersViaApiOnly?: boolean
  id: string
  companyId: string
  name: string
  about: string
  chatRules: string
  aiConfig: Record<string, unknown>
  myRole: 'owner' | 'admin' | 'member' | null
  /** Имя проекта во внешней системе — показывается рядом с нашим. */
  externalName?: string | null
  /** Готовая ссылка «туда». null, если интеграция не настроена. */
  externalLink?: { name: string; url: string } | null
}

export type ProjectOutletCtx = { project?: ProjectDetails; meId?: string }

export function ProjectLayout() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { id, companyId } = useParams()
  const { pathname, key: locationKey } = useLocation()
  /** Основание всех адресов проекта — чтобы компания не терялась при переходах. */
  const base = `/c/${companyId}/p/${id}`
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // ширина колонки чата: было 38% — на широком мониторе это заметно много
  const chat = useResizable('chatick_chat_width', 380, 300, 720)
  // Широкий экран: чат — колонка рядом с работой, а не отдельная вкладка.
  // Объявлен здесь, потому что от него зависит и сворачивание чата ниже.
  const wide = useMediaQuery('(min-width: 1280px)')

  /**
   * Свёрнут ли чат: колонка сужается до полосы, иначе рядом со свёрнутой
   * панелью зияет пустое место шириной в треть экрана.
   *
   * Только на широком. Ниже 1280px чат — вкладка во весь экран, и «свернуть»
   * его оставляло полосу в 56px с аватарками вместо переписки: экран пустой,
   * а чата нет. Прятать то, что и так занимает экран целиком, нечего — из
   * него выходят кнопкой «в работу».
   */
  const [chatCollapsedPref, toggleChatCollapsed] = useChatCollapsed()
  const chatCollapsed = chatCollapsedPref && wide

  /**
   * Вводный тур.
   *
   * Показывается один раз на человека, при первом заходе в проект. Кто закрыл
   * его — ответил, и возвращаться к нему насильно нельзя.
   */
  const tour = useProjectTour()
  /**
   * Тур убран до перезагрузки, но НЕ отвечено «не нужно».
   *
   * Живёт в памяти, а не в базе: щелчок мимо и Escape — это «уйди сейчас», и
   * при следующем заходе тур покажется снова. Отвечает человек только кнопкой
   * «Пропустить» или дойдя до конца.
   */
  const [tourHidden, setTourHidden] = useState(false)
  /**
   * Приветствие показано, дальше сам тур.
   *
   * Отдельной отметки в базе у приветствия нет: оно часть тура. Иначе
   * появилось бы состояние «поздоровались, но не показали», в котором человек
   * при следующем заходе попадал бы сразу в подсказки без объяснения.
   */
  const [greeted, setGreeted] = useState(false)
  const tourSteps: TourStep[] = useMemo(
    () => [
      // Показываем ПОЛЕ ВВОДА, а не всю колонку: колонка шириной с саму
      // карточку, рядом с ней подсказке не встать — она ложилась поверх.
      // А речь всё равно про «пишите как в обычном чате».
      { key: 'chat', target: '[data-tour="composer"]', side: 'top', before: () => { if (chatCollapsed) toggleChatCollapsed() } },
      { key: 'tabs', target: '[data-tour="tabs"]' },
      { key: 'projects', target: '[data-tour="projects"]', side: 'right' },
      { key: 'timer', target: '[data-tour="timer"]', side: 'right' },
      // Компания — стрелка вправо: карточка сверху накрывала саму цель, ведь
      // строка компании и так стоит у нижнего края экрана.
      { key: 'company', target: '[data-tour="company-row"]', side: 'right' },
      // Показываем ПЕРЕКЛЮЧАТЕЛЬ каналов, а не всю колонку чата: разговор про
      // ассистента, а подсвечивался общий чат — человек искал глазами не то.
      { key: 'assistant', target: '[data-tour="modes"]', side: 'top' },
    ],
    [chatCollapsed, toggleChatCollapsed],
  )
  const [collapsed] = useSidebarCollapsed()

  // Текущая вкладка из URL (/c/:companyId/p/:id/chat, .../tasks, ...). Берём из
  // pathname: маршрут не splat, поэтому useParams('*') здесь пустой.
  const tab = pathname.split('/')[5] || 'chat'
  // Страница вне полосы вкладок: показываем «назад» на любой ширине —
  // подсветки нет, и уйти отсюда иначе нечем.
  const offTab = (OFF_TAB_PAGES as readonly string[]).includes(tab)
  const isChatTab = tab === 'chat'

  // На широком экране чат — отдельная колонка, а в рабочей зоне рисуются
  // задачи. URL при этом оставался /chat, и вкладка «Задачи» не подсвечивалась,
  // хотя открыты именно они. Переводим адрес на /tasks, чтобы подсветка,
  // ссылка и содержимое говорили одно и то же.
  const [search] = useSearchParams()

  // Горячие клавиши: слушатель один на проект, здесь же и живёт.
  //
  // Ниже xl чат и рабочая зона делят одно место, поэтому «фокус в чат» сперва
  // уводит на /chat — иначе фокус ушёл бы в поле, которого на экране нет.
  const chatRef = useRef<ChatPanelHandle>(null)
  const focusChatColumn = useCallback(
    (fn: (h: ChatPanelHandle) => void) => {
      if (!wide && id) navigate(`${base}/chat`)
      // Кадром позже: на узком экране колонка появляется только после перехода.
      window.setTimeout(() => chatRef.current && fn(chatRef.current), 0)
    },
    [wide, id, navigate],
  )
  const { cheatSheet, closeCheatSheet } = useShortcuts({
    focusChat: () => focusChatColumn((h) => h.focusChat()),
    focusAi: () => focusChatColumn((h) => h.focusAi()),
  })
  useEffect(() => {
    // ?msg= — переход к конкретному сообщению из уведомления или поиска.
    // Переписав адрес, мы потеряли бы параметр вместе с самим переходом:
    // чат остаётся колонкой рядом, подсветка отработает там.
    if (search.get('msg')) return
    if (wide && isChatTab && id) navigate(`${base}/tasks`, { replace: true })
  }, [wide, isChatTab, id, base, navigate, search])

  useEffect(() => {
    if (getSessionToken()) return
    // Запоминаем, куда шли: ссылкой на задачу делятся, и терять её на входе
    // значит заставить человека искать ту же задачу руками.
    setReturnTo(window.location.hash.slice(1) || '/start')
    navigate('/login', { replace: true })
  }, [navigate])

  const token = useProjectToken(id)
  const project = useQuery({
    queryKey: ['project', id],
    queryFn: () => api<ProjectDetails>(`/api/v1/projects/${id}`),
    enabled: Boolean(id) && token.status === 'ready',
  })
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/v1/auth/me') })

  // Что включено в проекте: от этого зависит состав вкладок. Список короткий и
  // почти не меняется, поэтому не перезапрашиваем его на каждом переходе.
  const features = useQuery({
    queryKey: ['project-features', id],
    queryFn: () => api<{ features: string[]; canManage: boolean }>(`/api/v1/projects/${id}/features`),
    enabled: Boolean(id) && token.status === 'ready',
    staleTime: 5 * 60_000,
  })

  // Проект требует принять правила чата до первого входа (SPEC §4.2)
  if (token.status === 'needRules') {
    return (
      <div className="grid h-dvh place-items-center p-6">
        <div className="w-full max-w-md rounded-xl border bg-card p-6 shadow-xl">
          <h2 className="text-lg font-bold">{t('rules.title', { project: token.projectName })}</h2>
          <p className="mt-3 whitespace-pre-wrap rounded-md bg-secondary p-3 text-sm">
            {token.chatRules || t('rules.empty')}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => navigate('/start')}>
              {t('rules.decline')}
            </Button>
            <Button variant="brand" onClick={token.accept}>
              {t('rules.accept')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* КОЛОНКА 1 — список проектов. На мобильном выезжает поверх. */}
      <aside
        className={cn(
          'w-[300px] shrink-0 border-e bg-background transition-[width] duration-200',
          // Ширина следует за состоянием сайдбара, иначе рядом со свёрнутым
          // списком остаётся пустая полоса. Только на десктопе: на мобильном
          // панель выезжает поверх, и свёрнутая до значков она бесполезна.
          collapsed && 'md:w-14',
          'fixed inset-y-0 start-0 z-40 transition-transform duration-200',
          // на десктопе — обычная колонка без сдвига; сдвиг только на мобильном,
          // иначе в RTL классы состояния перебивали md:translate-x-0 и панель
          // уезжала за край экрана
          'md:static md:z-0 md:!translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full rtl:translate-x-full',
        )}
      >
        {/* Компания из адреса, а не из загруженного проекта: пока запрос идёт,
            companyId уже известен, и шапка не мигает чужой компанией. */}
        <ProjectSidebar me={me.data} companyId={companyId} onPick={() => setSidebarOpen(false)} />
      </aside>
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Вводный тур поверх всего: он объясняет интерфейс, значит должен
          лежать выше него. Выйти можно на любом шаге — см. Tour. */}
      {tour.show && !tourHidden && !greeted && (
        <TourWelcome name={me.data?.name ?? ''} onStart={() => setGreeted(true)} />
      )}
      {tour.show && !tourHidden && greeted && (
        <Tour steps={tourSteps} onDone={tour.finish} onDismiss={() => setTourHidden(true)} />
      )}

      {/* КОЛОНКА 2 — чат. На xl всегда виден; ниже — только когда выбран таб «Чат». */}
      {/*
        Колонка чата. Ниже xl занимает всю ширину (чат — вкладка), на широком
        экране получает фиксированную ширину, которую можно тянуть за границу.
      */}
      <div
        style={{ ['--chat-w' as string]: chatCollapsed ? '56px' : `${chat.width}px` }}
        data-tour="chat"
        className={cn(
          'relative min-w-0 flex-col border-e xl:flex xl:w-[var(--chat-w)] xl:shrink-0 xl:flex-none',
          isChatTab ? 'flex flex-1' : 'hidden',
        )}
      >
        {/* своей шапки здесь нет: название и навигация живут в шапке чата,
            иначе строка с именем проекта дублируется дважды подряд */}
        {/* Ручка перетаскивания границы. В свёрнутом виде её нет: тянуть
            полосу шириной с иконку некуда, а перетаскивание боролось бы с
            заданной шириной и оставляло колонку в промежуточном состоянии. */}
        {!chatCollapsed && (
        <div
          onPointerDown={chat.onPointerDown}
          onDoubleClick={chat.reset}
          title={t('project.resizeChat')}
          className={cn(
            'absolute inset-y-0 -end-1 z-20 hidden w-2 cursor-col-resize xl:block',
            'after:absolute after:inset-y-0 after:start-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors hover:after:bg-brand',
            chat.dragging && 'after:bg-brand',
          )}
        />
        )}
        {/* Проекта нет — чат ни к чему: он продолжал бы опрашивать сервер и
            держать сокет ради того, чего больше не существует. */}
        <div className="min-h-0 flex-1">
          {token.status === 'gone' || token.status === 'notMember' ? null : <ChatPanel
            ref={chatRef}
            onOpenSidebar={() => setSidebarOpen(true)}
            onOpenWork={() => navigate(`${base}/tasks`)}
            onOpenTeam={() => navigate(`${base}/team`)}
            aiMode={(project.data?.aiConfig as { mode?: 'observer' | 'assistant' | 'moderator' })?.mode ?? 'assistant'}
            myRole={project.data?.myRole}
            meId={me.data?.id}
          />}
        </div>
      </div>

      {/* КОЛОНКА 3 — рабочая зона. Ниже xl показывается вместо чата. */}
      <div className={cn('min-w-0 flex-1 flex-col', isChatTab ? 'hidden xl:flex' : 'flex')}>
        <nav data-tour="tabs" className="flex items-center gap-1 border-b px-2 py-2">
          {/* Назад — когда рабочая зона показана вместо чата.

              Настоящая история, если она есть: человек пришёл сюда из
              какого-то места приложения и вернуться хочет именно туда, а не
              туда, куда мы решили за него.

              Если истории нет — прямая ссылка, открытая в новой вкладке, или
              обновлённая страница, — уводим в работу проекта. Тогда
              navigate(-1) вышвырнул бы из приложения на предыдущий сайт.
              React Router помечает первую запись в истории ключом 'default':
              по нему одно и отличаем от другого. */}
          {!isChatTab && (
            <button
              onClick={() => (locationKey === 'default' ? navigate(`${base}/tasks`) : navigate(-1))}
              className={cn(
                'shrink-0 rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground',
                // Рядом с чатом кнопка лишняя — чат и так виден слева.
                offTab ? '' : 'xl:hidden',
              )}
              // Не «Чат»: кнопка ведёт назад по истории, а без неё — в работу.
              title={t('connect.back')}
            >
              <ArrowLeft className="size-4 rtl:-scale-x-100" />
            </button>
          )}

          <div className="scrollbar-none -mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto px-1">
            {/* «Чат» — обычная вкладка, пока он не помещается отдельной колонкой */}
            <NavLink
              to={`${base}/chat`}
              className={({ isActive }) =>
                cn(
                  'flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors xl:hidden',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )
              }
            >
              <MessagesSquare className="size-3.5" />
              {t('tabs.chat')}
            </NavLink>
            {WORK_TABS.map((key) => (
              <NavLink
                key={key}
                to={`${base}/${key}`}
                className={({ isActive }) =>
                  cn(
                    'shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )
                }
              >
                {t(`tabs.${key}`)}
              </NavLink>
            ))}
            {(features.data?.features ?? []).map((f) =>
              OPTIONAL_TABS[f] ? (
                <NavLink
                  key={f}
                  to={`${base}/${OPTIONAL_TABS[f]}`}
                  className={({ isActive }) =>
                    cn(
                      'shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors',
                      isActive
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                    )
                  }
                >
                  {t(`tabs.${OPTIONAL_TABS[f]}`)}
                </NavLink>
              ) : null,
            )}
          </div>

          {/* Переход во внешнюю систему — только когда он настроен. Кнопка,
              ведущая в никуда, хуже её отсутствия: человек нажимает и упирается
              в ошибку чужого сайта. Сервер отдаёт externalLink лишь если у
              компании задан шаблон И у проекта есть внешний идентификатор. */}
          {project.data?.externalLink && (
            <a
              href={project.data.externalLink.url}
              target="_blank"
              rel="noopener noreferrer"
              title={project.data.externalLink.name}
              className="ms-auto flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ExternalLink className="size-3.5" />
              <span className="hidden sm:inline">{project.data.externalLink.name}</span>
            </a>
          )}
        </nav>

        {/* Что меня касается в ЭТОМ проекте — над работой, а не в колокольчике:
            человек уже здесь, и уходить за подробностями некуда. */}
        {id && token.status === 'ready' && <ProjectInbox projectId={id} />}

        <main className="min-h-0 flex-1 overflow-y-auto">
          {token.status === 'error' ? (
            <div className="grid h-full place-items-center p-6 text-center">
              <div>
                <X className="mx-auto size-8 text-destructive" />
                <p className="mt-2 text-sm text-muted-foreground">{token.message}</p>
                <Button variant="outline" className="mt-4" onClick={() => navigate('/start')}>
                  {t('connect.back')}
                </Button>
              </div>
            </div>
          ) : token.status === 'notMember' ? (
            // Проект жив — человека просто нет в его команде. Говорим об этом
            // прямо: «проекта больше нет» отправляло выяснять, кто что удалил.
            <div className="grid h-full place-items-center p-6 text-center">
              <div className="max-w-sm">
                <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-secondary text-muted-foreground">
                  <Lock className="size-7" />
                </span>
                <h2 className="mt-4 text-base font-semibold">{t('project.notMemberTitle')}</h2>
                <p className="mt-2 text-sm text-muted-foreground">{t('project.notMemberText')}</p>
                <Button variant="brand" className="mt-5" onClick={() => navigate('/start')}>
                  {t('project.goneCta')}
                </Button>
              </div>
            </div>
          ) : token.status === 'gone' ? (
            // Проекта больше нет. Молча оставлять человека в пустом интерфейсе
            // нельзя: он будет думать, что всё сломалось, и жать по кнопкам,
            // которые ничего не делают.
            <div className="grid h-full place-items-center p-6 text-center">
              <div className="max-w-sm">
                <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-secondary text-muted-foreground">
                  <FolderX className="size-7" />
                </span>
                <h2 className="mt-4 text-base font-semibold">{t('project.goneTitle')}</h2>
                <p className="mt-2 text-sm text-muted-foreground">{t('project.goneText')}</p>
                <Button variant="brand" className="mt-5" onClick={() => navigate('/start')}>
                  {t('project.goneCta')}
                </Button>
              </div>
            </div>
          ) : token.status === 'loading' ? (
            // Ждём токен проекта. Иначе вкладки успевают сходить за данными со
            // старым токеном — сервер узнаёт проект по нему, и на экране
            // оказывается содержимое предыдущего проекта.
            <div className="grid h-full place-items-center p-6">
              <span className="text-sm text-muted-foreground">…</span>
            </div>
          ) : (
            <Outlet context={{ project: project.data, meId: me.data?.id } satisfies ProjectOutletCtx} />
          )}
        </main>
      </div>

      {/* Шпаргалка по «?» — поверх всего, поэтому в самом конце дерева */}
      {cheatSheet && <ShortcutsCheatSheet onClose={closeCheatSheet} />}
    </div>
  )
}

export function useProjectCtx() {
  return useOutletContext<ProjectOutletCtx>()
}
