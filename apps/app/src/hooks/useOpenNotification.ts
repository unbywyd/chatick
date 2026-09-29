import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api, type Company, type ProjectListItem } from '@/lib/api'

// Переход по уведомлению — общий для колокольчика и страницы уведомлений
// (SPEC §8.22). Уведомления приходят из всех проектов сразу; ссылку чужого
// проекта приводим к нынешнему адресу (с компанией) и просто переходим.

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
//
// Сервер теперь пишет ссылки с компанией — /c/<company>/p/<id>/..., — но в
// базе остались уведомления в старом формате. Дописываем компанию им, в
// единственном месте, через которое проходят все переходы по уведомлениям.
export function normalizeLink(link: string, projectId: string, companyId?: string): string {
  const base = `/c/${companyId ?? ''}/p/${projectId}`
  if (!link) return `${base}/tasks`
  // Новый формат — уже готов, трогать нечего.
  if (link.startsWith('/c/')) return link
  // хвост после /p/<id>: вкладка с параметрами либо пусто у старых ссылок
  const m = link.match(/^\/p\/([^/?]+)(\/[^?]*)?(\?.*)?$/)
  if (!m) return link
  const tail = m[2] && m[2] !== '/' ? m[2] : '/chat'
  return `/c/${companyId ?? ''}/p/${m[1]}${tail}${m[3] ?? ''}`
}

export function useOpenNotification() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()

  // Уведомления приходят из всех компаний сразу, а сервер отдаёт их без
  // компании — адрес же её требует. Собираем «проект → компания» из списков
  // проектов каждой своей компании: другого способа узнать её на клиенте нет.
  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<{ companies: Company[] }>('/api/v1/companies'),
  })
  const companyIds = (companies.data?.companies ?? []).map((c) => c.id)
  const projectCompany = useQuery({
    queryKey: ['project-company', companyIds.join(',')],
    enabled: companyIds.length > 0,
    queryFn: async () => {
      const lists = await Promise.all(
        companyIds.map((id) =>
          api<ProjectListItem[]>(`/api/v1/projects?companyId=${id}`)
            .then((list) => list.map((p) => [p.id, id] as const))
            // Одна недоступная компания не должна ломать переходы в остальные.
            .catch(() => [] as (readonly [string, string])[]),
        ),
      )
      return new Map(lists.flat())
    },
    staleTime: 5 * 60_000,
  })
  const companyOf = (projectId: string) => projectCompany.data?.get(projectId)

  const markRead = useMutation({
    mutationFn: (body: { ids?: string[]; projectId?: string; all?: boolean; companyId?: string }) =>
      api('/api/v1/inbox/read', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inbox'] })
      qc.invalidateQueries({ queryKey: ['sidebar-projects'] })
      qc.invalidateQueries({ queryKey: ['projects'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const openNotification = async (n: InboxNotification) => {
    try {
      // В другой проект — просто переход: проект называется адресом, токен
      // менять незачем, и перезагрузка страницы больше не нужна.
      markRead.mutate({ ids: [n.id] })
      navigate(normalizeLink(n.link, n.projectId, companyOf(n.projectId)))
    } catch {
      toast.error(t('inbox.openFailed'))
    }
  }

  const openProject = (projectId: string) => {
    navigate(`/c/${companyOf(projectId) ?? ''}/p/${projectId}/tasks`)
  }

  return { openNotification, openProject, markRead }
}
