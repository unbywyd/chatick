import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notificationOptOuts, projects, taskReminders } from '../db/schema.js'
import { requireProject, type ProjectEnv } from '../auth.js'
import { NOTIFY_EVENTS, notifyConfigForProject } from '../lib/notify-config.js'

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
  // Срок задачи — тоже личная подписка: кому-то напоминание нужно, кто-то
  // ведёт сроки в своём календаре и второй раз о них слышать не хочет.
  'task_due',
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

/**
 * Настройки уведомлений проекта: что рассылаем и за сколько предупреждаем о
 * сроке. Показываем ЭФФЕКТИВНЫЕ — с учётом унаследованного от компании, иначе
 * человек видит умолчания вместо того, что работает на самом деле.
 *
 * inherited говорит, откуда значения: у проекта своих настроек нет, и
 * интерфейс должен честно сказать «как в компании», а не делать вид, что это
 * выбор проекта.
 */
notificationsRoute.get('/config', async (c) => {
  const { projectId, role } = c.get('auth')
  const own = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  const raw = (own?.notifyConfig ?? '').trim()
  return c.json({
    config: await notifyConfigForProject(projectId),
    inherited: !raw || raw === '{}',
    canEdit: role === 'owner' || role === 'admin',
  })
})

notificationsRoute.patch(
  '/config',
  zValidator(
    'json',
    z.object({
      events: z.record(z.enum(NOTIFY_EVENTS), z.boolean()).optional(),
      dueLeadHours: z.number().int().min(1).max(24 * 14).optional(),
      /** Вернуть проект к настройкам компании. */
      inherit: z.boolean().optional(),
    }),
  ),
  async (c) => {
    const { projectId, role } = c.get('auth')
    if (role !== 'owner' && role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
    const b = c.req.valid('json')

    if (b.inherit) {
      await db.update(projects).set({ notifyConfig: '{}' }).where(eq(projects.id, projectId))
      return c.json({ config: await notifyConfigForProject(projectId), inherited: true })
    }

    if (!Object.keys(b).length) return c.json({ error: 'Nothing to change.' }, 400)
    // Отталкиваемся от ЭФФЕКТИВНЫХ настроек, а не от пустых: первое изменение
    // в проекте не должно сбрасывать остальное к общим умолчаниям, потеряв
    // то, что настроено у компании.
    const current = await notifyConfigForProject(projectId)
    const merged = { ...current, ...b, events: { ...current.events, ...(b.events ?? {}) } }
    delete (merged as { inherit?: boolean }).inherit
    await db.update(projects).set({ notifyConfig: JSON.stringify(merged) }).where(eq(projects.id, projectId))
    return c.json({ config: merged, inherited: false })
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
  // антиспам: не чаще раза в полдня (SPEC §8.9)
  everyHours: z.number().int().min(12).max(24),
  hourOfDay: z.number().int().min(0).max(23),
  dayOfWeek: z.number().int().min(0).max(6),
  audience: z.enum(['all_members', 'assignees']),
  statuses: z.array(z.enum(['todo', 'in_progress', 'review', 'verified', 'done'])).min(1),
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
