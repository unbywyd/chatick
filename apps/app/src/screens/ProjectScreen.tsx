import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Building2, Menu, MessagesSquare, PanelsTopLeft, X } from 'lucide-react'
import { api, getSessionToken, type Me } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useProjectToken } from '@/hooks/useProjectToken'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { ProjectSidebar } from '@/components/ProjectSidebar'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LanguageSelect } from '@/components/LanguageSelect'
import { ProfileMenu } from '@/components/ProfileMenu'
import { NotificationBell } from '@/components/NotificationBell'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

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

const WORK_TABS = ['tasks', 'files', 'documents', 'resources', 'team', 'history', 'about'] as const

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
  const isAdmin = project.data?.myRole === 'owner' || project.data?.myRole === 'admin'

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
          'w-[300px] shrink-0 border-e',
          'fixed inset-y-0 start-0 z-40 transition-transform duration-200 md:static md:z-0 md:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full rtl:translate-x-full',
        )}
      >
        <ProjectSidebar me={me.data} onPick={() => setSidebarOpen(false)} />
      </aside>
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* КОЛОНКА 2 — чат. На xl всегда виден; ниже — только когда выбран таб «Чат». */}
      <div
        className={cn(
          'min-w-0 flex-col border-e xl:flex xl:w-[38%] xl:min-w-[340px] xl:shrink-0 xl:flex-none',
          isChatTab ? 'flex flex-1' : 'hidden',
        )}
      >
        <header className="flex items-center gap-2 border-b px-2 py-2">
          <button
            onClick={() => setSidebarOpen(true)}
            className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
            title={t('sidebar.projects')}
          >
            <Menu className="size-4" />
          </button>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{project.data?.name ?? '…'}</span>
          {/* ниже xl чат — вкладка, значит нужен явный выход в рабочую зону */}
          <button
            onClick={() => navigate(`/p/${id}/tasks`)}
            className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground xl:hidden"
            title={t('project.mobile.work')}
          >
            <PanelsTopLeft className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1">
          <ChatPanel
            projectName={project.data?.name}
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

          <div className="flex shrink-0 items-center gap-1">
            <NotificationBell currentProjectId={id} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  title={t('project.menu')}
                >
                  <Menu className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onSelect={() => navigate(`/start/${project.data?.companyId ?? ''}`)}>
                  <Building2 className="size-4" />
                  {t('sidebar.companySettings')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                  <span className="text-xs text-muted-foreground">{t('project.language')}</span>
                  <LanguageSelect />
                </div>
                <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                  <span className="text-xs text-muted-foreground">{t('project.theme')}</span>
                  <ThemeToggle />
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
            <ProfileMenu me={me.data} projectId={id} isAdmin={isAdmin} />
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
