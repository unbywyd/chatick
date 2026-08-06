import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { ChevronDown, ChevronUp, ChevronsUpDown, Flag, GripVertical, Lock, Paperclip, Pencil, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckItem,
} from '@/components/ui/dropdown-menu'
import { useConfirm } from '@/components/ui/confirm'
import { Avatar } from '@/components/ui/avatar'
import { TaskContextMenu } from './TaskContextMenu'
import {
  STATUSES,
  PRIORITIES,
  PRIORITY_COLOR,
  fmtEstimate,
  type Task,
  type TaskGroup,
  type Member,
  type Status,
  type Priority,
} from './types'
import { parseDuration } from '@/lib/time-parse'
import { TaskRefs, REFS_SIGN } from './TaskRefs'
import { StatusBadge } from './StatusBadge'
import { TaskBlockedMark } from './TaskBlockedMark'

// Табличный вид задач (SPEC §8.6): вложенные таблицы по группам-спринтам,
// сортировка по колонкам, инлайн-смена статуса/ассайни, drag строк и групп.

type SortKey = 'number' | 'title' | 'status' | 'priority' | 'estimate' | 'assignee' | 'refs' | 'deps'
type SortDir = 'asc' | 'desc'

const STATUS_RANK: Record<Status, number> = { todo: 0, in_progress: 1, review: 2, done: 3 }
const PRIORITY_RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2, urgent: 3 }

/**
 * Вес задачи в порядке работ: держит других > ждёт других > свободна.
 *
 * Блокирующие выше заблокированных намеренно: это ответ на вопрос «с чего
 * начать». Заблокированную всё равно нельзя взять, пока не сделана та, что
 * сверху.
 */
const depsRank = (t: Task) =>
  // Завершённая — всегда «свободна»: поднимать её наверх как «делать первой»
  // значит советовать сделать сделанное.
  t.status === 'done' ? 0 : (t.blocking ?? 0) > 0 ? 2 : (t.blockedBy ?? 0) > 0 ? 1 : 0

export function TasksTable({
  tasks,
  groups,
  members,
  lang,
  canEdit,
  canEditTask,
  meId,
  openTaskId,
  onOpen,
  onPatch,
  onDelete,
  onCreateGroup,
  onPatchGroup,
  onDeleteGroup,
  onReorderGroups,
  onReorderTasks,
  onCreateTask,
  highlightId,
}: {
  tasks: Task[]
  groups: TaskGroup[]
  members: Member[]
  lang: string
  canEdit: boolean
  /** правило владения задачей — приходит сверху, чтобы не размножать логику */
  canEditTask?: (task: Task) => boolean
  meId?: string
  openTaskId: string | null
  onOpen: (id: string) => void
  onPatch: (id: string, body: Record<string, unknown>) => void
  onDelete: (id: string) => void
  onCreateGroup: (name: string) => void
  onPatchGroup: (id: string, body: Record<string, unknown>) => void
  onDeleteGroup: (id: string) => void
  onReorderGroups: (orderedIds: string[]) => void
  /** итоговый порядок задач одной группы — нумерует сервер */
  onReorderTasks: (items: { id: string; groupId: string | null }[]) => void
  /** быстрое добавление прямо в конец спринта */
  onCreateTask: (title: string, groupId: string | null) => void
  /** задача, из которой только что вышли: подсвечена пару секунд */
  highlightId?: string | null
}) {
  const { t } = useTranslation()
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null)
  const [newGroup, setNewGroup] = useState('')
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  // Что именно тащат прямо сейчас. Нужно для двух вещей: показать это в
  // DragOverlay и на время переноса спринта схлопнуть все спринты.
  const [activeId, setActiveId] = useState<string | null>(null)
  const draggingGroup = Boolean(activeId?.startsWith('group:'))
  // Общий переключатель: у каждого спринта есть своё состояние, но «схлопнуть
  // всё и посмотреть состав» — отдельное желание, и обходить спринты по одному
  // ради него не годится. Меняем ключ — секции пересоздаются с новым значением.
  const [allCollapsed, setAllCollapsed] = useState<boolean | null>(null)
  const [bulkKey, setBulkKey] = useState(0)
  const collapseAll = (v: boolean) => {
    for (const g of groups) localStorage.setItem(`sprintCollapsed:${g.id}`, v ? '1' : '0')
    setAllCollapsed(v)
    setBulkKey((k) => k + 1)
  }

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
        case 'refs':
          // Численно, а не по алфавиту: иначе «10» встаёт между «1» и «2».
          d = (parseFloat(a.refs ?? '') || Infinity) - (parseFloat(b.refs ?? '') || Infinity)
          break
        case 'deps':
          // Порядок работ: сначала те, что ДЕРЖАТ других (их делать первыми),
          // потом заблокированные, потом свободные. Внутри блокирующих —
          // кто держит больше, тот выше: он и есть узкое место.
          d = depsRank(b) - depsRank(a) || (b.blocking ?? 0) - (a.blocking ?? 0)
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
    setActiveId(null)
    const { active, over } = e
    if (!over || active.id === over.id) return
    const activeId = String(active.id)
    const overId = String(over.id)

    /**
     * Перетаскивание групп.
     *
     * Цель ищем не только среди групп. Строки задач — тоже droppable и лежат
     * внутри секций, поэтому ближайшим центром при переносе спринта почти
     * всегда оказывается чужая строка, а не заголовок. Условие «отпустили ровно
     * на другой группе» не выполнялось никогда, и спринты не двигались вовсе.
     */
    if (activeId.startsWith('group:')) {
      const overGroupId = overId.startsWith('group:')
        ? overId.slice(6)
        : overId.startsWith('task:')
          ? tasks.find((x) => x.id === overId.slice(5))?.groupId ?? null
          : overId.startsWith('dropzone:')
            ? (overId.slice(9) === 'none' ? null : overId.slice(9))
            : null
      if (!overGroupId) return // «без группы» — не спринт, местами с ним не меняются
      const ids = orderedGroups.map((g) => g.id)
      const from = ids.indexOf(activeId.slice(6))
      const to = ids.indexOf(overGroupId)
      if (from >= 0 && to >= 0 && from !== to) onReorderGroups(arrayMove(ids, from, to))
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

    // Порядок задаём СПИСКОМ, а не вычисленным sortOrder у одной задачи.
    // Раньше клиент брал середину между соседями — но у всех задач проекта
    // sort_order по умолчанию 0, а середина между нулями тоже ноль: карточка
    // возвращалась на место, и выглядело это как сломанный драг.
    const inGroup = sortTasks(byGroup.get(targetGroupId) ?? [])
    let ordered: Task[]

    if ((task.groupId ?? null) === targetGroupId) {
      // Своя группа — сдвиг внутри списка.
      //
      // Именно сдвиг, а не «вставить перед целью»: вынув задачу из списка, все
      // следующие поднимаются на одну позицию, и вставка перед целью ставила
      // её ПЕРЕД той же соседкой, откуда она уехала. Вверх это совпадало с
      // ожиданием, а вниз возвращало на место — ровно то, что и наблюдалось.
      const from = inGroup.findIndex((x) => x.id === taskId)
      const to = beforeTaskId ? inGroup.findIndex((x) => x.id === beforeTaskId) : inGroup.length - 1
      if (from < 0 || to < 0 || from === to) return
      ordered = arrayMove(inGroup, from, to)
    } else {
      // Переезд в другую группу: встаём на место той задачи, на которую
      // отпустили, а на пустом поле — в конец.
      const rest = inGroup.filter((x) => x.id !== taskId)
      const idx = beforeTaskId ? rest.findIndex((x) => x.id === beforeTaskId) : rest.length
      const at = idx < 0 ? rest.length : idx
      ordered = [...rest.slice(0, at), task, ...rest.slice(at)]
    }

    onReorderTasks(ordered.map((x) => ({ id: x.id, groupId: targetGroupId })))
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))}
      onDragCancel={() => setActiveId(null)}
      onDragEnd={handleDragEnd}
    >
      {orderedGroups.length > 1 && (
        <div className="mb-2 flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => collapseAll(!allCollapsed)}>
            <ChevronDown className={cn('size-3.5 transition-transform', allCollapsed && '-rotate-90 rtl:rotate-90')} />
            {allCollapsed ? t('tasks.expandAllSprints') : t('tasks.collapseAllSprints')}
          </Button>
        </div>
      )}

      <SortableContext items={orderedGroups.map((g) => `group:${g.id}`)} strategy={verticalListSortingStrategy}>
        <div className="space-y-5">
          {orderedGroups.map((g) => (
            <GroupTable
              key={`${g.id}:${bulkKey}`}
              group={g}
              tasks={sortTasks(byGroup.get(g.id) ?? [])}
              members={members}
              lang={lang}
              canEdit={canEdit}
              canEditTask={canEditTask}
              sort={sort}
              onToggleSort={toggleSort}
              openTaskId={openTaskId}
              meId={meId}
              onOpen={onOpen}
              onPatch={onPatch}
              onDelete={onDelete}
              onPatchGroup={onPatchGroup}
              onDeleteGroup={onDeleteGroup}
              onCreateTask={onCreateTask}
              highlightId={highlightId}
              forceCollapsed={draggingGroup}
            />
          ))}

          {/* Задачи без группы */}
          <GroupTable
            group={null}
            tasks={sortTasks(byGroup.get(null) ?? [])}
            members={members}
            lang={lang}
            canEdit={canEdit}
            canEditTask={canEditTask}
            meId={meId}
            sort={sort}
            onToggleSort={toggleSort}
            openTaskId={openTaskId}
            onOpen={onOpen}
            onPatch={onPatch}
            onDelete={onDelete}
            onPatchGroup={onPatchGroup}
            onDeleteGroup={onDeleteGroup}
            onCreateTask={onCreateTask}
            highlightId={highlightId}
            forceCollapsed={draggingGroup}
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
          {/* Набрал имя — значит уже решил создать. Обведённая кнопка тут
              терялась рядом с подсвеченным полем ввода и читалась как
              «может быть». */}
          <Button variant={newGroup.trim() ? 'brand' : 'outline'} type="submit" size="sm" disabled={!newGroup.trim()}>
            <Plus className="size-4" />
            {t('tasks.addGroup')}
          </Button>
        </form>
      )}

      {/* Что тащим — под курсором. Сама строка и сама секция остаются на месте
          бледными: их сдвиг растягивал область прокрутки и уводил автоскролл в
          петлю. Без этой подсказки перенос выглядел так, будто ничего не
          происходит. */}
      <DragOverlay dropAnimation={null}>
        {activeId?.startsWith('group:') ? (
          (() => {
            const g = groups.find((x) => x.id === activeId.slice(6))
            if (!g) return null
            const n = byGroup.get(g.id)?.length ?? 0
            return (
              <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm font-semibold shadow-lg">
                <GripVertical className="size-4 text-muted-foreground" />
                <span className="size-3 rounded-full" style={{ backgroundColor: g.color }} />
                {g.name}
                <span className="text-xs font-normal tabular-nums text-muted-foreground">({n})</span>
              </div>
            )
          })()
        ) : activeId?.startsWith('task:') ? (
          (() => {
            const task = tasks.find((x) => x.id === activeId.slice(5))
            if (!task) return null
            return (
              <div className="flex max-w-md items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm shadow-lg">
                <GripVertical className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="shrink-0 text-xs text-muted-foreground">{task.number}</span>
                <span className="truncate">{task.title}</span>
              </div>
            )
          })()
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

function GroupTable({
  group,
  tasks,
  members,
  lang,
  canEdit,
  canEditTask,
  meId,
  sort,
  onToggleSort,
  openTaskId,
  onOpen,
  onPatch,
  onDelete,
  onPatchGroup,
  onDeleteGroup,
  onCreateTask,
  highlightId,
  forceCollapsed,
}: {
  group: TaskGroup | null
  tasks: Task[]
  members: Member[]
  lang: string
  canEdit: boolean
  /** правило владения задачей — приходит сверху, чтобы не размножать логику */
  canEditTask?: (task: Task) => boolean
  meId?: string
  sort: { key: SortKey; dir: SortDir } | null
  onToggleSort: (k: SortKey) => void
  openTaskId: string | null
  onOpen: (id: string) => void
  onPatch: (id: string, body: Record<string, unknown>) => void
  onDelete: (id: string) => void
  onPatchGroup: (id: string, body: Record<string, unknown>) => void
  onDeleteGroup: (id: string) => void
  onCreateTask: (title: string, groupId: string | null) => void
  highlightId?: string | null
  /** режим переноса спринтов: на его время все спринты схлопнуты */
  forceCollapsed?: boolean
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(group?.name ?? '')

  // Свёрнутые спринты помним между заходами: закрытый спринт закрывают, чтобы
  // он не мешал, и открывать его заново при каждом возврате — та же помеха.
  const [ownCollapsed, setOwnCollapsed] = useState(() =>
    group ? localStorage.getItem(`sprintCollapsed:${group.id}`) === '1' : false,
  )
  // На время переноса спринтов схлопнуты все — иначе спринт с сотней задач
  // тянешь вслепую: заголовок соседа уезжает за экран, и куда ты целишься, не
  // видно. Это временное состояние, в localStorage его не пишем.
  const collapsed = forceCollapsed || ownCollapsed
  // Ввод новой задачи в конце спринта — как в Monday: список читают сверху
  // вниз и дописывают снизу, не возвращаясь к общей форме наверху страницы.
  const [newTask, setNewTask] = useState('')
  const submitNewTask = () => {
    const title = newTask.trim()
    if (!title) return
    onCreateTask(title, group ? group.id : null)
    // Поле не закрываем и не очищаем фокус: задачи вносят подряд.
    setNewTask('')
  }

  const toggleCollapsed = () => {
    if (!group) return
    setOwnCollapsed((v) => {
      localStorage.setItem(`sprintCollapsed:${group.id}`, v ? '0' : '1')
      return !v
    })
  }

  // Прогресс спринта: закрытых из всех. Место в шапке свободно, а вопрос
  // «сколько там осталось» задают, не открывая список.
  const doneCount = tasks.filter((x) => x.status === 'done').length
  const pct = tasks.length ? Math.round((doneCount / tasks.length) * 100) : 0

  // sortable-обёртка для строки-заголовка группы (перетаскивание групп)
  const sortable = useSortable({ id: group ? `group:${group.id}` : 'group:none', disabled: !group || !canEdit })
  // Перетаскиваемую секцию оставляем на месте и прячем целиком.
  //
  // На месте — потому что сдвиг за нижний край растягивает область прокрутки и
  // уводит автоскролл в петлю. Прячем — потому что соседняя секция по правилам
  // сортировки съезжает в освободившееся место и наезжала на неподвижную:
  // два заголовка рисовались друг поверх друга. Видно её теперь под курсором,
  // в DragOverlay, так что в списке показывать нечего.
  const style = group
    ? {
        transform:
          sortable.transform && !sortable.isDragging ? `translate3d(0, ${sortable.transform.y}px, 0)` : undefined,
        transition: sortable.transition,
      }
    : undefined

  // для «без группы» пустую секцию не показываем
  if (!group && tasks.length === 0) return null

  const cols: { key: SortKey; label: React.ReactNode; className?: string }[] = [
    { key: 'number', label: t('tasks.col.number'), className: 'w-20' },
    // Узкая: в строку влезает два номера и счётчик остальных, переносов нет.
    { key: 'refs', label: REFS_SIGN, className: 'w-24' },
    { key: 'title', label: t('tasks.col.title') },
    { key: 'status', label: t('tasks.col.status'), className: 'w-36 whitespace-nowrap' },
    { key: 'priority', label: t('tasks.col.priority'), className: 'w-10' },
    { key: 'estimate', label: t('tasks.col.estimate'), className: 'w-24' },
    { key: 'assignee', label: t('tasks.col.assignee'), className: 'w-40' },
    // Зависимости последней: колонка узкая и чаще пустая, а по клику на
    // заголовок поднимает наверх то, с чего надо начинать. В заголовке
    // значок, а не слово: подписи длиннее самой колонки.
    { key: 'deps', label: <Lock className="size-3.5" />, className: 'w-14' },
  ]

  return (
    <section ref={group ? sortable.setNodeRef : undefined} style={style} className={cn(sortable.isDragging && 'invisible')}>
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
              // Кликается само имя, а не только стрелка: свернуть спринт хотят
              // часто, и целиться в значок размером с букву — лишняя работа.
              // Переименование живёт на карандаше рядом и клику не мешает.
              <button
                onClick={toggleCollapsed}
                title={collapsed ? t('tasks.expandSprint') : t('tasks.collapseSprint')}
                // При наведении подсвечиваем стрелку, а не текст: лайм на
                // светлом фоне почти не читается, и заголовок пропадал ровно в
                // тот момент, когда на него смотрят.
                className="group/title inline-flex items-center gap-1.5 text-sm font-semibold"
              >
                <ChevronDown
                  className={cn(
                    'size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/title:text-foreground',
                    collapsed && '-rotate-90 rtl:rotate-90',
                  )}
                />
                {group.name}
                <span className="text-xs font-normal tabular-nums text-muted-foreground">({tasks.length})</span>
              </button>
            )}
            {editing && <span className="text-xs tabular-nums text-muted-foreground">({tasks.length})</span>}
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

        {/* Прогресс — у противоположного края шапки: место там свободно, а
            вопрос «сколько осталось» задают, не открывая список. */}
        {tasks.length > 0 && (
          <span className="ms-auto flex shrink-0 items-center gap-2">
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-secondary">
              <span
                className={cn('block h-full transition-all', pct === 100 ? 'bg-brand' : 'bg-brand/70')}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className={cn('text-xs tabular-nums', pct === 100 ? 'text-brand' : 'text-muted-foreground')}>
              {doneCount}/{tasks.length}
            </span>
          </span>
        )}
      </div>

      {!collapsed && (
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
              {canEdit && <th className="w-6" />}
              {cols.map((col) => (
                <th key={col.key} className={cn('px-2 py-1.5 text-start font-medium', col.className)}>
                  <button className="inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground" onClick={() => onToggleSort(col.key)}>
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
                  // Чужую задачу участник не переписывает: сервер это проверит,
                  // но лучше не давать начать правку, чем отказать после ввода.
                  canEdit={canEditTask ? canEditTask(task) : canEdit}
                  meId={meId}
                  active={openTaskId === task.id}
                  highlighted={highlightId === task.id}
                  onOpenTask={onOpen}
                  onOpen={() => onOpen(task.id)}
                  onPatch={onPatch}
                  onDelete={onDelete}
                />
              ))}
              {tasks.length === 0 && (
                <DropRow groupId={group ? group.id : 'none'} colSpan={cols.length + (canEdit ? 1 : 0)} label={t('tasks.emptyGroup')} />
              )}
              {canEdit && (
                <tr className="border-t">
                  <td colSpan={cols.length + 1} className="p-0">
                    <div className="flex items-center gap-1.5 px-2 py-1.5">
                      <Plus className="size-3.5 shrink-0 text-muted-foreground" />
                      <input
                        value={newTask}
                        onChange={(e) => setNewTask(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') submitNewTask()
                          if (e.key === 'Escape') setNewTask('')
                        }}
                        placeholder={t('tasks.addInSprint')}
                        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                      />
                      {newTask.trim() && (
                        <Button variant="brand" size="sm" onClick={submitNewTask}>
                          {t('tasks.add')}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </SortableContext>
        </table>
      </div>
      )}
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
  canEditTask,
  meId,
  active,
  highlighted,
  onOpen,
  onOpenTask,
  onPatch,
  onDelete,
}: {
  task: Task
  members: Member[]
  lang: string
  canEdit: boolean
  /** правило владения задачей — приходит сверху, чтобы не размножать логику */
  canEditTask?: (task: Task) => boolean
  meId?: string
  active: boolean
  highlighted?: boolean
  onOpen: () => void
  onPatch: (id: string, body: Record<string, unknown>) => void
  onDelete: (id: string) => void
  /** открыть ЧУЖУЮ задачу — из списка зависимостей */
  onOpenTask?: (id: string) => void
}) {
  const { t } = useTranslation()
  const { setNodeRef, transform, transition, isDragging, attributes, listeners } = useSortable({ id: `task:${task.id}` })
  // Ждёт незакрытые задачи — значит брать её рано. Считает сервер: связь
  // остаётся после завершения блокера, а замочек должен гаснуть сам.
  // Завершённую не приглушаем, даже если её блокер всё ещё открыт: работа
  // сделана, «брать рано» про неё уже неправда.
  const blocked = (task.blockedBy ?? 0) > 0 && task.status !== 'done'
  // Саму перетаскиваемую строку НЕ двигаем и прячем: соседние расступаются и
  // наезжали бы на неподвижную. Видно её под курсором, в DragOverlay. Сдвиг за нижний край растягивал область прокрутки,
  // автоскролл видел край и прокручивал дальше, от этого строка уезжала ещё
  // ниже — и список прокручивался без конца, будто задач втрое больше.
  //
  // Соседи меняются местами внутри той же высоты, поэтому от их сдвига список
  // не растёт. Только вертикальный: scaleX/scaleY, которые добавляет
  // CSS.Transform.toString, в <tr> растягивают строку шире таблицы.
  const style = {
    transform: transform && !isDragging ? `translate3d(0, ${transform.y}px, 0)` : undefined,
    transition,
  }
  return (
    <TaskContextMenu task={task} canEdit={canEdit} meId={meId} onPatch={(body) => onPatch(task.id, body)} onDelete={() => onDelete(task.id)}>
    <tr
      ref={setNodeRef}
      style={style}
      // Якорь для возврата из карточки: по нему список находит строку и
      // подводит к ней. tabIndex — чтобы её можно было получить фокусом.
      data-task-id={task.id}
      tabIndex={-1}
      // Открываем по клику на всей строке: раньше работал только заголовок, и
      // попасть по нему в плотной таблице было отдельным упражнением. Клики по
      // кнопкам внутри (статус, приоритет, исполнитель) не считаем — они делают
      // своё дело на месте.
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button,input,a,[role="menuitem"]')) return
        onOpen()
      }}
      className={cn(
        'cursor-pointer border-b last:border-0 transition-colors hover:bg-accent/40',
        active && 'bg-accent',
        // Вернулись из карточки — на пару секунд отмечаем строку: глазами её
        // после возврата всё равно ищут, а фокуса в тёмной теме почти не видно.
        highlighted && 'bg-brand/10 ring-2 ring-inset ring-brand duration-500',
        isDragging && 'invisible',
        // Ждёт другие задачи — приглушаем. Строка остаётся рабочей: открыть,
        // назначить, поменять статус можно, просто видно, что брать её рано.
        // При наведении возвращаем полную яркость, иначе читать неудобно.
        blocked && 'opacity-55 hover:opacity-100',
      )}
    >
      {canEdit && (
        <td className="w-6 ps-1">
          <button className="cursor-grab text-muted-foreground hover:text-foreground" {...attributes} {...listeners}>
            <GripVertical className="size-3.5" />
          </button>
        </td>
      )}
      <td className="px-2 py-1.5 align-middle text-xs text-muted-foreground">{task.number}</td>
      <td className="px-2 py-1.5 align-middle">
        <TaskRefs value={task.refs} canEdit={canEdit} compact onChange={(refs) => onPatch(task.id, { refs })} />
      </td>
      <td className="px-2 py-1.5 align-middle">
        <span className={cn('line-clamp-1', task.status === 'done' && 'text-muted-foreground line-through')}>{task.title}</span>
        {task.attachmentsCount > 0 && (
          <span className="ms-1 inline-flex items-center gap-0.5 text-xs text-muted-foreground">
            <Paperclip className="size-3" />
            {task.attachmentsCount}
          </span>
        )}
      </td>
      {/* Инлайн-статус */}
      {/* Отступы — на самих кнопках, а не на ячейке: иначе попасть по мелкому
          элементу в плотной строке трудно, а промах открывает задачу. */}
      <td className="whitespace-nowrap align-middle">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              disabled={!canEdit}
              className="inline-flex h-full w-full items-center gap-1.5 whitespace-nowrap px-2 py-1.5 text-start text-xs hover:bg-accent/60 disabled:opacity-70"
            >
              <StatusBadge status={task.status} size="sm" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {/* В меню тоже тегами: выбирать глазами проще по тому же пятну,
                по которому статус потом и читается в списке. */}
            {STATUSES.map((s) => (
              <DropdownMenuCheckItem key={s} checked={s === task.status} onSelect={() => onPatch(task.id, { status: s })}>
                <StatusBadge status={s} />
              </DropdownMenuCheckItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
      {/* Приоритет-флаг */}
      <td className="align-middle">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              disabled={!canEdit}
              title={t(`tasks.priority.${task.priority}`)}
              className="flex h-full w-full items-center justify-center px-2 py-1.5 hover:bg-accent/60 disabled:opacity-70"
            >
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
      <td className="align-middle text-xs">
        <EstimateCell mins={task.estimateMinutes} canEdit={canEdit} onSave={(m) => onPatch(task.id, { estimateMinutes: m })} />
      </td>
      {/* Инлайн-ассайни (с поиском по имени при большом составе) */}
      <td className="align-middle">
        <AssigneePicker
          assignee={task.assignee}
          members={members}
          canEdit={canEdit}
          onSelect={(id) => onPatch(task.id, { assigneeId: id })}
        />
      </td>
      {/* Зависимости: замочек — ждёт, восклицательный — держит других. */}
      <td className="px-1 align-middle">
        <TaskBlockedMark
          taskId={task.id}
          blockedBy={task.blockedBy}
          blocking={task.blocking}
          done={task.status === 'done'}
          onOpenTask={onOpenTask}
        />
      </td>
    </tr>
    </TaskContextMenu>
  )
}

// Выбор исполнителя с поиском по имени (поиск появляется при большом составе).
function AssigneePicker({
  assignee,
  members,
  canEdit,
  canEditTask,
  onSelect,
}: {
  assignee: Task['assignee']
  members: Member[]
  canEdit: boolean
  /** правило владения задачей — приходит сверху, чтобы не размножать логику */
  canEditTask?: (task: Task) => boolean
  onSelect: (id: string | null) => void
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const showSearch = members.length > 6
  const needle = q.trim().toLowerCase()
  const filtered = needle
    ? members.filter((m) => (m.user.name || m.user.email).toLowerCase().includes(needle))
    : members

  return (
    <DropdownMenu onOpenChange={(o) => !o && setQ('')}>
      <DropdownMenuTrigger asChild>
        <button
          disabled={!canEdit}
          className="inline-flex h-full w-full items-center gap-1.5 px-2 py-1.5 text-start text-xs hover:bg-accent/60 disabled:opacity-70"
        >
          {assignee ? (
            <>
              <Avatar name={assignee.name} src={assignee.avatarUrl} size={20} />
              <span className="line-clamp-1">{assignee.name}</span>
            </>
          ) : (
            <span className="text-muted-foreground">{t('tasks.unassigned')}</span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {showSearch && (
          <div className="p-1">
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              onKeyDownCapture={(e) => e.stopPropagation()} // отключаем typeahead меню, чтобы печатать в поиск
              placeholder={t('tasks.searchAssignee')}
              className="h-7 w-full rounded border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        )}
        <DropdownMenuCheckItem checked={!assignee} onSelect={() => onSelect(null)}>
          {t('tasks.unassigned')}
        </DropdownMenuCheckItem>
        {filtered.map((m) => (
          <DropdownMenuCheckItem key={m.user.id} checked={assignee?.id === m.user.id} onSelect={() => onSelect(m.user.id)}>
            <Avatar name={m.user.name || m.user.email} src={m.user.avatarUrl} size={18} />
            {m.user.name || m.user.email}
          </DropdownMenuCheckItem>
        ))}
        {filtered.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('start.nothingFound')}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Инлайн-ячейка оценки времени: показывает «2ч 30м», по клику — ввод минут
/**
 * Оценка времени: показываем и вводим одинаково — 2:30.
 *
 * Ввод разбирает parseDuration, тот же, что в трекере: 45 → 45 минут,
 * 230 → 2:30, принимает и «2:30», и «1h30». Хранится по-прежнему в минутах.
 */
function EstimateCell({ mins, canEdit, onSave }: { mins: number | null; canEdit: boolean; onSave: (m: number | null) => void }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(fmtEstimate(mins))
  if (editing && canEdit) {
    return (
      <input
        autoFocus
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => {
          setEditing(false)
          const trimmed = val.trim()
          const next = trimmed === '' ? null : parseDuration(trimmed)
          // непонятный ввод не трогает сохранённое: молча обнулить оценку хуже,
          // чем не принять правку
          if (next !== null && next !== mins) onSave(next)
          else if (trimmed === '' && mins !== null) onSave(null)
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        placeholder="2:30"
        className="mx-2 my-0.5 w-16 rounded border bg-background px-1 py-0.5 text-xs"
      />
    )
  }
  return (
    <button
      disabled={!canEdit}
      onClick={() => {
        setVal(fmtEstimate(mins))
        setEditing(true)
      }}
      className="h-full w-full px-2 py-1.5 text-start text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
    >
      {mins ? fmtEstimate(mins) : '—'}
    </button>
  )
}
