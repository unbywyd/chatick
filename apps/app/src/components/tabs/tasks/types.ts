import { Circle, CircleCheck, CircleDot, Eye } from 'lucide-react'

export const STATUSES = ['todo', 'in_progress', 'review', 'done'] as const
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export type Status = (typeof STATUSES)[number]
export type Priority = (typeof PRIORITIES)[number]

export type Task = {
  id: string
  number: string
  groupId: string | null
  title: string
  description: string
  status: Status
  priority: Priority
  estimateMinutes: number | null
  /** свои номера задачи: экраны в макете, пункты договора — см. TaskRefs */
  refs?: string
  sortOrder: number
  dueDate: string | null
  assignee: { id: string; name: string; avatarUrl: string | null } | null
  createdById: string | null
  createdAt: string
  attachmentsCount: number
  /** Сколько НЕЗАВЕРШЁННЫХ задач она ждёт: замочек гаснет сам, связь остаётся. */
  blockedBy?: number
  /** Сколько задач ждут её — насколько она держит проект. */
  blocking?: number
  /**
   * Ресурсы задачи: стенд, ключ, база. Только имя и ссылка — есть ли под
   * ресурсом секреты и кому они открыты, решает сам ресурс.
   */
  resources?: { id: string; name: string; url: string | null }[]
  /**
   * Версии, в которых уезжает задача, — со стадией.
   *
   * Стадия здесь не украшение: «уедет в 1.4» без ответа «а где сейчас 1.4»
   * заставляет открывать вкладку версий ради одного слова.
   */
  releases?: {
    id: string
    version: string
    buildType: string
    status: string
    statusLabel: string
    isLive: boolean
  }[]
}

export type TaskGroup = {
  id: string
  name: string
  color: string
  sortOrder: number
}

export type Member = {
  id: string
  role: string
  permissions?: Record<string, boolean>
  user: { id: string; name: string; email: string; avatarUrl: string | null }
}

export const STATUS_ICON: Record<Status, typeof Circle> = {
  todo: Circle,
  in_progress: CircleDot,
  review: Eye,
  done: CircleCheck,
}

// Цвета статусов: путь задачи серый → жёлтый → голубой → зелёный
export const STATUS_COLOR: Record<Status, string> = {
  todo: 'text-muted-foreground',
  in_progress: 'text-amber-500',
  review: 'text-sky-500',
  done: 'text-emerald-600',
}

/**
 * Статус тегом, а не иконкой с подписью.
 *
 * Иконка в 14 пикселей плюс обычный текст не читались списком: чтобы понять,
 * где какая задача, приходилось вчитываться в каждую строку. Тег с заливкой
 * считывается боковым зрением — по цветовому пятну, ещё до чтения слова.
 *
 * Заливка светлая и цветная, текст тёмный: цветной текст на цветном фоне даёт
 * низкий контраст, а нам нужно, чтобы слово оставалось читаемым, а не только
 * узнаваемым. В тёмной теме то же самое наоборот — светлый текст на глухой
 * подложке того же тона, иначе светло-жёлтая плашка выжигает глаз.
 *
 * Цвета взяты по смыслу, а не по «пути»: серый — ещё не трогали, жёлтый — в
 * работе, голубой — ждёт чужого действия, зелёный — закрыто.
 */
export const STATUS_BADGE: Record<Status, string> = {
  todo: 'bg-muted text-foreground/80 dark:bg-muted dark:text-foreground/80',
  in_progress: 'bg-amber-100 text-amber-950 dark:bg-amber-500/20 dark:text-amber-200',
  review: 'bg-sky-100 text-sky-950 dark:bg-sky-500/20 dark:text-sky-200',
  done: 'bg-emerald-100 text-emerald-950 dark:bg-emerald-500/20 dark:text-emerald-200',
}

/** Заливка кружка статуса — для выпадающих меню, где тег был бы шумным. */
export const STATUS_DOT: Record<Status, string> = {
  todo: 'bg-muted-foreground/50',
  in_progress: 'bg-amber-500',
  review: 'bg-sky-500',
  done: 'bg-emerald-600',
}

export const PRIORITY_COLOR: Record<Priority, string> = {
  low: 'text-muted-foreground',
  normal: 'text-foreground/70',
  high: 'text-orange-400',
  urgent: 'text-destructive',
}

// Заливка кружков приоритета (чипы)
export const PRIORITY_DOT: Record<Priority, string> = {
  low: 'bg-muted-foreground',
  normal: 'bg-foreground/70',
  high: 'bg-orange-400',
  urgent: 'bg-destructive',
}

export function isOverdue(t: Task) {
  return Boolean(t.dueDate && t.status !== 'done' && new Date(t.dueDate).getTime() < Date.now())
}

/** Срок горит, но ещё не прошёл: сегодня или завтра. */
export function isDueSoon(t: Task) {
  if (!t.dueDate || t.status === 'done') return false
  const left = dueDays(t.dueDate)
  return left !== null && left >= 0 && left <= 1
}

/**
 * Насколько горит срок — четыре ступени вместо двух.
 *
 * В таблице на строку не влезает ни дата, ни «осталось столько-то»: там колонок
 * и так под завязку. Остаётся точка цвета, и по ней надо понимать не только
 * «просрочено или нет», а насколько близко. Отсюда ступени: зелёный — время
 * есть, жёлтый — на этой неделе, оранжевый — сегодня-завтра, красный — прошло.
 *
 * Порог недели, а не месяца: дальше недели любой срок одинаково «потом», и
 * дробить это оттенками значит требовать от человека различать зелёные.
 *
 * Выполненную задачу не красим вовсе — done важнее любого срока.
 */
export type DueLevel = 'overdue' | 'urgent' | 'soon' | 'far'

export function dueLevel(t: Task): DueLevel | null {
  if (!t.dueDate || t.status === 'done') return null
  const left = dueDays(t.dueDate)
  if (left === null) return null
  if (left < 0) return 'overdue'
  if (left <= 1) return 'urgent'
  if (left <= 7) return 'soon'
  return 'far'
}

export const DUE_COLOR: Record<DueLevel, string> = {
  overdue: 'text-destructive',
  urgent: 'text-orange-500',
  soon: 'text-amber-500',
  far: 'text-emerald-600',
}

/**
 * Сколько суток до срока: 0 — сегодня, отрицательное — просрочено.
 *
 * Считаем по календарным дням, а не по разнице в миллисекундах: срок стоит на
 * дате, и «осталось 0.4 дня» человеку ничего не говорит. Обе даты приводим к
 * полуночи — иначе задача, поставленная на сегодня в 9 утра, после обеда
 * показывала бы «просрочено», хотя день ещё идёт.
 */
export function dueDays(due: string | null): number | null {
  if (!due) return null
  const d = new Date(due)
  if (Number.isNaN(d.getTime())) return null
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  return Math.round((midnight(d) - midnight(new Date())) / 86_400_000)
}

// Оценка времени: минуты → компактно «2ч 30м» / «45м» / «3ч» (SPEC §8.13)
/**
 * Оценка времени в том же виде, что и в трекере: 2:30.
 *
 * Один формат на всё приложение — иначе человек видит «2ч 30м», вводит 230 и
 * не понимает, почему получилось 3:50. Ввод разбирает parseDuration.
 */
export function fmtEstimate(mins: number | null): string {
  if (!mins || mins <= 0) return ''
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`
}
