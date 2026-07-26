import { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Building2, LayoutGrid, Menu } from 'lucide-react'
import { api, getProjectToken, setProjectToken, type Me } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LanguageSelect } from '@/components/LanguageSelect'
import { ProfileMenu } from '@/components/ProfileMenu'
import { NotificationBell } from '@/components/NotificationBell'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

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
      <div className="flex w-full flex-col border-e md:w-[40%] md:min-w-[320px]">
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
          'flex min-w-0 flex-1 flex-col bg-background',
          // мобильный: выезжает поверх чата; десктоп: обычная колонка
          'fixed inset-0 z-30 transition-transform duration-200 md:static md:z-0 md:translate-x-0',
          mobileView === 'work' ? 'translate-x-0' : 'translate-x-full rtl:-translate-x-full',
        )}
      >
        {/*
          Шапка как в мессенджере: вкладки скроллятся горизонтально (семь штук
          на телефон не влезают), а всё служебное убрано в меню — раньше пять
          контролов занимали половину строки (SPEC §8.29).
        */}
        <nav className="flex items-center gap-1 border-b px-2 py-2 sm:px-4">
          {/* выход из оверлея обратно в чат — только на мобильном */}
          <button
            onClick={() => setMobileView('chat')}
            className="shrink-0 rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
            title={t('project.mobile.chat')}
          >
            <ArrowLeft className="size-4 rtl:-scale-x-100" />
          </button>
          <div className="scrollbar-none -mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto px-1">
            {TAB_KEYS.map((key) => (
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
                <DropdownMenuItem onSelect={switchProject}>
                  <Building2 className="size-4" />
                  {t('project.switch')}
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
            <ProfileMenu
              me={me.data}
              projectId={id}
              isAdmin={project.data?.myRole === 'owner' || project.data?.myRole === 'admin'}
            />
          </div>
        </nav>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet context={{ project: project.data, meId: me.data?.id } satisfies ProjectOutletCtx} />
        </main>
      </div>

      {/*
        Кнопка «Рабочая область» поверх чата (мобильный). Нижней панели с двумя
        вкладками нет намеренно: чат — основа приложения, а задачи/файлы
        открываются поверх него и закрываются стрелкой назад.
      */}
      {mobileView === 'chat' && (
        <button
          onClick={() => setMobileView('work')}
          className="fixed bottom-20 end-4 z-20 flex items-center gap-2 rounded-full bg-brand px-4 py-2.5 text-sm font-semibold text-brand-foreground shadow-lg md:hidden"
        >
          <LayoutGrid className="size-4" />
          {t('project.mobile.work')}
        </button>
      )}
    </div>
  )
}

export function useProjectCtx() {
  return useOutletContext<ProjectOutletCtx>()
}
