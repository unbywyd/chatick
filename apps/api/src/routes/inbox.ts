import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notifications, projects, users, userNotificationPrefs } from '../db/schema.js'
import { requireSession, type SessionEnv } from '../auth.js'

// Глобальные in-app уведомления пользователя (SPEC §8.22) — session-токен,
// уведомления из ВСЕХ проектов, сгруппированные по проекту на клиенте.
export const inboxRoute = new Hono<SessionEnv>()
inboxRoute.use('*', requireSession)

// Список уведомлений (по умолчанию — непрочитанные сверху) + счётчики по проектам
inboxRoute.get('/', zValidator('query', z.object({ onlyUnread: z.string().optional(), limit: z.coerce.number().max(200).default(100) })), async (c) => {
  const { sub } = c.get('session')
  const { onlyUnread, limit } = c.req.valid('query')

  const conds = [eq(notifications.userId, sub)]
  if (onlyUnread === '1') conds.push(isNull(notifications.readAt))

  const rows = await db
    .select({ n: notifications, project: projects, actor: users })
    .from(notifications)
    .innerJoin(projects, eq(projects.id, notifications.projectId))
    .leftJoin(users, eq(users.id, notifications.actorId))
    .where(and(...conds))
    .orderBy(desc(notifications.createdAt))
    .limit(limit)

  // общий счётчик непрочитанных + по проектам
  const counts = await db
    .select({ projectId: notifications.projectId, count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, sub), isNull(notifications.readAt)))
    .groupBy(notifications.projectId)

  const unreadByProject = Object.fromEntries(counts.map((r) => [r.projectId, r.count]))
  const unreadTotal = counts.reduce((s, r) => s + r.count, 0)

  return c.json({
    unreadTotal,
    unreadByProject,
    items: rows.map((r) => ({
      id: r.n.id,
      projectId: r.n.projectId,
      projectName: r.project.name,
      event: r.n.event,
      title: r.n.title,
      summary: r.n.summary,
      body: r.n.body,
      link: r.n.link,
      entityType: r.n.entityType,
      entityId: r.n.entityId,
      readAt: r.n.readAt,
      createdAt: r.n.createdAt,
      actor: r.actor ? { id: r.actor.id, name: r.actor.name, avatarUrl: r.actor.avatarUrl } : null,
    })),
  })
})

// Только счётчик (для бейджа — дёшево, часто)
inboxRoute.get('/count', async (c) => {
  const { sub } = c.get('session')
  const [{ n }] = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, sub), isNull(notifications.readAt)))) as [{ n: number }]
  return c.json({ unread: n })
})

// Пометить прочитанными: конкретные id / весь проект / всё
inboxRoute.post(
  '/read',
  zValidator('json', z.object({ ids: z.array(z.string()).optional(), projectId: z.string().optional(), all: z.boolean().optional() })),
  async (c) => {
    const { sub } = c.get('session')
    const { ids, projectId, all } = c.req.valid('json')
    const now = new Date()
    if (all) {
      await db.update(notifications).set({ readAt: now }).where(and(eq(notifications.userId, sub), isNull(notifications.readAt)))
    } else if (projectId) {
      await db
        .update(notifications)
        .set({ readAt: now })
        .where(and(eq(notifications.userId, sub), eq(notifications.projectId, projectId), isNull(notifications.readAt)))
    } else if (ids?.length) {
      await db.update(notifications).set({ readAt: now }).where(and(eq(notifications.userId, sub), inArray(notifications.id, ids)))
    }
    return c.json({ ok: true })
  },
)

// Персональные настройки (суточный дайджест)
inboxRoute.get('/prefs', async (c) => {
  const { sub } = c.get('session')
  const p = await db.query.userNotificationPrefs.findFirst({ where: eq(userNotificationPrefs.userId, sub) })
  return c.json({ dailyDigest: p?.dailyDigest ?? true, digestHourUtc: Number(p?.digestHourUtc ?? 9) })
})

inboxRoute.put(
  '/prefs',
  zValidator('json', z.object({ dailyDigest: z.boolean(), digestHourUtc: z.number().int().min(0).max(23) })),
  async (c) => {
    const { sub } = c.get('session')
    const { dailyDigest, digestHourUtc } = c.req.valid('json')
    const existing = await db.query.userNotificationPrefs.findFirst({ where: eq(userNotificationPrefs.userId, sub) })
    if (existing) {
      await db.update(userNotificationPrefs).set({ dailyDigest, digestHourUtc: String(digestHourUtc) }).where(eq(userNotificationPrefs.userId, sub))
    } else {
      await db.insert(userNotificationPrefs).values({ userId: sub, dailyDigest, digestHourUtc: String(digestHourUtc) })
    }
    return c.json({ ok: true })
  },
)
