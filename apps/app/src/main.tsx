import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Routes, Route, Navigate, useParams } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import './index.css'
import './i18n'
import { ThemeProvider } from './providers/theme'
import { ConfirmProvider } from './components/ui/confirm'
import { ProjectLayout, useProjectCtx } from './screens/ProjectScreen'
import { LoginScreen, AuthCallback } from './screens/LoginScreen'
import { InviteScreen } from './screens/InviteScreen'
import { ConnectScreen } from './screens/ConnectScreen'
import { StartScreen } from './screens/StartScreen'
import { AboutTab } from './components/tabs/AboutTab'
import { TasksTab } from './components/tabs/TasksTab'
import { FilesTab } from './components/tabs/FilesTab'
import { ResourcesTab } from './components/tabs/ResourcesTab'
import { ProjectTeamTab } from './components/tabs/ProjectTeamTab'
import { NotificationsTab } from './components/tabs/NotificationsTab'
import { AiUsageTab } from './components/tabs/AiUsageTab'
import { HistoryTab } from './components/tabs/HistoryTab'
import { DocumentsTab } from './components/tabs/DocumentsTab'

// HashRouter — единый роутинг для веба и Electron (file://) без доп. настроек.
const queryClient = new QueryClient()

// Обёртки: тянут контекст layout'а (Outlet) и параметры URL
function AboutPage() {
  const { project } = useProjectCtx()
  return <AboutTab project={project} loading={!project} />
}
function TasksPage() {
  const { meId } = useProjectCtx()
  const { id } = useParams()
  return id ? <TasksTab projectId={id} meId={meId} /> : null
}
function FilesPage() {
  const { project } = useProjectCtx()
  const { id } = useParams()
  return id ? <FilesTab projectId={id} isAdmin={project?.myRole === 'owner' || project?.myRole === 'admin'} /> : null
}
function ResourcesPage() {
  const { project } = useProjectCtx()
  const { id } = useParams()
  return id ? <ResourcesTab projectId={id} isAdmin={project?.myRole === 'owner' || project?.myRole === 'admin'} /> : null
}
function TeamPage() {
  const { project } = useProjectCtx()
  const { id } = useParams()
  return id ? (
    <ProjectTeamTab
      projectId={id}
      companyId={project?.companyId}
      canEdit={project?.myRole === 'owner' || project?.myRole === 'admin'}
    />
  ) : null
}
function NotificationsPage() {
  const { project } = useProjectCtx()
  const { id } = useParams()
  return id ? (
    <NotificationsTab projectId={id} isAdmin={project?.myRole === 'owner' || project?.myRole === 'admin'} />
  ) : null
}
function AiPage() {
  const { project } = useProjectCtx()
  const { id } = useParams()
  return id ? <AiUsageTab projectId={id} isAdmin={project?.myRole === 'owner' || project?.myRole === 'admin'} /> : null
}
function DocumentsPage() {
  const { id } = useParams()
  return id ? <DocumentsTab projectId={id} /> : null
}
function HistoryPage() {
  const { project } = useProjectCtx()
  const { id } = useParams()
  return id ? <HistoryTab projectId={id} isAdmin={project?.myRole === 'owner' || project?.myRole === 'admin'} /> : null
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ConfirmProvider>
          <HashRouter>
            <Routes>
              <Route path="/" element={<LoginScreen />} />
              <Route path="/login" element={<LoginScreen />} />
              <Route path="/auth" element={<AuthCallback />} />
              {/* приём приглашения по ссылке из письма */}
              <Route path="/invite/:token" element={<InviteScreen />} />
              {/* подключение внешнего ИИ (Claude Code) — SPEC §8.27 */}
              <Route path="/connect" element={<ConnectScreen />} />
              {/* Компания и её табы адресуемы: /start/:companyId/(projects|team|settings) */}
              <Route path="/start" element={<StartScreen />} />
              <Route path="/start/:companyId" element={<StartScreen />} />
              <Route path="/start/:companyId/:companyTab" element={<StartScreen />} />
              <Route path="/p/:id" element={<ProjectLayout />}>
                <Route index element={<Navigate to="tasks" replace />} />
                <Route path="about" element={<AboutPage />} />
                {/* :taskId — прямая ссылка на задачу (drawer открыт по URL) */}
                <Route path="tasks/:taskId?" element={<TasksPage />} />
                <Route path="files" element={<FilesPage />} />
                <Route path="resources" element={<ResourcesPage />} />
                <Route path="team" element={<TeamPage />} />
                <Route path="notifications" element={<NotificationsPage />} />
                <Route path="ai" element={<AiPage />} />
                <Route path="history" element={<HistoryPage />} />
                <Route path="documents" element={<DocumentsPage />} />
              </Route>
            </Routes>
          </HashRouter>
        </ConfirmProvider>
        {/* Тоасты в токенах темы (richColors игнорирует тему и светит белым
            в тёмном интерфейсе). Снизу справа — чтобы не перекрывать шапку. */}
        <Toaster
          position="bottom-right"
          duration={3000}
          gap={8}
          offset={16}
          toastOptions={{
            unstyled: true,
            classNames: {
              toast:
                'group pointer-events-auto flex w-full items-center gap-2.5 rounded-lg border border-border bg-card px-3.5 py-2.5 text-sm text-card-foreground shadow-lg',
              title: 'font-medium',
              description: 'text-muted-foreground',
              icon: 'shrink-0',
              actionButton: 'ms-auto rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground',
              cancelButton: 'ms-auto rounded-md bg-secondary px-2 py-1 text-xs font-medium',
              closeButton: 'border-border bg-card text-muted-foreground',
              success: '[&_[data-icon]]:text-brand',
              error: 'border-destructive/40 [&_[data-icon]]:text-destructive',
              warning: '[&_[data-icon]]:text-amber-500',
              info: '[&_[data-icon]]:text-muted-foreground',
            },
          }}
        />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
