import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  CalendarDays,
  ChevronDown,
  Circle,
  CircleCheck,
  CircleDot,
  Eye,
  Flag,
  Plus,
  Search,
  Trash2,
  User,
  X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckItem,
} from '@/components/ui/dropdown-menu'

const STATUSES = ['todo', 'in_progress', 'review', 'done'] as const
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
type Status = (typeof STATUSES)[number]
type Priority = (typeof PRIORITIES)[number]

type Task = {
  id: string
  number: string
  title: string
  description: string
  status: Status
  priority: Priority
  dueDate: string | null
  assignee: { id: string; name: string; avatarUrl: string | null } | null
  createdById: string | null
  createdAt: string
}
type Member = { id: string; role: string; user: { id: string; name: string; email: string; avatarUrl: string | null } }

const STATUS_ICON: Record<Status, typeof Circle> = {
  todo: Circle,
  in_progress: CircleDot,
  review: Eye,
  done: CircleCheck,
}
const PRIORITY_COLOR: Record<Priority, string> = {
  low: 'text-muted-foreground',
  normal: 'text-foreground/70',
  high: 'text-orange-400',
  urgent: 'text-destructive',
}

function isOverdue(t: Task) {
  return t.dueDate && t.status !== 'done' && new Date(t.dueDate).getTime() < Date.now()
}

// Таб «Задачи»: лёгкий список по статусам, фильтры-чипсы, инлайн-редакторы (SPEC §4.3 — права)
export function TasksTab({ projectId, meId }: { projectId: string; meId?: string }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [q, setQ] = useState('')
  const [onlyMine, setOnlyMine] = useState(false)
  const [statusFilter, setStatusFilter] = useState<Status | null>(null)
  const [priorityFilter, setPriorityFilter] = useState<Priority | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  const tasksQ = useQuery({
    queryKey: ['tasks', projectId],
    queryFn: () => api<Task[]>('/api/v1/tasks', {}, 'project'),
  })
  const membersQ = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => api<Member[]>(`/api/v1/projects/${projectId}/members`),
  })

  const onErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))
  const refresh = () => qc.invalidateQueries({ queryKey: ['tasks', projectId] })

  const create = useMutation({
    mutationFn: (title: string) => api<Task>('/api/v1/tasks', { method: 'POST', body: JSON.stringify({ title }) }, 'project'),
    onSuccess: () => {
      setNewTitle('')
      refresh()
    },
    onError: onErr,
  })

  const patch = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'dueDate'>> & { assigneeId?: string | null }) =>
      api<Task>(`/api/v1/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, 'project'),
    onSuccess: refresh,
    onError: onErr,
  })

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/tasks/${id}`, { method: 'DELETE' }, 'project'),
    onSuccess: refresh,
    onError: onErr,
  })

  const filtered = useMemo(() => {
    let list = tasksQ.data ?? []
    if (onlyMine && meId) list = list.filter((task) => task.assignee?.id === meId)
    if (statusFilter) list = list.filter((task) => task.status === statusFilter)
    if (priorityFilter) list = list.filter((task) => task.priority === priorityFilter)
    const needle = q.trim().toLowerCase()
    if (needle) list = list.filter((task) => task.title.toLowerCase().includes(needle) || task.number.toLowerCase().includes(needle))
    return list
  }, [tasksQ.data, onlyMine, meId, statusFilter, priorityFilter, q])

  const groups = useMemo(() => {
    const visible: Status[] = statusFilter ? [statusFilter] : showDone ? [...STATUSES] : STATUSES.filter((s) => s !== 'done')
    return visible
      .map((s) => ({ status: s, tasks: filtered.filter((task) => task.status === s) }))
      .filter((g) => g.tasks.length > 0 || g.status === 'todo')
  }, [filtered, statusFilter, showDone])

  const doneCount = (tasksQ.data ?? []).filter((task) => task.status === 'done').length

  return (
    <div className="mx-auto max-w-3xl p-6">
      {/* Быстрое создание */}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (newTitle.trim()) create.mutate(newTitle.trim())
        }}
      >
        <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder={t('tasks.newPlaceholder')} />
        <Button variant="brand" type="submit" disabled={!newTitle.trim() || create.isPending}>
          <Plus className="size-4" />
          {t('start.create')}
        </Button>
      </form>

      {/* Фильтры-чипсы */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Chip active={onlyMine} onClick={() => setOnlyMine((v) => !v)}>
          <User className="size-3" />
          {t('tasks.mine')}
        </Chip>
        {STATUSES.map((s) => (
          <Chip key={s} active={statusFilter === s} onClick={() => setStatusFilter(statusFilter === s ? null : s)}>
            {t(`tasks.status.${s}`)}
          </Chip>
        ))}
        {PRIORITIES.map((p) => (
          <Chip key={p} active={priorityFilter === p} onClick={() => setPriorityFilter(priorityFilter === p ? null : p)}>
            <Flag className={cn('size-3', PRIORITY_COLOR[p])} />
            {t(`tasks.priority.${p}`)}
          </Chip>
        ))}
        <div className="relative ms-auto w-44">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('tasks.search')} className="h-8 ps-8 text-xs" />
        </div>
      </div>

      {/* Группы по статусам */}
      <div className="mt-5 space-y-6">
        {tasksQ.isLoading && <p className="text-sm text-muted-foreground">…</p>}
        {groups.map(({ status, tasks: list }) => {
          const Icon = STATUS_ICON[status]
          return (
            <section key={status}>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                <Icon className={cn('size-4', status === 'done' && 'text-brand')} />
                {t(`tasks.status.${status}`)}
                <span className="tabular-nums">({list.length})</span>
              </h3>
              <ul className="space-y-1">
                {list.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    members={membersQ.data ?? []}
                    lang={i18n.language}
                    expanded={expanded === task.id}
                    onToggle={() => setExpanded(expanded === task.id ? null : task.id)}
                    onPatch={(body) => patch.mutate({ id: task.id, ...body })}
                    onDelete={async () => {
                      if (await confirm({ title: t('tasks.deleteConfirm', { number: task.number }), destructive: true, confirmLabel: t('files.delete') }))
                        remove.mutate(task.id)
                    }}
                  />
                ))}
                {list.length === 0 && <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">{t('tasks.emptyGroup')}</p>}
              </ul>
            </section>
          )
        })}
        {!statusFilter && doneCount > 0 && (
          <button onClick={() => setShowDone((v) => !v)} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
            {showDone ? t('tasks.hideDone') : t('tasks.showDone', { count: doneCount })}
          </button>
        )}
      </div>
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors',
        active ? 'border-brand bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function TaskRow({
  task,
  members,
  lang,
  expanded,
  onToggle,
  onPatch,
  onDelete,
}: {
  task: Task
  members: Member[]
  lang: string
  expanded: boolean
  onToggle: () => void
  onPatch: (body: Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'dueDate'>> & { assigneeId?: string | null }) => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const overdue = isOverdue(task)
  const StatusIcon = STATUS_ICON[task.status]

  return (
    <li className="rounded-lg border bg-card">
      <div className="flex items-center gap-2.5 px-3 py-2">
        {/* Статус — дропдаун по иконке */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button title={t(`tasks.status.${task.status}`)} className="shrink-0">
              <StatusIcon className={cn('size-4.5', task.status === 'done' ? 'text-brand' : 'text-muted-foreground hover:text-foreground')} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {STATUSES.map((s) => {
              const Icon = STATUS_ICON[s]
              return (
                <DropdownMenuCheckItem key={s} checked={s === task.status} onSelect={() => onPatch({ status: s })}>
                  <Icon className="size-3.5" />
                  {t(`tasks.status.${s}`)}
                </DropdownMenuCheckItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <button onClick={onToggle} className="min-w-0 flex-1 text-start">
          <span className={cn('block truncate text-sm', task.status === 'done' && 'text-muted-foreground line-through')}>
            <span className="me-1.5 text-xs text-muted-foreground">{task.number}</span>
            {task.title}
          </span>
        </button>

        {/* Приоритет */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button title={t(`tasks.priority.${task.priority}`)} className="shrink-0">
              <Flag className={cn('size-3.5', PRIORITY_COLOR[task.priority])} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {PRIORITIES.map((p) => (
              <DropdownMenuCheckItem key={p} checked={p === task.priority} onSelect={() => onPatch({ priority: p })}>
                <Flag className={cn('size-3.5', PRIORITY_COLOR[p])} />
                {t(`tasks.priority.${p}`)}
              </DropdownMenuCheckItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Дедлайн */}
        <label
          className={cn(
            'relative inline-flex shrink-0 cursor-pointer items-center gap-1 text-xs',
            overdue ? 'text-destructive' : task.dueDate ? 'text-muted-foreground' : 'text-muted-foreground/50',
          )}
          title={t('tasks.due')}
        >
          <CalendarDays className="size-3.5" />
          {task.dueDate && new Date(task.dueDate).toLocaleDateString(lang, { day: 'numeric', month: 'short' })}
          <input
            type="date"
            value={task.dueDate ? task.dueDate.slice(0, 10) : ''}
            onChange={(e) => onPatch({ dueDate: e.target.value ? new Date(e.target.value + 'T12:00:00').toISOString() : null })}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>

        {/* Ассайни */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="shrink-0" title={task.assignee?.name ?? t('tasks.unassigned')}>
              {task.assignee ? (
                task.assignee.avatarUrl ? (
                  <img src={task.assignee.avatarUrl} alt="" className="size-6 rounded-full" referrerPolicy="no-referrer" />
                ) : (
                  <span className="grid size-6 place-items-center rounded-full bg-secondary text-[10px] font-semibold">
                    {task.assignee.name[0]?.toUpperCase()}
                  </span>
                )
              ) : (
                <span className="grid size-6 place-items-center rounded-full border border-dashed text-muted-foreground">
                  <User className="size-3" />
                </span>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onPatch({ assigneeId: null })}>
              <X className="size-3.5" />
              {t('tasks.unassigned')}
            </DropdownMenuItem>
            {members.map((m) => (
              <DropdownMenuCheckItem key={m.user.id} checked={task.assignee?.id === m.user.id} onSelect={() => onPatch({ assigneeId: m.user.id })}>
                {m.user.name || m.user.email}
              </DropdownMenuCheckItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <button onClick={onToggle} className="shrink-0 text-muted-foreground hover:text-foreground">
          <ChevronDown className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
        </button>
      </div>

      {expanded && (
        <TaskDetails task={task} onPatch={onPatch} onDelete={onDelete} />
      )}
    </li>
  )
}

function TaskDetails({
  task,
  onPatch,
  onDelete,
}: {
  task: Task
  onPatch: (body: Partial<Pick<Task, 'title' | 'description'>>) => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const dirty = title !== task.title || description !== task.description

  return (
    <div className="space-y-2 border-t px-3 py-3">
      <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
        placeholder={t('tasks.descriptionPlaceholder')}
        className="w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
      />
      <div className="flex items-center justify-between">
        <Button variant="destructive" size="sm" onClick={onDelete}>
          <Trash2 className="size-3.5" />
          {t('files.delete')}
        </Button>
        {dirty && (
          <Button variant="brand" size="sm" onClick={() => onPatch({ title: title.trim() || task.title, description })}>
            {t('projectForm.save')}
          </Button>
        )}
      </div>
    </div>
  )
}
