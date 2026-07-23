import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowLeftRight } from 'lucide-react'
import { api, getProjectToken, setProjectToken } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LanguageSelect } from '@/components/LanguageSelect'
import { AboutTab } from '@/components/tabs/AboutTab'
import { PermissionsTab } from '@/components/tabs/PermissionsTab'
import { FilesTab } from '@/components/tabs/FilesTab'
import { CredentialsTab } from '@/components/tabs/CredentialsTab'

// Главный экран: чат 40% | табы проекта 60% (см. CONCEPT.md §3)
const TAB_KEYS = ['about', 'tasks', 'files', 'credentials', 'permissions'] as const
type TabKey = (typeof TAB_KEYS)[number]

type ProjectDetails = {
  id: string
  name: string
  about: string
  chatRules: string
  aiConfig: Record<string, unknown>
  myRole: 'owner' | 'admin' | 'member' | null
}

export function ProjectScreen() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { id } = useParams()
  const [tab, setTab] = useState<TabKey>('about')

  useEffect(() => {
    if (!getProjectToken()) navigate('/start', { replace: true })
  }, [navigate])

  const project = useQuery({
    queryKey: ['project', id],
    queryFn: () => api<ProjectDetails>(`/api/v1/projects/${id}`),
    enabled: Boolean(id),
  })

  const switchProject = () => {
    setProjectToken(null) // сессия жива — назад к выбору без релогина (SPEC §5)
    navigate('/start')
  }

  return (
    <div className="flex h-dvh">
      {/* Чат — 40% */}
      <div className="flex w-[40%] min-w-[320px] flex-col border-e">
        <ChatPanel projectName={project.data?.name} />
      </div>

      {/* Табы проекта — 60% */}
      <div className="flex flex-1 flex-col">
        <nav className="flex items-center gap-1 border-b px-4 py-2">
          {TAB_KEYS.filter(
            (key) => key !== 'permissions' || project.data?.myRole === 'owner' || project.data?.myRole === 'admin',
          ).map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm transition-colors',
                tab === key
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              {t(`tabs.${key}`)}
            </button>
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
        <main className="flex-1 overflow-y-auto">
          {tab === 'about' ? (
            <AboutTab project={project.data} loading={project.isLoading} />
          ) : tab === 'files' && id ? (
            <FilesTab projectId={id} />
          ) : tab === 'credentials' && id ? (
            <CredentialsTab
              projectId={id}
              isAdmin={project.data?.myRole === 'owner' || project.data?.myRole === 'admin'}
            />
          ) : tab === 'permissions' && id ? (
            <PermissionsTab
              projectId={id}
              canEdit={project.data?.myRole === 'owner' || project.data?.myRole === 'admin'}
            />
          ) : (
            <div className="grid h-full place-items-center text-muted-foreground">
              <p className="text-sm">{t('tabs.placeholder', { tab: t(`tabs.${tab}`) })}</p>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
