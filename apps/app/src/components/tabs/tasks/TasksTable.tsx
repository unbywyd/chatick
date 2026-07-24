import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronDown, ChevronUp, ChevronsUpDown, Flag, GripVertical, Paperclip, Pencil, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckItem,
} from '@/components/ui/dropdown-menu'
import { useConfirm } from '@/components/ui/confirm'
import {
  STATUSES,
  PRIORITIES,
  STATUS_ICON,
  STATUS_COLOR,
  PRIORITY_COLOR,
  isOverdue,
  fmtEstimate,
  type Task,
  type TaskGroup,
  type Member,
  type Status,
  type Priority,
} from './types'

// Табличный вид задач (SPEC §8.6): вложенные таблицы по группам-спринтам,
// сортировка по колонкам, инлайн-смена статуса/ассайни, drag строк и групп.

type SortKey = 'number' | 'title' | 'status' | 'priority' | 'estimate' | 'assignee' | 'dueDate'
type SortDir = 'asc' | 'desc'

const STATUS_RANK: Record<Status, number> = { todo: 0, in_progress: 1, review: 2, done: 3 }
const PRIORITY_RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2, urgent: 3 }

export function TasksTable({
  tasks,
  groups,
  members,
  lang,
  canEdit,
  openTaskId,
  onOpen,
  onPatch,
  onCreateGroup,
  onPatchGroup,
  onDeleteGroup,
  onReorderGroups,
}: {
  tasks: Task[]
  groups: TaskGroup[]
  members: Member[]
  lang: string
  canEdit: boolean
  openTaskId: string | null
  onOpen: (id: string) => void
  onPatch: (id: string, body: Record<string, unknown>) => void
  onCreateGroup: (name: string) => void
  onPatchGroup: (id: string, body: Record<string, unknown>) => void
  onDeleteGroup: (id: string) => void
  onReorderGroups: (orderedIds: string[]) => void
}) {
  const { t } = useTranslation()
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null)
  const [newGroup, setNewGroup] = useState('')
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s?.key === key ? (s.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' }))

  const sortTasks = (list: Task[]): Task[] => {
    if (!sort) return [...list].sort((a, b) => a.sortOrder - b.sortOrder)
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      let d = 0
      switch (sort.key) {
        case 'number':
          d = (parseInt(a.number.slice(5)) || 0) - (parseInt(b.number.slice(5)) || 0)
          break
        case 'title':
          d = a.title.localeCompare(b.title)
          break
        case 'status':
          d = STATUS_RANK[a.status] - STATUS_RANK[b.status]
          break
        case 'priority':
          d = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
          break
        case 'estimate':
          d = (a.estimateMinutes ?? Infinity) - (b.estimateMinutes ?? Infinity)
          break
        case 'assignee':
          d = (a.assignee?.name ?? '').localeCompare(b.assignee?.name ?? '')
          break
        case 'dueDate':
          d = (a.dueDate ? Date.parse(a.dueDate) : Infinity) - (b.dueDate ? Date.parse(b.dueDate) : Infinity)
          break
      }
      return d * dir
    })
  }

  // группировка задач: сначала группы по порядку, затем «без группы»
  const byGroup = useMemo(() => {
    const map = new Map<string | null, Task[]>()
    for (const g of groups) map.set(g.id, [])
    map.set(null, [])
    for (const task of tasks) {
      const key = task.groupId && map.has(task.groupId) ? task.groupId : null
      map.get(key)!.push(task)
    }
    return map
  }, [tasks, groups])

  const orderedGroups = [...groups].sort((a, b) => a.sortOrder - b.sortOrder)

  // drag: строки внутри/между группами ИЛИ порядок групп (по префиксу id)
  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const activeId = String(active.id)
    const overId = String(over.id)

    // перетаскивание групп
    if (activeId.startsWith('group:') && overId.startsWith('group:')) {
      const ids = orderedGroups.map((g) => g.id)
      const from = ids.indexOf(activeId.slice(6))
      const to = ids.indexOf(overId.slice(6))
      if (from >= 0 && to >= 0) onReorderGroups(arrayMove(ids, from, to))
      return
    }

    // перетаскивание задач: overId может быть task:<id> или dropzone:<groupId|none>
    if (!activeId.startsWith('task:')) return
    const taskId = activeId.slice(5)
    const task = tasks.find((x) => x.id === taskId)
    if (!task) return

    let targetGroupId: string | null
    let beforeTaskId: string | null = null
    if (overId.startsWith('task:')) {
      const overTask = tasks.find((x) => x.id === overId.slice(5))
      if (!overTask) return
      targetGroupId = overTask.groupId ?? null
      beforeTaskId = overTask.id
    } else if (overId.startsWith('dropzone:')) {
      const g = overId.slice(9)
      targetGroupId = g === 'none' ? null : g
    } else return

    // вычислить sortOrder среди задач целевой группы
    const groupTasks = sortTasks((byGroup.get(targetGroupId) ?? []).filter((x) => x.id !== taskId))
    const idx = beforeTaskId ? groupTasks.findIndex((x) => x.id === beforeTaskId) : groupTasks.length
    const prev = groupTasks[idx - 1]?.sortOrder
    const next = groupTasks[idx]?.sortOrder
    const sortOrder =
      prev !== undefined && next !== undefined ? (prev + next) / 2 : prev !== undefined ? prev + 1 : next !== undefined ? next - 1 : 0

    const patch: Record<string, unknown> = { sortOrder }
    if ((task.groupId ?? null) !== targetGroupId) patch.groupId = targetGroupId
    onPatch(taskId, patch)
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={orderedGroups.map((g) => `group:${g.id}`)} strategy={verticalListSortingStrategy}>
        <div className="space-y-5">
          {orderedGroups.map((g) => (
            <GroupTable
              key={g.id}
              group={g}
              tasks={sortTasks(byGroup.get(g.id) ?? [])}
              members={members}
              lang={lang}
              canEdit={canEdit}
              sort={sort}
              onToggleSort={toggleSort}
              openTaskId={openTaskId}
              onOpen={onOpen}
              onPatch={onPatch}
              onPatchGroup={onPatchGroup}
              onDeleteGroup={onDeleteGroup}
            />
          ))}

          {/* Задачи без группы */}
          <GroupTable
            group={null}
            tasks={sortTasks(byGroup.get(null) ?? [])}
            members={members}
            lang={lang}
            canEdit={canEdit}
            sort={sort}
            onToggleSort={toggleSort}
            openTaskId={openTaskId}
            onOpen={onOpen}
            onPatch={onPatch}
            onPatchGroup={onPatchGroup}
            onDeleteGroup={onDeleteGroup}
          />
        </div>
      </SortableContext>

      {canEdit && (
        <form
          className="mt-4 flex max-w-sm gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (newGroup.trim()) {
              onCreateGroup(newGroup.trim())
              setNewGroup('')
            }
          }}
        >
          <input
            value={newGroup}
            onChange={(e) => setNewGroup(e.target.value)}
            placeholder={t('tasks.newGroupPlaceholder')}
            className="h-9 flex-1 rounded-md border bg-transparent px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <Button variant="outline" type="submit" size="sm" disabled={!newGroup.trim()}>
            <Plus className="size-4" />
            {t('tasks.addGroup')}
          </Button>
        </form>
      )}
    </DndContext>
  )
}

function GroupTable({
  group,
  tasks,
  members,
  lang,
  canEdit,
  sort,
  onToggleSort,
  openTaskId,
  onOpen,
  onPatch,
  onPatchGroup,
  onDeleteGroup,
}: {
  group: TaskGroup | null
  tasks: Task[]
  members: Member[]
  lang: string
  canEdit: boolean
  sort: { key: SortKey; dir: SortDir } | null
  onToggleSort: (k: SortKey) => void
  openTaskId: string | null
  onOpen: (id: string) => void
  onPatch: (id: string, body: Record<string, unknown>) => void
  onPatchGroup: (id: string, body: Record<string, unknown>) => void
  onDeleteGroup: (id: string) => void
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(group?.name ?? '')

  // sortable-обёртка для строки-заголовка группы (перетаскивание групп)
  const sortable = useSortable({ id: group ? `group:${group.id}` : 'group:none', disabled: !group || !canEdit })
  const style = group ? { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition } : undefined

  // для «без группы» пустую секцию не показываем
  if (!group && tasks.length === 0) return null

  const cols: { key: SortKey; label: string; className?: string }[] = [
    { key: 'number', label: t('tasks.col.number'), className: 'w-20' },
    { key: 'title', label: t('tasks.col.title') },
    { key: 'status', label: t('tasks.col.status'), className: 'w-32' },
    { key: 'priority', label: t('tasks.col.priority'), className: 'w-10' },
    { key: 'estimate', label: t('tasks.col.estimate'), className: 'w-24' },
    { key: 'assignee', label: t('tasks.col.assignee'), className: 'w-40' },
    { key: 'dueDate', label: t('tasks.col.due'), className: 'w-24' },
  ]

  return (
    <section ref={group ? sortable.setNodeRef : undefined} style={style} className={cn(sortable.isDragging && 'opacity-50')}>
      <div className="mb-1.5 flex items-center gap-2">
        {group && canEdit && (
          <button className="cursor-grab text-muted-foreground hover:text-foreground" {...sortable.attributes} {...sortable.listeners}>
            <GripVertical className="size-4" />
          </button>
        )}
        {group ? (
          <>
            <span className="size-3 rounded-full" style={{ backgroundColor: group.color }} />
            {editing ? (
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => {
                  setEditing(false)
                  if (name.trim() && name !== group.name) onPatchGroup(group.id, { name: name.trim() })
                  else setName(group.name)
                }}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                className="h-7 rounded border bg-transparent px-2 text-sm font-semibold outline-none focus:ring-2 focus:ring-ring"
              />
            ) : (
              <h3 className="text-sm font-semibold">{group.name}</h3>
            )}
            <span className="text-xs tabular-nums text-muted-foreground">({tasks.length})</span>
            {canEdit && (
              <div className="flex items-center gap-0.5">
                <input
                  type="color"
                  value={group.color}
                  onChange={(e) => onPatchGroup(group.id, { color: e.target.value })}
                  title={t('tasks.groupColor')}
                  className="size-6 cursor-pointer rounded border-0 bg-transparent p-0"
                />
                <Button variant="ghost" size="icon" className="size-6" onClick={() => setEditing(true)} title={t('tasks.renameGroup')}>
                  <Pencil className="size-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  title={t('tasks.deleteGroup')}
                  onClick={async () => {
                    if (await confirm({ title: t('tasks.deleteGroupConfirm', { name: group.name }), destructive: true, confirmLabel: t('files.delete') }))
                      onDeleteGroup(group.id)
                  }}
                >
                  <Trash2 className="size-3 text-muted-foreground hover:text-destructive" />
                </Button>
              </div>
            )}
          </>
        ) : (
          <h3 className="text-sm font-semibold text-muted-foreground">{t('tasks.noGroup')}</h3>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
              {canEdit && <th className="w-6" />}
              {cols.map((col) => (
                <th key={col.key} className={cn('px-2 py-1.5 text-start font-medium', col.className)}>
                  <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => onToggleSort(col.key)}>
                    {col.label}
                    {sort?.key === col.key ? (
                      sort.dir === 'asc' ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />
                    ) : (
                      <ChevronsUpDown className="size-3 opacity-40" />
                    )}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <SortableContext items={tasks.map((task) => `task:${task.id}`)} strategy={verticalListSortingStrategy}>
            <tbody>
              {tasks.map((task) => (
                <TableRow
                  key={task.id}
                  task={task}
                  members={members}
                  lang={lang}
                  canEdit={canEdit}
                  active={openTaskId === task.id}
                  onOpen={() => onOpen(task.id)}
                  onPatch={onPatch}
                />
              ))}
              {tasks.length === 0 && (
                <DropRow groupId={group ? group.id : 'none'} colSpan={cols.length + (canEdit ? 1 : 0)} label={t('tasks.emptyGroup')} />
              )}
            </tbody>
          </SortableContext>
        </table>
      </div>
    </section>
  )
}

// Пустая drop-зона для перетаскивания в пустую группу
function DropRow({ groupId, colSpan, label }: { groupId: string; colSpan: number; label: string }) {
  const { setNodeRef, isOver } = useSortable({ id: `dropzone:${groupId}` })
  return (
    <tr ref={setNodeRef}>
      <td colSpan={colSpan} className={cn('px-3 py-3 text-center text-xs text-muted-foreground', isOver && 'bg-accent/40')}>
        {label}
      </td>
    </tr>
  )
}

function TableRow({
  task,
  members,
  lang,
  canEdit,
  active,
  onOpen,
  onPatch,
}: {
  task: Task
  members: Member[]
  lang: string
  canEdit: boolean
  active: boolean
  onOpen: () => void
  onPatch: (id: string, body: Record<string, unknown>) => void
}) {
  const { t } = useTranslation()
  const { setNodeRef, transform, transition, isDragging, attributes, listeners } = useSortable({ id: `task:${task.id}` })
  const style = { transform: CSS.Transform.toString(transform), transition }
  const StatusIcon = STATUS_ICON[task.status]
  const overdue = isOverdue(task)

  return (
    <tr
      ref={setNodeRef}
      style={style}
      className={cn('border-b last:border-0 transition-colors hover:bg-accent/40', active && 'bg-accent', isDragging && 'opacity-40')}
    >
      {canEdit && (
        <td className="w-6 ps-1">
          <button className="cursor-grab text-muted-foreground hover:text-foreground" {...attributes} {...listeners}>
            <GripVertical className="size-3.5" />
          </button>
        </td>
      )}
      <td className="px-2 py-1.5 align-middle text-xs text-muted-foreground">{task.number}</td>
      <td className="cursor-pointer px-2 py-1.5 align-middle" onClick={onOpen}>
        <span className={cn('line-clamp-1', task.status === 'done' && 'text-muted-foreground line-through')}>{task.title}</span>
        {task.attachmentsCount > 0 && (
          <span className="ms-1 inline-flex items-center gap-0.5 text-xs text-muted-foreground">
            <Paperclip className="size-3" />
            {task.attachmentsCount}
          </span>
        )}
      </td>
      {/* Инлайн-статус */}
      <td className="px-2 py-1.5 align-middle">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button disabled={!canEdit} className="inline-flex items-center gap-1.5 text-xs disabled:opacity-70">
              <StatusIcon className={cn('size-3.5', STATUS_COLOR[task.status])} />
              {t(`tasks.status.${task.status}`)}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {STATUSES.map((s) => {
              const Icon = STATUS_ICON[s]
              return (
                <DropdownMenuCheckItem key={s} checked={s === task.status} onSelect={() => onPatch(task.id, { status: s })}>
                  <Icon className="size-3.5" />
                  {t(`tasks.status.${s}`)}
                </DropdownMenuCheckItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
      {/* Приоритет-флаг */}
      <td className="px-2 py-1.5 text-center align-middle">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button disabled={!canEdit} title={t(`tasks.priority.${task.priority}`)} className="disabled:opacity-70">
              <Flag className={cn('size-3.5', PRIORITY_COLOR[task.priority])} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {PRIORITIES.map((p) => (
              <DropdownMenuCheckItem key={p} checked={p === task.priority} onSelect={() => onPatch(task.id, { priority: p })}>
                <Flag className={cn('size-3.5', PRIORITY_COLOR[p])} />
                {t(`tasks.priority.${p}`)}
              </DropdownMenuCheckItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
      {/* Инлайн-оценка времени */}
      <td className="px-2 py-1.5 align-middle text-xs">
        <EstimateCell mins={task.estimateMinutes} canEdit={canEdit} onSave={(m) => onPatch(task.id, { estimateMinutes: m })} />
      </td>
      {/* Инлайн-ассайни */}
      <td className="px-2 py-1.5 align-middle">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button disabled={!canEdit} className="inline-flex items-center gap-1.5 text-xs disabled:opacity-70">
              {task.assignee ? (
                <>
                  {task.assignee.avatarUrl ? (
                    <img src={task.assignee.avatarUrl} alt="" className="size-5 rounded-full" referrerPolicy="no-referrer" />
                  ) : (
                    <span className="grid size-5 place-items-center rounded-full bg-secondary text-[10px] font-semibold">
                      {task.assignee.name[0]?.toUpperCase()}
                    </span>
                  )}
                  <span className="line-clamp-1">{task.assignee.name}</span>
                </>
              ) : (
                <span className="text-muted-foreground">{t('tasks.unassigned')}</span>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuCheckItem checked={!task.assignee} onSelect={() => onPatch(task.id, { assigneeId: null })}>
              {t('tasks.unassigned')}
            </DropdownMenuCheckItem>
            {members.map((m) => (
              <DropdownMenuCheckItem key={m.user.id} checked={task.assignee?.id === m.user.id} onSelect={() => onPatch(task.id, { assigneeId: m.user.id })}>
                {m.user.name || m.user.email}
              </DropdownMenuCheckItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
      <td className={cn('px-2 py-1.5 align-middle text-xs', overdue ? 'font-medium text-destructive' : 'text-muted-foreground')}>
        {task.dueDate ? new Date(task.dueDate).toLocaleDateString(lang, { day: 'numeric', month: 'short' }) : '—'}
      </td>
    </tr>
  )
}

// Инлайн-ячейка оценки времени: показывает «2ч 30м», по клику — ввод минут
function EstimateCell({ mins, canEdit, onSave }: { mins: number | null; canEdit: boolean; onSave: (m: number | null) => void }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(mins?.toString() ?? '')
  if (editing && canEdit) {
    return (
      <input
        autoFocus
        type="number"
        min={0}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => {
          setEditing(false)
          const next = val === '' ? null : Math.max(0, Number(val) || 0)
          if (next !== mins) onSave(next)
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        placeholder="мин"
        className="w-16 rounded border bg-background px-1 py-0.5 text-xs"
      />
    )
  }
  return (
    <button
      disabled={!canEdit}
      onClick={() => {
        setVal(mins?.toString() ?? '')
        setEditing(true)
      }}
      className="text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground"
    >
      {mins ? fmtEstimate(mins) : '—'}
    </button>
  )
}
