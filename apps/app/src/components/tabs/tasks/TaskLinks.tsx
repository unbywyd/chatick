import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { GitBranch, Link2, Plus, Split, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { StatusBadge } from './StatusBadge'
import { TaskPickerDialog } from './TaskPickerDialog'
import type { LinkedTask } from './TaskBlockedMark'

// Связанные задачи в карточке.
//
// Это НЕ блокеры, и рядом они стоят намеренно порознь: блокер говорит «ещё
// рано», связь — «посмотри и сюда». Ни замочка, ни приглушения строки, ни
// влияния на «с чего начать» здесь нет и быть не должно.
//
// Типичный случай, ради которого всё это: заказчик оставил замечания одной
// задачей, из неё разобрали пять. Без связи через неделю, открыв любую из
// пяти, не понять, откуда она взялась.

type Links = { derivedFrom: LinkedTask[]; derivedInto: LinkedTask[]; related: LinkedTask[] }

/** Что именно добавляем: вид связи плюс направление для derived. */
type Picking = { kind: 'derived' | 'related'; direction: 'from' | 'into' }

export function TaskLinks({
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
  const [picking, setPicking] = useState<Picking | null>(null)

  const q = useQuery({
    queryKey: ['task-links', taskId],
    queryFn: () => api<Links>(`/api/v1/tasks/${taskId}/links`, {}, 'project'),
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['task-links', taskId] })
    qc.invalidateQueries({ queryKey: ['task-candidates', 'links', taskId] })
  }

  const add = useMutation({
    mutationFn: ({ ids, kind, direction }: { ids: string[] } & Picking) =>
      api(
        `/api/v1/tasks/${taskId}/links`,
        { method: 'POST', body: JSON.stringify({ taskIds: ids, kind, direction }) },
        'project',
      ),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const remove = useMutation({
    mutationFn: (linkId: string) => api(`/api/v1/tasks/${taskId}/links/${linkId}`, { method: 'DELETE' }, 'project'),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const derivedFrom = q.data?.derivedFrom ?? []
  const derivedInto = q.data?.derivedInto ?? []
  const related = q.data?.related ?? []
  const total = derivedFrom.length + derivedInto.length + related.length

  // Пусто и править нельзя — секции в карточке не место.
  if (!canEdit && !total) return null

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <Group
        icon={<GitBranch className="size-3.5" />}
        title={t('links.derivedFrom')}
        empty={t('links.noDerivedFrom')}
        items={derivedFrom}
        canEdit={canEdit}
        onAdd={() => setPicking({ kind: 'derived', direction: 'from' })}
        onRemove={(linkId) => remove.mutate(linkId)}
        onOpenTask={onOpenTask}
      />
      <div className="border-t" />
      <Group
        icon={<Split className="size-3.5" />}
        title={t('links.derivedInto')}
        empty={t('links.noDerivedInto')}
        items={derivedInto}
        canEdit={canEdit}
        onAdd={() => setPicking({ kind: 'derived', direction: 'into' })}
        onRemove={(linkId) => remove.mutate(linkId)}
        onOpenTask={onOpenTask}
      />
      <div className="border-t" />
      <Group
        icon={<Link2 className="size-3.5" />}
        title={t('links.related')}
        empty={t('links.noRelated')}
        items={related}
        canEdit={canEdit}
        onAdd={() => setPicking({ kind: 'related', direction: 'from' })}
        onRemove={(linkId) => remove.mutate(linkId)}
        onOpenTask={onOpenTask}
      />

      {picking && (
        <TaskPickerDialog
          taskId={taskId}
          source="links"
          title={t('links.pickTitle')}
          onClose={() => setPicking(null)}
          onPick={(ids) => add.mutate({ ids, ...picking })}
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
            {t('links.add')}
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
            {/* dir=ltr + изоляция: иначе на иврите номер и заголовок меняются
                местами — соседние латинские куски переставляются как единое
                целое, и «TASK-12 Починить вход» читается наоборот. */}
            <span dir="ltr" className="shrink-0 text-[11px] tabular-nums text-muted-foreground [unicode-bidi:isolate]">
              {x.number}
            </span>
            <span
              className={cn('min-w-0 flex-1 truncate text-sm', x.status === 'done' && 'text-muted-foreground line-through')}
            >
              <bdi>{x.title}</bdi>
            </span>
          </button>
          <StatusBadge status={x.status} size="sm" withIcon={false} />
          {x.assignee && <Avatar name={x.assignee.name} src={x.assignee.avatarUrl} size={18} />}
          {canEdit && (
            <button
              type="button"
              title={t('links.remove')}
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
