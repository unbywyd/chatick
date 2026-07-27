import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api, setProjectToken } from '@/lib/api'

// Переход по уведомлению — общий для колокольчика и страницы уведомлений
// (SPEC §8.22). Логика неочевидная: у каждого проекта свой токен, и уйти в
// чужой проект по ссылке нельзя, не обменяв его.

export type InboxNotification = {
  id: string
  projectId: string
  projectName: string
  event: string
  title: string
  summary?: string | null
  body: string
  link: string
  entityType?: string | null
  entityId?: string | null
  readAt: string | null
  createdAt: string
  actor: { id: string; name: string; avatarUrl: string | null } | null
}

// Уведомления, созданные до появления вкладки /chat, ссылаются на /p/<id>?msg=<mid>.
// Такой путь падает на index-редирект, а он теряет query — дописываем /chat сами.
export function normalizeLink(link: string, projectId: string): string {
  if (!link) return `/p/${projectId}/tasks`
  const m = link.match(/^\/p\/([^/?]+)(\?.*)?$/)
  return m ? `/p/${m[1]}/chat${m[2] ?? ''}` : link
}

export function useOpenNotification(currentProjectId?: string) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const markRead = useMutation({
    mutationFn: (body: { ids?: string[]; projectId?: string; all?: boolean }) =>
      api('/api/v1/inbox/read', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inbox'] })
      qc.invalidateQueries({ queryKey: ['sidebar-projects'] })
      qc.invalidateQueries({ queryKey: ['projects'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  /** Войти в проект: обменять токен и перезагрузиться на нужном адресе. */
  const enterProject = async (projectId: string, path: string) => {
    const r = await api<{ token: string; project: { id: string } }>(`/api/v1/projects/${projectId}/enter`, {
      method: 'POST',
      body: JSON.stringify({ acceptRules: false }),
    })
    setProjectToken(r.token)
    window.location.hash = `#${path}`
    window.location.reload()
  }

  const openNotification = async (n: InboxNotification) => {
    try {
      if (n.projectId !== currentProjectId) {
        // Пометку ЖДЁМ: следом идёт reload, и незавершённый запрос просто
        // не успел бы уйти — уведомление оставалось непрочитанным.
        await markRead.mutateAsync({ ids: [n.id] })
        await enterProject(n.projectId, normalizeLink(n.link, n.projectId))
        return
      }
      markRead.mutate({ ids: [n.id] })
      navigate(normalizeLink(n.link, n.projectId))
    } catch {
      toast.error(t('inbox.openFailed'))
    }
  }

  const openProject = async (projectId: string) => {
    if (projectId === currentProjectId) {
      navigate(`/p/${projectId}/tasks`)
      return
    }
    try {
      await enterProject(projectId, `/p/${projectId}/tasks`)
    } catch {
      toast.error(t('inbox.openFailed'))
    }
  }

  return { openNotification, openProject, markRead }
}
