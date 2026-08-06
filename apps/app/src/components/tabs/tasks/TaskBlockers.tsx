import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Lock, Plus, TriangleAlert, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { StatusBadge } from './StatusBadge'
import { TaskPickerDialog } from './TaskPickerDialog'
import type { LinkedTask } from './TaskBlockedMark'

// Зависимости задачи в её карточке (SPEC §8.6).
//
// Два списка — две стороны одной связи: кого эта задача ждёт и кто ждёт её.
// Держим рядом: порядок работ читается только когда видно оба направления.

export function TaskBlockers({
  taskId,
  projectId,
  canEdit,
  onOpenTask,
}: {
  taskId: string
  projectId: string
  canEdit: boolean
  onOpenTask?: (id: string) => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [picking, setPicking] = useState<'blockers' | 'blocking' | null>(null)

  const q = useQuery({
    queryKey: ['task-blockers', taskId],
    queryFn: () => api<{ blockers: LinkedTask[]; blocking: LinkedTask[] }>(`/api/v1/tasks/${taskId}/blockers`, {}, 'project'),
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['task-blockers', taskId] })
    // Значки в таблице считаются вместе со списком задач — его тоже освежаем.
    qc.invalidateQueries({ queryKey: ['tasks', projectId] })
  }

  const add = useMutation({
    mutationFn: ({ ids, side }: { ids: string[]; side: 'blockers' | 'blocking' }) =>
      api(`/api/v1/tasks/${taskId}/blockers`, { method: 'POST', body: JSON.stringify({ taskIds: ids, side }) }, 'project'),
    onSuccess: refresh,
    // Кольцо сервер объясняет текстом — показываем его как есть, а не «ошибка».
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const remove = useMutation({
    mutationFn: (linkId: string) =>
      api(`/api/v1/tasks/${taskId}/blockers/${linkId}`, { method: 'DELETE' }, 'project'),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const blockers = q.data?.blockers ?? []
  const blocking = q.data?.blocking ?? []

  // Пусто и править нельзя — секции в карточке не место.
  if (!canEdit && !blockers.length && !blocking.length) return null

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <Group
        icon={<Lock className="size-3.5" />}
        title={t('blockers.blockedBy')}
        empty={t('blockers.noBlockers')}
        items={blockers}
        canEdit={canEdit}
        onAdd={() => setPicking('blockers')}
        onRemove={(linkId) => remove.mutate(linkId)}
        onOpenTask={onOpenTask}
      />
      <div className="border-t" />
      <Group
        icon={<TriangleAlert className="size-3.5 text-orange-500" />}
        title={t('blockers.blocks')}
        empty={t('blockers.noBlocking')}
        items={blocking}
        canEdit={canEdit}
        onAdd={() => setPicking('blocking')}
        onRemove={(linkId) => remove.mutate(linkId)}
        onOpenTask={onOpenTask}
      />

      {picking && (
        <TaskPickerDialog
          taskId={taskId}
          side={picking}
          onClose={() => setPicking(null)}
          onPick={(ids) => add.mutate({ ids, side: picking })}
        />
      )}
    </section>
  )
}

function Group({
  icon,
  title,
  empty,
  items,
  canEdit,
  onAdd,
  onRemove,
  onOpenTask,
}: {
  icon: React.ReactNode
  title: string
  empty: string
  items: LinkedTask[]
  canEdit: boolean
  onAdd: () => void
  onRemove: (linkId: string) => void
  onOpenTask?: (id: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          {icon}
          {title}
          {items.length > 0 && <span className="tabular-nums text-muted-foreground">({items.length})</span>}
        </h3>
        {canEdit && (
          <Button variant="ghost" size="sm" className="gap-1 text-xs" onClick={onAdd}>
            <Plus className="size-3.5" />
            {t('blockers.addBlocker')}
          </Button>
        )}
      </div>

      {!items.length && <p className="text-xs text-muted-foreground">{empty}</p>}

      {items.map((x) => (
        <div
          key={x.linkId}
          className="group flex items-center gap-2 rounded-md border px-2 py-1.5 transition-colors hover:bg-accent/50"
        >
          <button
            type="button"
            onClick={() => onOpenTask?.(x.id)}
            className="flex min-w-0 flex-1 items-center gap-2 text-start"
          >
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{x.number}</span>
            <span
              className={cn('min-w-0 flex-1 truncate text-sm', x.status === 'done' && 'text-muted-foreground line-through')}
            >
              {x.title}
            </span>
          </button>
          <StatusBadge status={x.status} size="sm" withIcon={false} />
          {x.assignee && <Avatar name={x.assignee.name} src={x.assignee.avatarUrl} size={18} />}
          {canEdit && (
            <button
              type="button"
              title={t('blockers.remove')}
              onClick={() => onRemove(x.linkId)}
              className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
