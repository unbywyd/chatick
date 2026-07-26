import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, MessagesSquare, X } from 'lucide-react'
import { api, getSessionToken, type Me } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useProjectToken } from '@/hooks/useProjectToken'
import { useResizable } from '@/hooks/useResizable'
import { useSidebarCollapsed } from '@/hooks/useSidebarCollapsed'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { ProjectSidebar } from '@/components/ProjectSidebar'
import { Button } from '@/components/ui/button'

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

const WORK_TABS = ['tasks', 'files', 'documents', 'notes', 'resources', 'team', 'history', 'about'] as const

export type ProjectDetails = {
  id: string
  companyId: string
  name: string
  about: string
  chatRules: string
  aiConfig: Record<string, unknown>
  myRole: 'owner' | 'admin' | 'member' | null
}

export type ProjectOutletCtx = { project?: ProjectDetails; meId?: string }

export function ProjectLayout() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { id } = useParams()
  const { pathname } = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // ширина колонки чата: было 38% — на широком мониторе это заметно много
  const chat = useResizable('chatick_chat_width', 380, 300, 720)
  const [collapsed] = useSidebarCollapsed()

  // Текущая вкладка из URL (/p/:id/chat, /p/:id/tasks, ...). Берём из pathname:
  // маршрут не splat, поэтому useParams('*') здесь пустой.
  const tab = pathname.split('/')[3] || 'chat'
  const isChatTab = tab === 'chat'

  useEffect(() => {
    if (!getSessionToken()) navigate('/login', { replace: true })
  }, [navigate])

  const token = useProjectToken(id)
  const project = useQuery({
    queryKey: ['project', id],
    queryFn: () => api<ProjectDetails>(`/api/v1/projects/${id}`),
    enabled: Boolean(id) && token.status === 'ready',
  })
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/v1/auth/me') })

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
        <ProjectSidebar me={me.data} onPick={() => setSidebarOpen(false)} />
      </aside>
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* КОЛОНКА 2 — чат. На xl всегда виден; ниже — только когда выбран таб «Чат». */}
      {/*
        Колонка чата. Ниже xl занимает всю ширину (чат — вкладка), на широком
        экране получает фиксированную ширину, которую можно тянуть за границу.
      */}
      <div
        style={{ ['--chat-w' as string]: `${chat.width}px` }}
        className={cn(
          'relative min-w-0 flex-col border-e xl:flex xl:w-[var(--chat-w)] xl:shrink-0 xl:flex-none',
          isChatTab ? 'flex flex-1' : 'hidden',
        )}
      >
        {/* своей шапки здесь нет: название и навигация живут в шапке чата,
            иначе строка с именем проекта дублируется дважды подряд */}
        {/* ручка перетаскивания границы */}
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
        <div className="min-h-0 flex-1">
          <ChatPanel
            projectName={project.data?.name}
            onOpenSidebar={() => setSidebarOpen(true)}
            onOpenWork={() => navigate(`/p/${id}/tasks`)}
            aiMode={(project.data?.aiConfig as { mode?: 'observer' | 'assistant' | 'moderator' })?.mode ?? 'assistant'}
            myRole={project.data?.myRole}
            meId={me.data?.id}
          />
        </div>
      </div>

      {/* КОЛОНКА 3 — рабочая зона. Ниже xl показывается вместо чата. */}
      <div className={cn('min-w-0 flex-1 flex-col', isChatTab ? 'hidden xl:flex' : 'flex')}>
        <nav className="flex items-center gap-1 border-b px-2 py-2">
          {/* назад в чат — когда чат не помещается рядом */}
          {!isChatTab && (
            <button
              onClick={() => navigate(`/p/${id}/chat`)}
              className="shrink-0 rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground xl:hidden"
              title={t('tabs.chat')}
            >
              <ArrowLeft className="size-4 rtl:-scale-x-100" />
            </button>
          )}

          <div className="scrollbar-none -mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto px-1">
            {/* «Чат» — обычная вкладка, пока он не помещается отдельной колонкой */}
            <NavLink
              to={`/p/${id}/chat`}
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
                to={`/p/${id}/${key}`}
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
          </div>

        </nav>

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
          ) : (
            <Outlet context={{ project: project.data, meId: me.data?.id } satisfies ProjectOutletCtx} />
          )}
        </main>
      </div>
    </div>
  )
}

export function useProjectCtx() {
  return useOutletContext<ProjectOutletCtx>()
}
