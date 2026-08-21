import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { ProjectBadge } from '@/components/ui/project-badge'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * Мои задачи по всем проектам компании — вид панели рядом с чатом и ИИ.
 *
 * Панель при переключении проекта не размонтируется (у ProjectLayout нет key),
 * а её данные живут на session-токене и переживают сброс проектного кэша.
 * Поэтому клик по задаче не мигает списком: слева всё стоит на месте, справа
 * открывается задача.
 */

type MyTask = {
  id: string
  number: string
  title: string
  status: string
  priority: string
  dueDate: string | null
  createdAt: string
  projectId: string
  author: { id: string; name: string; avatarUrl: string | null } | null
  project: { id: string; name: string; color: string; logoUrl: string | null } | null
}

/** Просрочка в днях, если срок прошёл. */
function overdueDays(due: string | null): number {
  if (!due) return 0
  const ms = Date.now() - new Date(due).getTime()
  return ms > 0 ? Math.floor(ms / 86_400_000) : 0
}

export function MyTasksPanel({ onOpen }: { onOpen?: () => void }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { companyId, id: projectId } = useParams()

  const q = useQuery({
    queryKey: ['my-tasks', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ items: MyTask[] }>(`/api/v1/my/tasks?companyId=${companyId}`),
    // Задачи назначают и закрывают, пока человек смотрит в панель.
    refetchInterval: 60_000,
  })

  const items = q.data?.items ?? []

  // Скелетон вместо многоточия: панель открыта по умолчанию, и первое, что
  // человек видит при входе, не должно быть пустым местом.
  if (q.isLoading)
    return (
      <ul className="space-y-1 p-2" aria-hidden>
        {[92, 76, 84].map((w, i) => (
          <li key={i} className="rounded-lg border bg-card p-2.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-2 h-4" style={{ width: `${w}%` }} />
            <Skeleton className="mt-2 h-3 w-16" />
          </li>
        ))}
      </ul>
    )

  if (!items.length) {
    return (
      <div className="p-6 text-center">
        <p className="text-sm font-medium">{t('myTasks.emptyTitle')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t('myTasks.emptyText')}</p>
      </div>
    )
  }

  return (
    <ul className="space-y-1 p-2">
      {items.map((task) => {
        const late = overdueDays(task.dueDate)
        // Открытая задача подсвечена: в длинном списке иначе теряешь место,
        // с которого ушёл.
        const here = task.projectId === projectId
        return (
          <li key={task.id}>
            <button
              type="button"
              onClick={() => {
                navigate(`/c/${companyId}/p/${task.projectId}/tasks/${task.id}`)
                onOpen?.()
              }}
              className={cn(
                'w-full rounded-lg border p-2.5 text-start transition-colors hover:bg-accent',
                here ? 'border-brand/40 bg-accent/40' : 'bg-card',
              )}
            >
              <div className="flex items-center gap-2">
                {task.project && (
                  <ProjectBadge
                    name={task.project.name}
                    color={task.project.color}
                    logoUrl={task.project.logoUrl}
                    size={18}
                  />
                )}
                <span className="truncate text-[11px] text-muted-foreground">{task.project?.name}</span>
                <span className="ms-auto shrink-0 font-mono text-[10px] text-muted-foreground">{task.number}</span>
              </div>

              <p className="mt-1 line-clamp-2 text-sm leading-snug">{task.title}</p>

              <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                {/* Кто поставил: в чужой задаче это первое, что хочется знать. */}
                {task.author && (
                  <Avatar name={task.author.name} src={task.author.avatarUrl} size={16} title={task.author.name} />
                )}
                <span>{new Date(task.createdAt).toLocaleDateString(i18n.language)}</span>
                {late > 0 && (
                  <span className="ms-auto shrink-0 rounded-full bg-destructive/10 px-1.5 py-0.5 font-medium text-destructive">
                    {t('myTasks.overdue', { count: late })}
                  </span>
                )}
              </div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
