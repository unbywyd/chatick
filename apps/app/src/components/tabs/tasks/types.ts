import { Circle, CircleCheck, CircleDot, Eye } from 'lucide-react'

export const STATUSES = ['todo', 'in_progress', 'review', 'done'] as const
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export type Status = (typeof STATUSES)[number]
export type Priority = (typeof PRIORITIES)[number]

export type Task = {
  id: string
  number: string
  title: string
  description: string
  status: Status
  priority: Priority
  sortOrder: number
  dueDate: string | null
  assignee: { id: string; name: string; avatarUrl: string | null } | null
  createdById: string | null
  createdAt: string
  attachmentsCount: number
}

export type Member = {
  id: string
  role: string
  user: { id: string; name: string; email: string; avatarUrl: string | null }
}

export const STATUS_ICON: Record<Status, typeof Circle> = {
  todo: Circle,
  in_progress: CircleDot,
  review: Eye,
  done: CircleCheck,
}

export const PRIORITY_COLOR: Record<Priority, string> = {
  low: 'text-muted-foreground',
  normal: 'text-foreground/70',
  high: 'text-orange-400',
  urgent: 'text-destructive',
}

export function isOverdue(t: Task) {
  return Boolean(t.dueDate && t.status !== 'done' && new Date(t.dueDate).getTime() < Date.now())
}
