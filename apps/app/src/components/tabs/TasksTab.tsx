import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { CalendarClock, CalendarDays, ChevronDown, Download, FileSpreadsheet, Flag, LayoutList, Link2, MoreHorizontal, Paperclip, Plus, Search, Table2, Timer, Trash2, Upload, User, X } from 'lucide-react'
import { api, previewUrl } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckItem,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { Avatar } from '@/components/ui/avatar'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { TaskDrawer } from './tasks/TaskDrawer'
import { ProjectSummary } from './tasks/ProjectSummary'
import { BlockersStrip } from './tasks/BlockersStrip'
import { TasksTable } from './tasks/TasksTable'
import { TaskContextMenu } from './tasks/TaskContextMenu'
import { TaskRefs } from './tasks/TaskRefs'
import { useTaskTimer } from '@/hooks/useTaskTimer'
import { exportTasksToExcel, downloadImportTemplate, parseTasksFromExcel } from './tasks/taskExcel'
import { useConfirm } from '@/components/ui/confirm'
import { STATUSES, PRIORITIES, STATUS_ICON, STATUS_COLOR, PRIORITY_COLOR, fmtEstimate, isOverdue, isDueSoon, type Task, type TaskGroup, type Member, type Status, type Priority } from './tasks/types'
import { StatusBadge } from './tasks/StatusBadge'
import { DueDate } from './tasks/DueDate'
import { DatePicker } from '@/components/ui/date-picker'
import { TaskBlockedMark } from './tasks/TaskBlockedMark'
import { BlockerFilter, matchesBlockerFilter, type BlockerFilterValue } from './tasks/BlockerFilter'

// Таб «Задачи»: список по статусам + drawer с деталями и вложениями (SPEC §4.3 — права)
export function TasksTab({ projectId, meId }: { projectId: string; meId?: string }) {
  // учёт времени прямо из задачи — см. useTaskTimer
  const startTimer = useTaskTimer(projectId)
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [onlyMine, setOnlyMine] = useState(false)
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null) // фильтр по исполнителю
  const [assigneeSearch, setAssigneeSearch] = useState('')
  const [newSprintId, setNewSprintId] = useState<string | null>(null) // спринт для новой задачи
  const [statusFilter, setStatusFilter] = useState<Status | null>(null)
  // Срок: один фильтр на «просрочено или горит». Раздельные «просроченные» и
  // «скоро» дробят и без того длинный ряд фильтров, а спрашивают их вместе —
  // это один вопрос «что не ждёт».
  const [dueFilter, setDueFilter] = useState(false)
  const [priorityFilter, setPriorityFilter] = useState<Priority | null>(null)
  // Зависимости: ни один значок не нажат — показываем всё.
  const [depFilter, setDepFilter] = useState<BlockerFilterValue>(() => new Set())
  const [showDone, setShowDone] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  // Срок для новой задачи. Отдельным полем, а не только в карточке: когда
  // задачу заводят под конкретную дату, сказать её сразу естественнее, чем
  // открывать созданное и дописывать.
  const [newDue, setNewDue] = useState('')
  // drawer открывается по URL: /c/:companyId/p/:id/tasks/:taskId — прямые
  // ссылки на задачу работают
  const navigate = useNavigate()
  const { taskId: openTaskId, companyId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  // ?new=1 помечает только что созданную задачу — она открывается сразу в
  // режиме правки, иначе человек попадает на пустую карточку и должен
  // отдельно нажать «Изменить», чтобы указать исполнителя и срок.
  const setOpenTaskId = (taskId: string | null, justCreated = false) =>
    navigate(
      taskId
        ? `/c/${companyId}/p/${projectId}/tasks/${taskId}${justCreated ? '?new=1' : ''}`
        : `/c/${companyId}/p/${projectId}/tasks`,
    )
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<{ status: Status; beforeId: string | null } | null>(null)
  /**
   * Выбранные задачи для массового действия.
   *
   * Только в списочном виде: в таблице колонок и так под завязку, и ещё одна
   * ради галочки вытеснила бы что-то полезное.
   */
  const confirm = useConfirm()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // Якорь для shift-выделения: от какой строки тянуть диапазон.
  const lastPickedRef = useRef<string | null>(null)

  /**
   * Отметить задачу. С shift — весь диапазон от прошлой отмеченной.
   *
   * Диапазон считаем по тому порядку, в каком задачи ВИДНЫ на экране, а не по
   * какому-то внутреннему: человек тянет мышью сверху вниз и ждёт ровно то,
   * что выделил глазами.
   */
  const toggleSelect = (id: string, shift: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      const anchorId = lastPickedRef.current
      if (shift && anchorId && anchorId !== id) {
        const order = visibleOrder()
        const a = order.indexOf(anchorId)
        const b = order.indexOf(id)
        if (a !== -1 && b !== -1) {
          const [from, to] = a < b ? [a, b] : [b, a]
          for (const tid of order.slice(from, to + 1)) next.add(tid)
          lastPickedRef.current = id
          return next
        }
      }
      if (next.has(id)) next.delete(id)
      else next.add(id)
      lastPickedRef.current = id
      return next
    })
  }

  /**
   * Отметить или снять всю группу разом.
   *
   * При восьмидесяти задачах в колонке отмечать по одной бессмысленно, а
   * shift-диапазон требует сначала найти первую и последнюю. Чекбокс в
   * заголовке — там, куда человек и так смотрит, читая название группы.
   */
  const toggleGroup = (ids: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
    lastPickedRef.current = null
  }

  /**
   * Инверсия: снять отмеченное, отметить остальное — по тому, что сейчас
   * видно. Быстрый способ сказать «все, кроме этих трёх», не кликая по
   * восьмидесяти.
   */
  const invertSelection = () => {
    const order = visibleOrder()
    setSelected((prev) => new Set(order.filter((id) => !prev.has(id))))
    lastPickedRef.current = null
  }

  const clearSelection = () => {
    setSelected(new Set())
    lastPickedRef.current = null
  }

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

  const me = useMemo(() => (membersQ.data ?? []).find((m) => m.user.id === meId), [membersQ.data, meId])
  const isManager = me?.role === 'owner' || me?.role === 'admin'
  // Право работать с задачами вообще: создавать, править свои.
  const canEdit = useMemo(
    () => isManager || Boolean(me?.permissions?.['tasks.edit']),
    [isManager, me],
  )
  // Двигать статус может каждый участник: перенести карточку по доске — не то
  // же самое, что переписать задачу. Право отдельное и на сервере тоже.
  const canChangeStatus = useMemo(
    () => isManager || Boolean(me?.permissions?.['tasks.changeStatus']),
    [isManager, me],
  )
  /**
   * Право править КОНКРЕТНУЮ задачу: чужую участник не переписывает.
   *
   * Сервер это и так проверяет, но без такой же проверки здесь человек
   * заполнил бы форму и получил отказ уже после ввода — а причину пришлось бы
   * угадывать.
   */
  const canEditTask = useMemo(
    () => (task: Task) =>
      canEdit && (isManager || task.createdById === meId || task.assignee?.id === meId),
    [canEdit, isManager, meId],
  )

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
  /**
   * Порядок — одним запросом, а сервер нумерует.
   *
   * Раньше клиент считал sortOrder как середину между соседями и слал PATCH на
   * каждую сущность. Обе части были неверны. Во-первых, у всех задач проекта
   * sort_order по умолчанию 0, а середина между нулями — тоже ноль: карточка
   * возвращалась на место, и драг выглядел сломанным. Во-вторых, пачка запросов
   * обновляла список после каждого, и карточка успевала съездить назад и
   * вернуться — те самые «пара секунд» задержки.
   */
  const reorder = useMutation({
    mutationFn: (body: { tasks?: { id: string; groupId: string | null }[]; groups?: string[] }) =>
      api('/api/v1/tasks/reorder', { method: 'PATCH', body: JSON.stringify(body) }, 'project'),
    onSuccess: () => {
      refresh()
      refreshGroups()
    },
    onError: (e) => {
      // Порядок вернём с сервера: показывать перестановку, которой не
      // случилось, хуже, чем откатить её на глазах.
      refresh()
      refreshGroups()
      onErr(e)
    },
  })

  const reorderGroups = (orderedIds: string[]) => {
    // Новый порядок показываем сразу: ждать ответа значит видеть, как группа
    // прыгает обратно и лишь потом встаёт на место.
    qc.setQueryData(['task-groups', projectId], (cur: TaskGroup[] | undefined) =>
      (cur ?? []).map((g) => ({ ...g, sortOrder: orderedIds.indexOf(g.id) })),
    )
    reorder.mutate({ groups: orderedIds })
  }

  const reorderTasks = (items: { id: string; groupId: string | null }[]) => {
    const pos = new Map(items.map((x, i) => [x.id, i]))
    qc.setQueryData(['tasks', projectId], (cur: Task[] | undefined) =>
      (cur ?? []).map((task) => {
        const i = pos.get(task.id)
        return i === undefined ? task : { ...task, sortOrder: i, groupId: items[i]!.groupId }
      }),
    )
    reorder.mutate({ tasks: items })
  }

  const create = useMutation({
    mutationFn: (title: string) =>
      api<Task>(
        '/api/v1/tasks',
        {
          method: 'POST',
          // Полдень по местному, а не полночь: в поясе восточнее UTC полночь
          // уезжает на предыдущий день, и срок «14-го» стал бы 13-м.
          body: JSON.stringify({
            title,
            groupId: newSprintId,
            dueDate: newDue ? new Date(`${newDue}T12:00:00`).toISOString() : null,
          }),
        },
        'project',
      ),
    onSuccess: (created) => {
      setNewTitle('')
      setNewDue('')
      refresh()
      setOpenTaskId(created.id, true) // открыть сразу в форме — заполнить детали
    },
    onError: onErr,
  })

  /**
   * Быстрое добавление прямо в спринт.
   *
   * Отдельно от create: та открывает карточку сразу после создания, чтобы
   * заполнить детали. Здесь это мешало бы — задачи в спринт вносят подряд, и
   * карточка, распахивающаяся после каждой, выбивает из потока.
   */
  const createInGroup = useMutation({
    mutationFn: ({ title, groupId }: { title: string; groupId: string | null }) =>
      api<Task>('/api/v1/tasks', { method: 'POST', body: JSON.stringify({ title, groupId }) }, 'project'),
    onSuccess: refresh,
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

  // --- Импорт / экспорт Excel ---
  const importRef = useRef<HTMLInputElement>(null)
  const projectQ = useQuery({ queryKey: ['project', projectId], queryFn: () => api<{ name: string }>(`/api/v1/projects/${projectId}`) })
  const projectName = projectQ.data?.name ?? 'project'

  async function runImport(file: File) {
    try {
      const { rows, skipped } = await parseTasksFromExcel(file, membersQ.data ?? [], groupsQ.data ?? [])
      if (!rows.length) {
        toast.error(t('tasks.importEmpty'))
        return
      }
      let created = 0
      // последовательно, чтобы не словить рейт-лимит и сохранить порядок номеров
      for (const r of rows) {
        try {
          await api<Task>(
            '/api/v1/tasks',
            {
              method: 'POST',
              body: JSON.stringify({
                title: r.title,
                description: r.description,
                status: r.status,
                priority: r.priority,
                assigneeId: r.assigneeId,
                groupId: r.groupId,
                dueDate: r.dueDate,
                estimateMinutes: r.estimateMinutes,
              }),
            },
            'project',
          )
          created++
        } catch {
          /* пропускаем ошибочную строку */
        }
      }
      refresh()
      toast.success(t('tasks.importDone', { created, skipped }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  const filtered = useMemo(() => {
    let list = tasksQ.data ?? []
    if (onlyMine && meId) list = list.filter((task) => task.assignee?.id === meId)
    if (assigneeFilter) list = list.filter((task) => task.assignee?.id === assigneeFilter)
    if (statusFilter) list = list.filter((task) => task.status === statusFilter)
    if (priorityFilter) list = list.filter((task) => task.priority === priorityFilter)
    // Выполненные не показываем даже с просроченным сроком: он у них в
    // прошлом почти всегда, и список «что горит» забился бы сделанным.
    if (dueFilter) list = list.filter((task) => isOverdue(task) || isDueSoon(task))
    // Пустой набор пропускает всех — это обычное состояние контрола, а не
    // «фильтр не задан», поэтому отдельной проверки на размер здесь нет.
    list = list.filter((task) => matchesBlockerFilter(task, depFilter))
    const needle = q.trim().toLowerCase()
    if (needle) list = list.filter((task) => task.title.toLowerCase().includes(needle) || task.number.toLowerCase().includes(needle))
    return list
  }, [tasksQ.data, onlyMine, meId, assigneeFilter, statusFilter, priorityFilter, depFilter, dueFilter, q])

  const hasFilters = onlyMine || Boolean(assigneeFilter) || Boolean(statusFilter) || Boolean(priorityFilter) || dueFilter || q.trim().length > 0
  const resetFilters = () => {
    setOnlyMine(false)
    setAssigneeFilter(null)
    setStatusFilter(null)
    setPriorityFilter(null)
    setDueFilter(false)
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

  /**
   * Порядок задач, как они видны на экране: группы сверху вниз, внутри —
   * свой порядок. Нужен для shift-выделения: человек тянет мышью по тому,
   * что видит, а не по внутреннему списку.
   */
  const visibleOrder = () => groups.flatMap((g) => g.tasks.map((t) => t.id))

  /**
   * Массовое действие над выбранными задачами.
   *
   * Запросы идут по одному, а не одним bulk: такая ручка есть только в мосту,
   * а веб ходит в обычный REST. Для десятков задач это нормально, и главное —
   * частичный успех виден: три из пяти прошли, две упали, и человеку скажут
   * именно это, а не «что-то пошло не так».
   */
  const bulk = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const ids = picked
      const results = await Promise.allSettled(
        ids.map((id) => api(`/api/v1/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, 'project')),
      )
      return { ok: results.filter((r) => r.status === 'fulfilled').length, failed: results.filter((r) => r.status === 'rejected').length }
    },
    onSuccess: ({ ok, failed }) => {
      qc.invalidateQueries({ queryKey: ['tasks', projectId] })
      clearSelection()
      if (failed) toast.error(t('tasks.bulkPartial', { ok, failed }))
      else toast.success(t('tasks.bulkDone', { count: ok }))
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const bulkDelete = useMutation({
    mutationFn: async () => {
      const results = await Promise.allSettled(
        picked.map((id) => api(`/api/v1/tasks/${id}`, { method: 'DELETE' }, 'project')),
      )
      return { ok: results.filter((r) => r.status === 'fulfilled').length, failed: results.filter((r) => r.status === 'rejected').length }
    },
    onSuccess: ({ ok, failed }) => {
      qc.invalidateQueries({ queryKey: ['tasks', projectId] })
      clearSelection()
      if (failed) toast.error(t('tasks.bulkPartial', { ok, failed }))
      else toast.success(t('tasks.bulkDeleted', { count: ok }))
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })


  // Выбранные задачи, которых больше не видно (сменился фильтр, задачу
  // удалили), убираем сами: иначе «Удалить 5» относится к трём на экране и
  // двум невидимым, и человек не знает, что именно удаляет.
  const visibleIds = useMemo(() => new Set(visibleOrder()), [groups])
  const picked = useMemo(() => [...selected].filter((id) => visibleIds.has(id)), [selected, visibleIds])

  const doneCount = (tasksQ.data ?? []).filter((task) => task.status === 'done').length
  const openTask = tasksQ.data?.find((task) => task.id === openTaskId) ?? null
  // Какая задача была создана только что. Держим id, а не булев флаг: URL
  // чистится сразу после открытия, и флаг успел бы схлопнуться в false,
  // закрыв форму в тот же момент, когда она открылась.
  const createdRef = useRef<string | null>(null)
  /** Задача, из карточки которой только что вышли — к ней возвращаем скролл. */
  const justClosed = useRef<string | null>(null)
  /** Задача, к которой вернулись: подсвечена пару секунд. */
  const [highlight, setHighlight] = useState<string | null>(null)
  if (searchParams.get('new') === '1' && openTaskId) createdRef.current = openTaskId
  const isNewTask = Boolean(openTaskId) && createdRef.current === openTaskId

  useEffect(() => {
    if (searchParams.get('new') !== '1') return
    const next = new URLSearchParams(searchParams)
    next.delete('new')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  // ?create=1 — сюда приходит горячая клавиша «новая задача». Задачу заводит
  // название, поэтому ставим фокус в поле, а не создаём пустую запись.
  const newTitleRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (searchParams.get('create') !== '1') return
    // Кадром позже: поле появляется вместе со вкладкой, до этого его нет.
    const timer = window.setTimeout(() => newTitleRef.current?.focus(), 0)
    const next = new URLSearchParams(searchParams)
    next.delete('create')
    setSearchParams(next, { replace: true })
    return () => window.clearTimeout(timer)
  }, [searchParams, setSearchParams])

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

  // страница конкретной задачи открывается ВМЕСТО таблицы (по /tasks/:id, ссылкой можно делиться)
  // Возврат из карточки: прокрутка к задаче и подсветка.
  //
  // Карточка заменяет список целиком, поэтому он монтируется заново и
  // выбрасывает человека в начало. Одного requestAnimationFrame мало: строки
  // появляются после того, как приедут данные, и узла в этот момент может ещё
  // не быть. Поэтому ждём его появления, но не бесконечно.
  // Из карточки выходят не только её кнопкой: «назад» в браузере, Escape,
  // клик по другой вкладке. Все они меняют адрес мимо onClose, поэтому ловим
  // сам переход «была открыта задача → списка», а не нажатие на крестик.
  const prevOpenId = useRef<string | undefined>(openTaskId)
  useEffect(() => {
    if (prevOpenId.current && !openTaskId) justClosed.current = prevOpenId.current
    prevOpenId.current = openTaskId
  }, [openTaskId])

  /**
   * Открыл задачу — значит прочитал уведомления о ней.
   *
   * Гасим по сущности, а не по одному id: на задачу их накапливается
   * несколько — назначили, упомянули, прокомментировали, — и человек, дошедший
   * до карточки, прочитал все. Раньше не гасло ни одно, и бейдж в трее, в
   * панели и на кнопке в панели задач продолжал висеть после того, как всё уже
   * просмотрено. Доверие к счётчику от этого и ломается.
   */
  useEffect(() => {
    if (!openTaskId) return
    void api('/api/v1/inbox/read', {
      method: 'POST',
      body: JSON.stringify({ entityType: 'task', entityId: openTaskId }),
    })
      .then(() => {
        // Бейджи считаются из этих запросов — без сброса цифра остаётся
        // старой до следующего опроса, и человек видит то, что уже прочёл.
        qc.invalidateQueries({ queryKey: ['inbox'] })
        qc.invalidateQueries({ queryKey: ['sidebar-projects'] })
        qc.invalidateQueries({ queryKey: ['desktop-tasks'] })
      })
      .catch(() => {})
  }, [openTaskId, qc])

  useEffect(() => {
    const id = justClosed.current
    if (openTaskId || !id) return
    justClosed.current = null

    let tries = 0
    const find = () => {
      const el = document.querySelector<HTMLElement>(`[data-task-id="${id}"]`)
      if (!el) {
        // ~1 секунда: дальше задачи, скорее всего, просто нет в этом фильтре.
        if (tries++ < 60) requestAnimationFrame(find)
        return
      }
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.focus({ preventScroll: true })
      // Подсветка: фокуса в тёмной теме почти не видно, а глазами задачу
      // после возврата всё равно ищут.
      setHighlight(id)
      window.setTimeout(() => setHighlight((v) => (v === id ? null : v)), 2000)
    }
    requestAnimationFrame(find)
  }, [openTaskId])

  if (openTask) {
    return (
      <TaskDrawer
        task={openTask}
        members={membersQ.data ?? []}
        groups={groupsQ.data ?? []}
        meId={meId}
        canEdit={canEditTask(openTask)}
        canChangeStatus={canChangeStatus}
        onPatch={(body) => patch.mutate({ id: openTask.id, ...body })}
        onDelete={() => remove.mutate(openTask.id)}
        onClose={() => {
          // Помним, откуда вышли: список рендерится заново и без этого
          // возвращает человека в начало — искать свою задачу заново.
          justClosed.current = openTask.id
          setOpenTaskId(null)
        }}
        startEditing={isNewTask}
      />
    )
  }

  return (
    <div className="relative h-full overflow-hidden">
      <div className="h-full overflow-y-auto">
        <div className="page-w p-6">
          {/* Быстрое создание */}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (newTitle.trim()) create.mutate(newTitle.trim())
            }}
          >
            {/* выбор спринта для новой задачи — только если есть хотя бы один спринт */}
            {(groupsQ.data?.length ?? 0) > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-sm text-muted-foreground hover:text-foreground"
                  >
                    {(() => {
                      const g = groupsQ.data?.find((x) => x.id === newSprintId)
                      return g ? (
                        <>
                          <span className="size-2.5 rounded-full" style={{ backgroundColor: g.color }} />
                          <span className="max-w-28 truncate">{g.name}</span>
                        </>
                      ) : (
                        <span>{t('tasks.noGroup')}</span>
                      )
                    })()}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuCheckItem checked={!newSprintId} onSelect={() => setNewSprintId(null)}>
                    {t('tasks.noGroup')}
                  </DropdownMenuCheckItem>
                  {(groupsQ.data ?? []).map((g) => (
                    <DropdownMenuCheckItem key={g.id} checked={newSprintId === g.id} onSelect={() => setNewSprintId(g.id)}>
                      <span className="size-2.5 rounded-full" style={{ backgroundColor: g.color }} />
                      {g.name}
                    </DropdownMenuCheckItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Input ref={newTitleRef} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder={t('tasks.newPlaceholder')} />
            <DatePicker value={newDue} onChange={setNewDue} placeholder={t('tasks.dueNone')} className="w-36 shrink-0" />
            <Button variant="brand" type="submit" disabled={!newTitle.trim() || create.isPending}>
              <Plus className="size-4" />
              {t('start.create')}
            </Button>

          {/* Общее меню страницы: две безымянные иконки в ряду фильтров не
              объясняли ни что делают, ни чем отличаются. Всё редкое — сюда. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" title={t('tasks.moreActions')}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {/* Ссылка на страницу проекта.
                  Раньше поделиться можно было только КОНКРЕТНОЙ задачей, а
                  ссылку на сам проект брали из адресной строки — а у неё
                  превью в мессенджере не будет никогда: всё после «#» браузеру
                  и остаётся, сервер этого не видит. Здесь копируется адрес,
                  который умеет показать имя и логотип проекта. */}
              <DropdownMenuItem
                onSelect={async () => {
                  try {
                    await navigator.clipboard.writeText(previewUrl(`/c/${companyId}/p/${projectId}/tasks`))
                    toast.success(t('tasks.linkCopied'))
                  } catch {
                    toast.error(t('composer.clipboardDenied'))
                  }
                }}
              >
                <Link2 className="size-3.5" />
                {t('tasks.copyLink')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => exportTasksToExcel(tasksQ.data ?? [], groupsQ.data ?? [], projectName)}>
                <Download className="size-3.5" />
                {t('tasks.exportExcel')}
              </DropdownMenuItem>
              {canEdit && (
                <>
                  <DropdownMenuItem onSelect={() => importRef.current?.click()}>
                    <Upload className="size-3.5" />
                    {t('tasks.importExcel')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => downloadImportTemplate()} title={t('tasks.importHelp')}>
                    <FileSpreadsheet className="size-3.5" />
                    {t('tasks.importTemplate')}
                  </DropdownMenuItem>

                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
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
              {/* Часы и срок — под той же полосой: это про один и тот же
                  проект, и разносить их по разным углам экрана незачем. */}
              <ProjectSummary projectId={projectId} canEdit={isManager} />
              {/* Что держит проект: видно сразу, без открывания задач. */}
              <BlockersStrip tasks={tasksQ.data ?? []} onOpen={(id) => setOpenTaskId(id)} className="mt-3" />
            </div>
          )}

          {/*
            Фильтры и поиск остаются на виду при прокрутке.

            Липнет только этот ряд, а не вся шапка: форма создания, прогресс
            и сводка занимают вместе больше двухсот пикселей — четверть
            экрана, которую пришлось бы отдать навсегда. Их смотрят один раз
            при заходе, а фильтр меняют посреди списка, когда шапка уже
            уехала вверх.

            Отрицательные поля с обратным padding: контейнер страницы имеет
            свой отступ, и без этого липкая полоса обрывалась бы, оставляя
            по краям щели, сквозь которые видно уезжающий список.

            Фон непрозрачный: сквозь полупрозрачный видно строки задач,
            которые проезжают под фильтрами, и рябит.
          */}
          <div className="sticky top-0 z-10 -mx-6 mt-3 border-b bg-background px-6 pb-2 pt-2">
          {/* Фильтры-чипсы */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip active={onlyMine} onClick={() => setOnlyMine((v) => !v)}>
              <Avatar name={me?.user.name} src={me?.user.avatarUrl} size={16} />
              {t('tasks.mine')}
            </Chip>
            {/* Фильтры теми же тегами, что и сам статус: выключенные
                приглушены, чтобы было видно, какой фильтр сейчас включён. */}
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(statusFilter === s ? null : s)}
                className="rounded-md"
              >
                <StatusBadge
                  status={s}
                  className={cn(
                    'ring-offset-1 ring-offset-background transition-all',
                    statusFilter === s ? 'ring-2 ring-foreground/40' : 'opacity-50 hover:opacity-100',
                  )}
                />
              </button>
            ))}
            {/* Зависимости: замочек / восклицательный / свободные. */}
            <BlockerFilter value={depFilter} onChange={setDepFilter} />
            {/* Срок: просрочено или горит сегодня-завтра. Один переключатель,
                а не два фильтра: спрашивают это одним вопросом — «что не
                ждёт». */}
            <button
              onClick={() => setDueFilter((v) => !v)}
              title={t('tasks.dueFilterHint')}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors',
                dueFilter ? 'border-destructive bg-destructive/10 text-destructive' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <CalendarClock className="size-3" />
              {t('tasks.dueFilter')}
            </button>
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
            {/* Фильтр по исполнителю (с поиском и аватарами) */}
            <DropdownMenu onOpenChange={(o) => !o && setAssigneeSearch('')}>
              <DropdownMenuTrigger asChild>
                <button
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors',
                    assigneeFilter ? 'border-brand bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {assigneeFilter ? (
                    <Avatar
                      name={membersQ.data?.find((m) => m.user.id === assigneeFilter)?.user.name}
                      src={membersQ.data?.find((m) => m.user.id === assigneeFilter)?.user.avatarUrl}
                      size={16}
                    />
                  ) : (
                    <User className="size-3" />
                  )}
                  {assigneeFilter
                    ? (membersQ.data?.find((m) => m.user.id === assigneeFilter)?.user.name ?? t('tasks.assigneeLabel'))
                    : t('tasks.assigneeLabel')}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="max-h-72 overflow-y-auto">
                {(membersQ.data?.length ?? 0) > 6 && (
                  <div className="p-1">
                    <input
                      autoFocus
                      value={assigneeSearch}
                      onChange={(e) => setAssigneeSearch(e.target.value)}
                      onKeyDown={(e) => e.stopPropagation()}
                      onKeyDownCapture={(e) => e.stopPropagation()}
                      placeholder={t('tasks.searchAssignee')}
                      className="h-7 w-full rounded border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                )}
                {(membersQ.data ?? [])
                  .filter((m) => {
                    const n = assigneeSearch.trim().toLowerCase()
                    return !n || (m.user.name || m.user.email).toLowerCase().includes(n)
                  })
                  .map((m) => (
                    <DropdownMenuCheckItem
                      key={m.user.id}
                      checked={assigneeFilter === m.user.id}
                      onSelect={() => setAssigneeFilter(assigneeFilter === m.user.id ? null : m.user.id)}
                    >
                      <Avatar name={m.user.name} src={m.user.avatarUrl} size={18} />
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
            <input
              ref={importRef}
              type="file"
              accept=".xlsx,.xls"
              hidden
              onChange={(e) => {
                if (e.target.files?.[0]) runImport(e.target.files[0])
                e.target.value = ''
              }}
            />
          </div>

          {/* Поиск и вид — своим рядом. В общем ряду с чипсами их выдавливало
              вниз, стоило появиться ещё одному фильтру, и позиция поиска
              прыгала. На узком экране поиск занимает всю ширину. */}
          <div className="mt-2 flex items-center gap-1.5">
            <div className="relative min-w-0 flex-1 sm:max-w-56 sm:flex-none ms-auto">
              <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('tasks.search')} className="h-8 w-full ps-8 text-xs" />
            </div>
            <div className="inline-flex shrink-0 overflow-hidden rounded-md border">
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
                canEditTask={canEditTask}
                meId={meId}
                openTaskId={openTaskId ?? null}
                onOpen={setOpenTaskId}
                onPatch={(id, body) => patch.mutate({ id, ...body })}
                onDelete={(id) => remove.mutate(id)}
                onCreateGroup={(name) => createGroup.mutate(name)}
                onPatchGroup={(id, body) => patchGroup.mutate({ id, ...body })}
                onDeleteGroup={(id) => deleteGroup.mutate(id)}
                onReorderGroups={reorderGroups}
                onReorderTasks={reorderTasks}
                onCreateTask={(title, groupId) => createInGroup.mutate({ title, groupId })}
                highlightId={highlight}
              />
            </div>
          )}

          {/* Списочный вид: по статусам */}
          {/* Панель массовых действий. Появляется только когда что-то выбрано
              и только в списочном виде — в таблице колонок и так под завязку.

              Держится наверху списка, а не всплывает снизу: выбор идёт сверху
              вниз, и рука уже там. */}
          {view === 'list' && picked.length > 0 && (
            <div className="sticky top-0 z-10 mt-5 flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 shadow-sm">
              <span className="text-sm font-medium tabular-nums">
                {t('tasks.selectedCount', { count: picked.length })}
              </span>

              {/* Статус */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={bulk.isPending}>
                    {t('tasks.statusLabel')}
                    <ChevronDown className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {STATUSES.map((st) => (
                    <DropdownMenuItem key={st} onClick={() => bulk.mutate({ status: st })}>
                      {t(`tasks.status.${st}`)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Исполнитель */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={bulk.isPending}>
                    {t('tasks.assigneeLabel')}
                    <ChevronDown className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                  <DropdownMenuItem onClick={() => bulk.mutate({ assigneeId: null })}>
                    {t('tasks.unassigned')}
                  </DropdownMenuItem>
                  {(membersQ.data ?? []).map((m) => (
                    <DropdownMenuItem key={m.user.id} onClick={() => bulk.mutate({ assigneeId: m.user.id })}>
                      {m.user.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Удаление — последним и с подтверждением: единственное
                  действие здесь, которое нельзя отменить одним кликом. */}
              <Button
                variant="destructive"
                size="sm"
                disabled={bulkDelete.isPending}
                onClick={async () => {
                  if (
                    await confirm({
                      title: t('tasks.bulkDeleteConfirm', { count: picked.length }),
                      destructive: true,
                      confirmLabel: t('files.delete'),
                    })
                  )
                    bulkDelete.mutate()
                }}
              >
                <Trash2 className="size-3.5" />
                {t('files.delete')}
              </Button>

              <div className="ms-auto flex items-center gap-3 text-sm">
                {/* Выбрать всё видимое — по тому, что прошло фильтры, а не по
                    всем задачам проекта: иначе «выбрано 120» относилось бы к
                    тому, чего на экране нет. */}
                <button
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setSelected(new Set(visibleOrder()))}
                >
                  {t('tasks.selectAll')}
                </button>
                <button className="text-muted-foreground hover:text-foreground" onClick={invertSelection}>
                  {t('tasks.invertSelection')}
                </button>
                <button className="text-muted-foreground hover:text-foreground" onClick={clearSelection}>
                  {t('tasks.clearSelection')}
                </button>
              </div>
            </div>
          )}

          {view === 'list' && (
          <div className="mt-5 space-y-6">
            {tasksQ.isLoading && <p className="text-sm text-muted-foreground">…</p>}
            {groups.map(({ status, tasks: list }) => {
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
                    {/* Выбор всей группы. Появляется при наведении на
                        заголовок или когда выбор уже начат — как и чекбоксы
                        строк: в спокойном списке он был бы лишним шумом. */}
                    <label
                      className={cn(
                        'grid size-5 shrink-0 place-items-center transition-opacity',
                        picked.length > 0 ? 'opacity-100' : 'opacity-0 hover:opacity-100 focus-within:opacity-100',
                      )}
                    >
                      <input
                        type="checkbox"
                        // Наполовину — когда отмечена часть группы: иначе
                        // галочка врёт, будто выбрано всё.
                        ref={(el) => {
                          if (!el) return
                          const inGroup = list.filter((x) => selected.has(x.id)).length
                          el.indeterminate = inGroup > 0 && inGroup < list.length
                        }}
                        checked={list.length > 0 && list.every((x) => selected.has(x.id))}
                        onChange={(e) => toggleGroup(list.map((x) => x.id), e.target.checked)}
                        className="size-4 cursor-pointer accent-brand"
                        aria-label={t('tasks.selectGroup')}
                      />
                    </label>
                    <StatusBadge status={status} />
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
                        highlighted={highlight === task.id}
                        canEdit={canEditTask(task)}
                        meId={meId}
                        selected={selected.has(task.id)}
                        selecting={picked.length > 0}
                        onToggleSelect={toggleSelect}
                        dragging={dragId === task.id}
                        dropBefore={dropHint?.status === status && dropHint.beforeId === task.id}
                        onOpen={() => setOpenTaskId(task.id)}
                        onOpenTask={(id) => setOpenTaskId(id)}
                        onStatus={(s) => patch.mutate({ id: task.id, status: s })}
                        onPatch={(body) => patch.mutate({ id: task.id, ...body })}
                        onDelete={() => remove.mutate(task.id)}
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
                        onStartTimer={() => startTimer.mutate({ id: task.id, title: task.title })}
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
  highlighted,
  canEdit,
  meId,
  selected,
  selecting,
  onToggleSelect,
  dragging,
  dropBefore,
  onOpen,
  onOpenTask,
  onStatus,
  onPatch,
  onDelete,
  onDragStart,
  onDragEnd,
  onDragOverRow,
  onDropRow,
  onStartTimer,
}: {
  task: Task
  lang: string
  active: boolean
  /** Только что вернулись из этой задачи — подсвечиваем на пару секунд. */
  highlighted?: boolean
  canEdit: boolean
  /** Выбрана ли задача для массового действия. */
  selected: boolean
  /** Хоть что-то выбрано: тогда чекбоксы видны всегда, а не только при наведении. */
  selecting: boolean
  /** shift — выделить диапазон от прошлой отмеченной. */
  onToggleSelect: (id: string, shift: boolean) => void
  meId?: string
  dragging: boolean
  dropBefore: boolean
  onOpen: () => void
  /** открыть ЧУЖУЮ задачу — из списка зависимостей */
  onOpenTask?: (id: string) => void
  onStatus: (s: Status) => void
  onPatch: (body: Record<string, unknown>) => void
  onDelete: () => void
  onDragStart: () => void
  onDragEnd: () => void
  onDragOverRow: (e: React.DragEvent) => void
  onDropRow: (e: React.DragEvent) => void
  onStartTimer?: () => void
}) {
  const { t } = useTranslation()
  const StatusIcon = STATUS_ICON[task.status]

  return (
    <TaskContextMenu
      task={task}
      canEdit={canEdit}
      meId={meId}
      onPatch={onPatch}
      onDelete={onDelete}
      onStartTimer={onStartTimer}
    >
    <li
      // Возврат из карточки прокручивает список к этой задаче и ставит на неё
      // фокус — иначе человек попадает в начало длинного списка и ищет заново.
      data-task-id={task.id}
      tabIndex={-1}
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
        // Подсветка после возврата: гаснет сама, поэтому переход плавный.
        highlighted && 'border-brand bg-brand/10 transition-colors duration-500',
        dragging && 'opacity-40',
        dropBefore && 'border-t-2 border-t-brand',
        // Ждёт другие задачи — приглушаем: карточка рабочая, просто видно,
        // что брать её рано. При наведении яркость возвращается.
        (task.blockedBy ?? 0) > 0 && task.status !== 'done' && 'opacity-55 hover:opacity-100',
      )}
      onClick={onOpen}
    >
      {/* Чекбокс появляется при наведении или когда выбор уже начат: в
          спокойном списке ряд пустых квадратов только шумит, а как только
          отмечена первая задача — они нужны все сразу. */}
      <label
        className={cn(
          'grid size-5 shrink-0 place-items-center transition-opacity',
          selecting || selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={selected}
          // Клик по чекбоксу не должен открывать задачу — этим занимается
          // строка целиком.
          onChange={() => {}}
          onClick={(e) => {
            e.stopPropagation()
            onToggleSelect(task.id, (e as unknown as { shiftKey: boolean }).shiftKey)
          }}
          className="size-4 cursor-pointer accent-brand"
          aria-label={t('tasks.selectOne', { number: task.number })}
        />
      </label>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button title={t(`tasks.status.${task.status}`)} className="shrink-0" onClick={(e) => e.stopPropagation()}>
            <StatusIcon className={cn('size-[18px] transition-colors', STATUS_COLOR[task.status])} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {STATUSES.map((s) => (
            <DropdownMenuCheckItem key={s} checked={s === task.status} onSelect={() => onStatus(s)}>
              <StatusBadge status={s} />
            </DropdownMenuCheckItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Номер задачи стоит ПЕРЕД названием — и в иврите тоже.

          Инлайном этого не добиться: в RTL-строке первый элемент и есть самый
          правый, поэтому номер уезжал вправо, а название прижималось к нему —
          «testTASK-2». Ни dir, ни isolate, ни plaintext, ни отступы этого не
          меняют: они управляют направлением ВНУТРИ куска, а не тем, с какой
          стороны строки он окажется. Проверено замером всех вариантов.

          Поэтому строка — flex, а порядок в ней задаётся row-reverse: в RTL
          он ставит первый элемент разметки слева. Номеру остаётся dir="ltr",
          чтобы «TASK-9» не читалось как «9-TASK», а min-w-0 на названии —
          чтобы обрезалось многоточием именно оно, а не номер. */}
      <span
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5 text-sm rtl:flex-row-reverse rtl:justify-end',
          task.status === 'done' && 'text-muted-foreground line-through',
        )}
      >
        <span dir="ltr" className="shrink-0 text-xs text-muted-foreground">
          {task.number}
        </span>
        <bdi className="min-w-0 truncate">{task.title}</bdi>
      </span>

      {/* Свой номер задачи — рядом с нашим: по нему её и ищут в макете. */}
      <TaskRefs value={task.refs} canEdit={canEdit} compact onChange={(refs) => onPatch({ refs })} className="shrink-0" />

      {/* Зависимости: замочек — ждёт, восклицательный — держит других. */}
      <TaskBlockedMark
        taskId={task.id}
        blockedBy={task.blockedBy}
        blocking={task.blocking}
        done={task.status === 'done'}
        onOpenTask={onOpenTask}
      />

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
        {/* Срок — до аватара: он про работу, а аватар про человека, и группа
            «что за задача» не должна разрываться лицом посередине. */}
        <DueDate due={task.dueDate} done={task.status === 'done'} compact />
        {task.assignee && <Avatar name={task.assignee.name} src={task.assignee.avatarUrl} size={22} title={task.assignee.name} />}
      </span>
    </li>
    </TaskContextMenu>
  )
}
