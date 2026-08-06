import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Lock, TriangleAlert } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { StatusBadge } from './StatusBadge'
import type { Status } from './types'

// Значок зависимостей у задачи (SPEC §8.6).
//
// Две стороны одной связи, и обе важны по-разному:
//   замочек        — задача ЖДЁТ другие, брать её в работу рано;
//   восклицательный — задача ДЕРЖИТ другие, делать её надо первой.
//
// Считаем незакрытые блокеры, а не все: связь переживает завершение, поэтому
// замочек должен гаснуть сам, когда всё, чего задача ждала, сделано.

export type LinkedTask = {
  id: string
  number: string
  title: string
  status: Status
  refs?: string
  assignee: { id: string; name: string; avatarUrl: string | null } | null
  linkId: string
}

export function TaskBlockedMark({
  taskId,
  blockedBy = 0,
  blocking = 0,
  onOpenTask,
  className,
}: {
  taskId: string
  blockedBy?: number
  blocking?: number
  onOpenTask?: (id: string) => void
  className?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  // Связи подтягиваем только когда открыли: держать их для каждой строки
  // таблицы значило бы запрос на задачу — ровно то, чего мы избегали в списке.
  const q = useQuery({
    queryKey: ['task-blockers', taskId],
    enabled: open,
    queryFn: () => api<{ blockers: LinkedTask[]; blocking: LinkedTask[] }>(`/api/v1/tasks/${taskId}/blockers`, {}, 'project'),
  })

  if (!blockedBy && !blocking) return null

  // Ждёт — важнее: это про «нельзя брать сейчас». Держит — про очерёдность.
  const waiting = blockedBy > 0
  const Icon = waiting ? Lock : TriangleAlert
  const count = waiting ? blockedBy : blocking

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={waiting ? t('blockers.waitingHint', { count: blockedBy }) : t('blockers.holdingHint', { count: blocking })}
          onClick={(e) => e.stopPropagation()} // клик по строке открывает задачу
          className={cn(
            'inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[11px] font-medium transition-colors',
            waiting
              ? 'text-muted-foreground hover:bg-accent'
              : 'text-orange-600 hover:bg-orange-500/10 dark:text-orange-400',
            className,
          )}
        >
          <Icon className="size-3.5" />
          <span className="tabular-nums">{count}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0" onClick={(e) => e.stopPropagation()}>
        {/* Скролл: у задачи в середине цепочки зависимостей бывает десяток. */}
        <div className="max-h-72 overflow-y-auto p-2">
          {q.isLoading && <p className="px-1 py-2 text-xs text-muted-foreground">…</p>}
          {q.data && (
            <>
              <LinkGroup
                title={t('blockers.waitingFor')}
                items={q.data.blockers}
                onOpenTask={onOpenTask}
                emptyHidden
              />
              {q.data.blockers.length > 0 && q.data.blocking.length > 0 && <div className="my-2 border-t" />}
              <LinkGroup
                title={t('blockers.holding')}
                items={q.data.blocking}
                onOpenTask={onOpenTask}
                emptyHidden
              />
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function LinkGroup({
  title,
  items,
  onOpenTask,
  emptyHidden,
}: {
  title: string
  items: LinkedTask[]
  onOpenTask?: (id: string) => void
  emptyHidden?: boolean
}) {
  if (!items.length && emptyHidden) return null
  return (
    <div className="space-y-0.5">
      <p className="px-1 pb-1 text-[11px] font-medium text-muted-foreground">{title}</p>
      {items.map((x) => (
        <button
          key={x.id}
          type="button"
          onClick={() => onOpenTask?.(x.id)}
          className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-start transition-colors hover:bg-accent"
        >
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{x.number}</span>
          <span className="min-w-0 flex-1 truncate text-xs">{x.title}</span>
          <StatusBadge status={x.status} size="sm" withIcon={false} />
        </button>
      ))}
    </div>
  )
}
