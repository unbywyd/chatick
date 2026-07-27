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
  sortOrder: number
  dueDate: string | null
  assignee: { id: string; name: string; avatarUrl: string | null } | null
  createdById: string | null
  createdAt: string
  attachmentsCount: number
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

// Цвета статусов: путь задачи серый → синий → фиолетовый → лайм
export const STATUS_COLOR: Record<Status, string> = {
  todo: 'text-muted-foreground',
  in_progress: 'text-sky-400',
  review: 'text-violet-400',
  done: 'text-brand',
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
