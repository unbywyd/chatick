import { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Building2, LayoutGrid, MessagesSquare } from 'lucide-react'
import { api, getProjectToken, setProjectToken, type Me } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LanguageSelect } from '@/components/LanguageSelect'
import { ProfileMenu } from '@/components/ProfileMenu'
import { NotificationBell } from '@/components/NotificationBell'

// Layout проекта (CONCEPT.md §3): чат 40% постоянен, табы — вложенные роуты (Outlet),
// каждый таб имеет свой URL — прямые ссылки работают: /p/:id/tasks, /p/:id/files, ...
const TAB_KEYS = ['tasks', 'files', 'documents', 'resources', 'team', 'history', 'about'] as const

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

  useEffect(() => {
    if (!getProjectToken()) navigate('/start', { replace: true })
  }, [navigate])

  const project = useQuery({
    queryKey: ['project', id],
    queryFn: () => api<ProjectDetails>(`/api/v1/projects/${id}`),
    enabled: Boolean(id),
  })
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/v1/auth/me') })
  // Что показываем на узком экране: чат или рабочую область (табы).
  // На десктопе обе панели видны всегда и это состояние не используется.
  const [mobileView, setMobileView] = useState<'chat' | 'work'>('work')

  const switchProject = () => {
    setProjectToken(null) // сессия жива — назад к выбору без релогина (SPEC §5)
    navigate('/start')
  }

  return (
    <div className="flex h-dvh">
      {/*
        Чат — 40% на десктопе. На мобильном две панели рядом не помещаются
        (чат съедал экран, табам оставалась полоска), поэтому показываем
        что-то одно, с переключателем внизу.
      */}
      <div
        className={cn(
          'flex-col border-e pb-12 md:flex md:w-[40%] md:min-w-[320px] md:pb-0',
          mobileView === 'chat' ? 'flex w-full' : 'hidden',
        )}
      >
        <ChatPanel
          projectName={project.data?.name}
          aiMode={(project.data?.aiConfig as { mode?: 'observer' | 'assistant' | 'moderator' })?.mode ?? 'assistant'}
          myRole={project.data?.myRole}
          meId={me.data?.id}
        />
      </div>

      {/* Табы — роуты */}
      <div
        className={cn(
          'min-w-0 flex-1 flex-col md:flex',
          mobileView === 'work' ? 'flex' : 'hidden',
        )}
      >
        <nav className="flex flex-wrap items-center gap-1 border-b px-3 py-2 sm:px-4">
          {TAB_KEYS.map((key) => (
            <NavLink
              key={key}
              to={`/p/${id}/${key}`}
              className={({ isActive }) =>
                cn(
                  'rounded-md px-3 py-1.5 text-sm transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )
              }
            >
              {t(`tabs.${key}`)}
            </NavLink>
          ))}
          <div className="ms-auto flex items-center gap-2">
            <button
              onClick={switchProject}
              title={t('project.switch')}
              className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <Building2 className="size-3.5" />
              {t('project.switch')}
            </button>
            <NotificationBell currentProjectId={id} />
            <LanguageSelect />
            <ThemeToggle />
            <ProfileMenu
              me={me.data}
              projectId={id}
              isAdmin={project.data?.myRole === 'owner' || project.data?.myRole === 'admin'}
            />
          </div>
        </nav>
        <main className="min-h-0 flex-1 overflow-y-auto pb-12 md:pb-0">
          <Outlet context={{ project: project.data, meId: me.data?.id } satisfies ProjectOutletCtx} />
        </main>
      </div>

      {/* Переключатель чат / работа — только на мобильном */}
      <div className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-background/95 backdrop-blur md:hidden">
        {(['chat', 'work'] as const).map((view) => (
          <button
            key={view}
            onClick={() => setMobileView(view)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 py-2.5 text-sm font-medium transition-colors',
              mobileView === view ? 'text-brand' : 'text-muted-foreground',
            )}
          >
            {view === 'chat' ? <MessagesSquare className="size-4" /> : <LayoutGrid className="size-4" />}
            {t(`project.mobile.${view}`)}
          </button>
        ))}
      </div>
    </div>
  )
}

export function useProjectCtx() {
  return useOutletContext<ProjectOutletCtx>()
}
