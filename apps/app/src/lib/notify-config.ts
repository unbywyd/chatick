// Настройки уведомлений: компания задаёт, проект переопределяет (SPEC §8.9).
// Зеркало apps/api/src/lib/notify-config.ts — держать в согласии.

export const NOTIFY_EVENTS = [
  'chat_mention',
  'task_mention',
  'comment_mention',
  'task_assigned',
  'task_status',
  'task_comment',
  'task_due',
] as const

export type NotifyEvent = (typeof NOTIFY_EVENTS)[number]

export type NotifyConfig = {
  events: Record<NotifyEvent, boolean>
  /** За сколько часов до срока предупреждать. */
  dueLeadHours: number
}

export const DEFAULT_NOTIFY_CONFIG: NotifyConfig = {
  events: Object.fromEntries(NOTIFY_EVENTS.map((e) => [e, true])) as Record<NotifyEvent, boolean>,
  dueLeadHours: 24,
}
