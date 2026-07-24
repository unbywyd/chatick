import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notificationOptOuts, taskReminders } from '../db/schema.js'
import { requireProject, type ProjectEnv } from '../auth.js'

// Уведомления и подписки (SPEC §8.9). Project-токен.
export const notificationsRoute = new Hono<ProjectEnv>()
notificationsRoute.use('*', requireProject)

const EVENTS = [
  'chat_mention',
  'task_mention',
  'comment_mention',
  'task_assigned',
  'task_status',
  'task_comment',
] as const

// Мои подписки в проекте: по умолчанию всё включено; возвращаем карту event→enabled.
notificationsRoute.get('/prefs', async (c) => {
  const { projectId, sub } = c.get('auth')
  const optOuts = await db.query.notificationOptOuts.findMany({
    where: and(eq(notificationOptOuts.projectId, projectId), eq(notificationOptOuts.userId, sub)),
  })
  const off = new Set(optOuts.map((o) => o.event))
  const prefs = Object.fromEntries(EVENTS.map((e) => [e, !off.has(e)]))
  return c.json({ prefs })
})

// Подписаться/отписаться от события (запись в opt-outs появляется при enabled=false).
notificationsRoute.patch(
  '/prefs',
  zValidator('json', z.object({ event: z.enum(EVENTS), enabled: z.boolean() })),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    const { event, enabled } = c.req.valid('json')
    if (enabled) {
      await db
        .delete(notificationOptOuts)
        .where(
          and(
            eq(notificationOptOuts.projectId, projectId),
            eq(notificationOptOuts.userId, sub),
            eq(notificationOptOuts.event, event),
          ),
        )
    } else {
      await db
        .insert(notificationOptOuts)
        .values({ projectId, userId: sub, event })
        .onConflictDoNothing()
    }
    return c.json({ ok: true })
  },
)

// --- Напоминания об открытых задачах (per-project, настраивают owner/admin) ---

notificationsRoute.get('/reminders', async (c) => {
  const { projectId } = c.get('auth')
  const row = await db.query.taskReminders.findFirst({ where: eq(taskReminders.projectId, projectId) })
  return c.json({ reminder: row ?? null })
})

const reminderSchema = z.object({
  enabled: z.boolean(),
  cadence: z.enum(['hourly', 'daily', 'weekly']),
  everyHours: z.number().int().min(1).max(24),
  hourOfDay: z.number().int().min(0).max(23),
  dayOfWeek: z.number().int().min(0).max(6),
  audience: z.enum(['all_members', 'assignees']),
  statuses: z.array(z.enum(['todo', 'in_progress', 'review', 'done'])).min(1),
})

notificationsRoute.put('/reminders', zValidator('json', reminderSchema), async (c) => {
  const { projectId, sub, role } = c.get('auth')
  if (role !== 'owner' && role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
  const b = c.req.valid('json')
  const values = {
    enabled: b.enabled,
    cadence: b.cadence,
    everyHours: String(b.everyHours),
    hourOfDay: String(b.hourOfDay),
    dayOfWeek: String(b.dayOfWeek),
    audience: b.audience,
    statuses: b.statuses.join(','),
  }
  const existing = await db.query.taskReminders.findFirst({ where: eq(taskReminders.projectId, projectId) })
  if (existing) {
    await db.update(taskReminders).set(values).where(eq(taskReminders.projectId, projectId))
  } else {
    await db.insert(taskReminders).values({ projectId, createdById: sub, ...values })
  }
  const row = await db.query.taskReminders.findFirst({ where: eq(taskReminders.projectId, projectId) })
  return c.json({ reminder: row })
})
