import { useEffect } from 'react'
import { NavLink, Outlet, useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowLeftRight } from 'lucide-react'
import { api, getProjectToken, setProjectToken, type Me } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LanguageSelect } from '@/components/LanguageSelect'

// Layout проекта (CONCEPT.md §3): чат 40% постоянен, табы — вложенные роуты (Outlet),
// каждый таб имеет свой URL — прямые ссылки работают: /p/:id/tasks, /p/:id/files, ...
const TAB_KEYS = ['tasks', 'files', 'resources', 'team', 'notifications', 'ai', 'about'] as const

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

  const switchProject = () => {
    setProjectToken(null) // сессия жива — назад к выбору без релогина (SPEC §5)
    navigate('/start')
  }

  return (
    <div className="flex h-dvh">
      {/* Чат — 40%, живёт на всех страницах проекта */}
      <div className="flex w-[40%] min-w-[320px] flex-col border-e">
        <ChatPanel
          projectName={project.data?.name}
          aiMode={(project.data?.aiConfig as { mode?: 'observer' | 'assistant' | 'moderator' })?.mode ?? 'assistant'}
          myRole={project.data?.myRole}
          meId={me.data?.id}
        />
      </div>

      {/* Табы — роуты */}
      <div className="flex min-w-0 flex-1 flex-col">
        <nav className="flex items-center gap-1 border-b px-4 py-2">
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
              <ArrowLeftRight className="size-3.5" />
              {t('project.switch')}
            </button>
            <LanguageSelect />
            <ThemeToggle />
          </div>
        </nav>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet context={{ project: project.data, meId: me.data?.id } satisfies ProjectOutletCtx} />
        </main>
      </div>
    </div>
  )
}

export function useProjectCtx() {
  return useOutletContext<ProjectOutletCtx>()
}
