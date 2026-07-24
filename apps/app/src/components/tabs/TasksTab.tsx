import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { CalendarDays, Flag, LayoutList, Paperclip, Plus, Search, Table2, Timer, User, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckItem,
} from '@/components/ui/dropdown-menu'
import { TaskDrawer } from './tasks/TaskDrawer'
import { TasksTable } from './tasks/TasksTable'
import { STATUSES, PRIORITIES, STATUS_ICON, STATUS_COLOR, PRIORITY_COLOR, isOverdue, fmtEstimate, type Task, type TaskGroup, type Member, type Status, type Priority } from './tasks/types'

// Таб «Задачи»: список по статусам + drawer с деталями и вложениями (SPEC §4.3 — права)
export function TasksTab({ projectId, meId }: { projectId: string; meId?: string }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [onlyMine, setOnlyMine] = useState(false)
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null) // фильтр по исполнителю
  const [statusFilter, setStatusFilter] = useState<Status | null>(null)
  const [priorityFilter, setPriorityFilter] = useState<Priority | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  // drawer открывается по URL: /p/:id/tasks/:taskId — прямые ссылки на задачу работают
  const navigate = useNavigate()
  const { taskId: openTaskId } = useParams()
  const setOpenTaskId = (taskId: string | null) =>
    navigate(taskId ? `/p/${projectId}/tasks/${taskId}` : `/p/${projectId}/tasks`)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<{ status: Status; beforeId: string | null } | null>(null)
  const [view, setView] = useState<'list' | 'table'>(() => (localStorage.getItem('tasksView') as 'list' | 'table') || 'list')
  const setViewPersist = (v: 'list' | 'table') => {
    setView(v)
    localStorage.setItem('tasksView', v)
  }

  const tasksQ = useQuery({
    queryKey: ['tasks', projectId],
    queryFn: () => api<Task[]>('/api/v1/tasks', {}, 'project'),
  })
  const membersQ = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => api<Member[]>(`/api/v1/projects/${projectId}/members`),
  })
  const groupsQ = useQuery({
    queryKey: ['task-groups', projectId],
    queryFn: () => api<TaskGroup[]>('/api/v1/tasks/groups', {}, 'project'),
  })

  const onErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))
  const refresh = () => qc.invalidateQueries({ queryKey: ['tasks', projectId] })

  // право редактировать: наличие tasks.edit у участника (owner/admin/member с write+)
  const canEdit = useMemo(() => {
    const me = (membersQ.data ?? []).find((m) => m.user.id === meId)
    return me?.role === 'owner' || me?.role === 'admin' || Boolean(me?.permissions?.['tasks.edit'])
  }, [membersQ.data, meId])

  const refreshGroups = () => qc.invalidateQueries({ queryKey: ['task-groups', projectId] })
  const createGroup = useMutation({
    mutationFn: (name: string) => api<TaskGroup>('/api/v1/tasks/groups', { method: 'POST', body: JSON.stringify({ name }) }, 'project'),
    onSuccess: refreshGroups,
    onError: onErr,
  })
  const patchGroup = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      api(`/api/v1/tasks/groups/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, 'project'),
    onSuccess: refreshGroups,
    onError: onErr,
  })
  const deleteGroup = useMutation({
    mutationFn: (id: string) => api(`/api/v1/tasks/groups/${id}`, { method: 'DELETE' }, 'project'),
    onSuccess: () => {
      refreshGroups()
      refresh()
    },
    onError: onErr,
  })
  const reorderGroups = (orderedIds: string[]) => {
    orderedIds.forEach((id, i) => patchGroup.mutate({ id, sortOrder: i }))
  }

  const create = useMutation({
    mutationFn: (title: string) => api<Task>('/api/v1/tasks', { method: 'POST', body: JSON.stringify({ title }) }, 'project'),
    onSuccess: (created) => {
      setNewTitle('')
      refresh()
      setOpenTaskId(created.id) // сразу открыть — заполнить детали/вложения
    },
    onError: onErr,
  })

  const patch = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      api<Task>(`/api/v1/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, 'project'),
    onSuccess: refresh,
    onError: onErr,
  })

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/tasks/${id}`, { method: 'DELETE' }, 'project'),
    onSuccess: () => {
      setOpenTaskId(null)
      refresh()
    },
    onError: onErr,
  })

  const filtered = useMemo(() => {
    let list = tasksQ.data ?? []
    if (onlyMine && meId) list = list.filter((task) => task.assignee?.id === meId)
    if (assigneeFilter) list = list.filter((task) => task.assignee?.id === assigneeFilter)
    if (statusFilter) list = list.filter((task) => task.status === statusFilter)
    if (priorityFilter) list = list.filter((task) => task.priority === priorityFilter)
    const needle = q.trim().toLowerCase()
    if (needle) list = list.filter((task) => task.title.toLowerCase().includes(needle) || task.number.toLowerCase().includes(needle))
    return list
  }, [tasksQ.data, onlyMine, meId, assigneeFilter, statusFilter, priorityFilter, q])

  const hasFilters = onlyMine || Boolean(assigneeFilter) || Boolean(statusFilter) || Boolean(priorityFilter) || q.trim().length > 0
  const resetFilters = () => {
    setOnlyMine(false)
    setAssigneeFilter(null)
    setStatusFilter(null)
    setPriorityFilter(null)
    setQ('')
  }

  // Прогресс реализации — относительно активных фильтров (SPEC §8.15).
  // Знаменатель — отфильтрованный набор с учётом выполненных (showDone не влияет на прогресс).
  const progress = useMemo(() => {
    // filtered уже не содержит done, если статус-фильтр не done — берём базовый набор с теми же фильтрами, но без исключения done
    let base = tasksQ.data ?? []
    if (onlyMine && meId) base = base.filter((task) => task.assignee?.id === meId)
    if (assigneeFilter) base = base.filter((task) => task.assignee?.id === assigneeFilter)
    if (priorityFilter) base = base.filter((task) => task.priority === priorityFilter)
    const needle = q.trim().toLowerCase()
    if (needle) base = base.filter((task) => task.title.toLowerCase().includes(needle) || task.number.toLowerCase().includes(needle))
    if (statusFilter && statusFilter !== 'done') base = base.filter((task) => task.status === statusFilter || task.status === 'done')
    const total = base.length
    const done = base.filter((task) => task.status === 'done').length
    return { total, done, pct: total ? Math.round((done / total) * 100) : 0 }
  }, [tasksQ.data, onlyMine, meId, assigneeFilter, statusFilter, priorityFilter, q])

  const groups = useMemo(() => {
    const visible: Status[] = statusFilter ? [statusFilter] : showDone ? [...STATUSES] : STATUSES.filter((s) => s !== 'done')
    return visible
      .map((s) => ({ status: s, tasks: filtered.filter((task) => task.status === s) }))
      .filter((g) => g.tasks.length > 0 || g.status === 'todo')
  }, [filtered, statusFilter, showDone])

  const doneCount = (tasksQ.data ?? []).filter((task) => task.status === 'done').length
  const openTask = tasksQ.data?.find((task) => task.id === openTaskId) ?? null

  // Drop: вычислить sortOrder между соседями целевой позиции и запатчить status+sortOrder
  const handleDrop = (status: Status, beforeId: string | null) => {
    setDropHint(null)
    const id = dragId
    setDragId(null)
    if (!id) return
    const group = (tasksQ.data ?? [])
      .filter((task) => task.status === status && task.id !== id)
      .sort((a, b) => a.sortOrder - b.sortOrder)
    const idx = beforeId ? group.findIndex((task) => task.id === beforeId) : group.length
    const prev = group[idx - 1]?.sortOrder
    const next = group[idx]?.sortOrder
    const sortOrder =
      prev !== undefined && next !== undefined ? (prev + next) / 2 : prev !== undefined ? prev + 1 : next !== undefined ? next - 1 : 0
    patch.mutate({ id, status, sortOrder })
  }

  return (
    <div className="relative h-full overflow-hidden">
      <div className={cn('h-full overflow-y-auto', openTask && 'pe-0 md:pe-[28rem]')}>
        <div className="mx-auto max-w-6xl p-6">
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

          {/* Прогресс реализации (по активным фильтрам) — SPEC §8.15 */}
          {progress.total > 0 && (
            <div className="mt-4">
              <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>{hasFilters ? t('tasks.progressFiltered') : t('tasks.progressAll')}: {progress.done}/{progress.total}</span>
                <span className="tabular-nums font-medium text-foreground">{progress.pct}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                <div className={cn('h-full transition-all', progress.pct === 100 ? 'bg-brand' : 'bg-brand/70')} style={{ width: `${progress.pct}%` }} />
              </div>
            </div>
          )}

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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors',
                    priorityFilter ? 'border-brand bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Flag className={cn('size-3', priorityFilter ? PRIORITY_COLOR[priorityFilter] : undefined)} />
                  {priorityFilter ? t(`tasks.priority.${priorityFilter}`) : t('tasks.priorityLabel')}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {PRIORITIES.map((p) => (
                  <DropdownMenuCheckItem key={p} checked={priorityFilter === p} onSelect={() => setPriorityFilter(priorityFilter === p ? null : p)}>
                    <Flag className={cn('size-3.5', PRIORITY_COLOR[p])} />
                    {t(`tasks.priority.${p}`)}
                  </DropdownMenuCheckItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {/* Фильтр по исполнителю */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors',
                    assigneeFilter ? 'border-brand bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <User className="size-3" />
                  {assigneeFilter
                    ? (membersQ.data?.find((m) => m.user.id === assigneeFilter)?.user.name ?? t('tasks.assigneeLabel'))
                    : t('tasks.assigneeLabel')}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {(membersQ.data ?? []).map((m) => (
                  <DropdownMenuCheckItem
                    key={m.user.id}
                    checked={assigneeFilter === m.user.id}
                    onSelect={() => setAssigneeFilter(assigneeFilter === m.user.id ? null : m.user.id)}
                  >
                    {m.user.name || m.user.email}
                  </DropdownMenuCheckItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {/* Сбросить все фильтры */}
            {hasFilters && (
              <button onClick={resetFilters} className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground" title={t('tasks.resetFilters')}>
                <X className="size-3" />
                {t('tasks.resetFilters')}
              </button>
            )}
            <div className="relative ms-auto w-44">
              <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('tasks.search')} className="h-8 ps-8 text-xs" />
            </div>
            {/* Переключатель Список / Таблица */}
            <div className="inline-flex overflow-hidden rounded-md border">
              <button
                onClick={() => setViewPersist('list')}
                title={t('tasks.viewList')}
                className={cn('px-2 py-1.5 transition-colors', view === 'list' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary')}
              >
                <LayoutList className="size-4" />
              </button>
              <button
                onClick={() => setViewPersist('table')}
                title={t('tasks.viewTable')}
                className={cn('px-2 py-1.5 transition-colors', view === 'table' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary')}
              >
                <Table2 className="size-4" />
              </button>
            </div>
          </div>

          {/* Табличный вид: вложенные таблицы по спринт-группам */}
          {view === 'table' && (
            <div className="mt-5">
              {tasksQ.isLoading && <p className="text-sm text-muted-foreground">…</p>}
              <TasksTable
                tasks={filtered}
                groups={groupsQ.data ?? []}
                members={membersQ.data ?? []}
                lang={i18n.language}
                canEdit={canEdit}
                openTaskId={openTaskId ?? null}
                onOpen={setOpenTaskId}
                onPatch={(id, body) => patch.mutate({ id, ...body })}
                onCreateGroup={(name) => createGroup.mutate(name)}
                onPatchGroup={(id, body) => patchGroup.mutate({ id, ...body })}
                onDeleteGroup={(id) => deleteGroup.mutate(id)}
                onReorderGroups={reorderGroups}
              />
            </div>
          )}

          {/* Списочный вид: по статусам */}
          {view === 'list' && (
          <div className="mt-5 space-y-6">
            {tasksQ.isLoading && <p className="text-sm text-muted-foreground">…</p>}
            {groups.map(({ status, tasks: list }) => {
              const Icon = STATUS_ICON[status]
              return (
                <section
                  key={status}
                  onDragOver={(e) => {
                    e.preventDefault()
                    // курсор над группой, но не над строкой → в конец группы
                    if (dropHint?.status !== status) setDropHint({ status, beforeId: null })
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    handleDrop(status, dropHint?.status === status ? dropHint.beforeId : null)
                  }}
                >
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                    <Icon className={cn('size-4', STATUS_COLOR[status])} />
                    {t(`tasks.status.${status}`)}
                    <span className="tabular-nums">({list.length})</span>
                  </h3>
                  <ul
                    className={cn(
                      'space-y-1 rounded-lg transition-colors',
                      dragId && dropHint?.status === status && 'bg-accent/30 p-1 outline-2 outline-dashed outline-brand/40',
                    )}
                  >
                    {list.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        lang={i18n.language}
                        active={openTaskId === task.id}
                        dragging={dragId === task.id}
                        dropBefore={dropHint?.status === status && dropHint.beforeId === task.id}
                        onOpen={() => setOpenTaskId(task.id)}
                        onStatus={(s) => patch.mutate({ id: task.id, status: s })}
                        onDragStart={() => setDragId(task.id)}
                        onDragEnd={() => {
                          setDragId(null)
                          setDropHint(null)
                        }}
                        onDragOverRow={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setDropHint({ status, beforeId: task.id })
                        }}
                        onDropRow={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          handleDrop(status, task.id)
                        }}
                      />
                    ))}
                    {list.length === 0 && (
                      <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">{t('tasks.emptyGroup')}</p>
                    )}
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
          )}
        </div>
      </div>

      {/* Drawer с деталями и вложениями */}
      {openTask && (
        <TaskDrawer
          task={openTask}
          members={membersQ.data ?? []}
          groups={groupsQ.data ?? []}
          meId={meId}
          canEdit={canEdit}
          onPatch={(body) => patch.mutate({ id: openTask.id, ...body })}
          onDelete={() => remove.mutate(openTask.id)}
          onClose={() => setOpenTaskId(null)}
        />
      )}
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

// Строка списка: draggable, статус-иконка (быстрый дропдаун) + название + компактные бейджи
function TaskRow({
  task,
  lang,
  active,
  dragging,
  dropBefore,
  onOpen,
  onStatus,
  onDragStart,
  onDragEnd,
  onDragOverRow,
  onDropRow,
}: {
  task: Task
  lang: string
  active: boolean
  dragging: boolean
  dropBefore: boolean
  onOpen: () => void
  onStatus: (s: Status) => void
  onDragStart: () => void
  onDragEnd: () => void
  onDragOverRow: (e: React.DragEvent) => void
  onDropRow: (e: React.DragEvent) => void
}) {
  const { t } = useTranslation()
  const overdue = isOverdue(task)
  const StatusIcon = STATUS_ICON[task.status]

  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'copyMove'
        // для D&D в чат: композер вставит ссылку на задачу
        e.dataTransfer.setData(
          'application/x-chatick-task',
          JSON.stringify({ id: task.id, number: task.number, title: task.title, projectId: window.location.hash.split('/')[2] }),
        )
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onDragOver={onDragOverRow}
      onDrop={onDropRow}
      className={cn(
        'group flex cursor-pointer items-center gap-2.5 rounded-lg border bg-card px-3 py-2 transition-colors hover:bg-accent/60',
        active && 'border-brand bg-accent',
        dragging && 'opacity-40',
        dropBefore && 'border-t-2 border-t-brand',
      )}
      onClick={onOpen}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button title={t(`tasks.status.${task.status}`)} className="shrink-0" onClick={(e) => e.stopPropagation()}>
            <StatusIcon className={cn('size-[18px] transition-colors', STATUS_COLOR[task.status])} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {STATUSES.map((s) => {
            const Icon = STATUS_ICON[s]
            return (
              <DropdownMenuCheckItem key={s} checked={s === task.status} onSelect={() => onStatus(s)}>
                <Icon className="size-3.5" />
                {t(`tasks.status.${s}`)}
              </DropdownMenuCheckItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <span className={cn('min-w-0 flex-1 truncate text-sm', task.status === 'done' && 'text-muted-foreground line-through')}>
        <span className="me-1.5 text-xs text-muted-foreground">{task.number}</span>
        {task.title}
      </span>

      {/* Компактные бейджи */}
      <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        {task.attachmentsCount > 0 && (
          <span className="inline-flex items-center gap-0.5">
            <Paperclip className="size-3" />
            {task.attachmentsCount}
          </span>
        )}
        {task.priority !== 'normal' && <Flag className={cn('size-3.5', PRIORITY_COLOR[task.priority])} />}
        {task.estimateMinutes ? (
          <span className="inline-flex items-center gap-0.5">
            <Timer className="size-3" />
            {fmtEstimate(task.estimateMinutes)}
          </span>
        ) : null}
        {task.dueDate && (
          <span className={cn('inline-flex items-center gap-0.5', overdue && 'font-medium text-destructive')}>
            <CalendarDays className="size-3" />
            {new Date(task.dueDate).toLocaleDateString(lang, { day: 'numeric', month: 'short' })}
          </span>
        )}
        {task.assignee &&
          (task.assignee.avatarUrl ? (
            <img src={task.assignee.avatarUrl} alt={task.assignee.name} title={task.assignee.name} className="size-5.5 rounded-full" referrerPolicy="no-referrer" />
          ) : (
            <span title={task.assignee.name} className="grid size-5.5 place-items-center rounded-full bg-secondary text-[10px] font-semibold text-foreground">
              {task.assignee.name[0]?.toUpperCase()}
            </span>
          ))}
      </span>
    </li>
  )
}
