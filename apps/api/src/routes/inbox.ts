import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notifications, projectMembers, projects, tasks, users, userNotificationPrefs } from '../db/schema.js'
import { requireSession, type SessionEnv } from '../auth.js'
import { broadcast } from '../ws.js'

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

/**
 * Мои открытые задачи по ВСЕМ проектам (SPEC §8.33).
 *
 * Задачи всегда живут в проекте, но вопрос «что мне делать» проекта не знает:
 * в трее и в мобильном человек смотрит на список дел целиком, а не сначала
 * выбирает, где искать. Отсюда — session-токен и обход всех проектов, где он
 * состоит.
 */
inboxRoute.get('/tasks', async (c) => {
  const { sub } = c.get('session')
  const rows = await db
    .select({ t: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .innerJoin(projectMembers, and(eq(projectMembers.projectId, tasks.projectId), eq(projectMembers.userId, sub)))
    // Завершённые за трое суток остаются в списке: «готово» нажимают и
    // случайно, и вернуть статус удобнее там же, где его сменили, — а не
    // идти в приложение искать задачу, которая только что исчезла.
    .where(
      and(
        eq(tasks.assigneeId, sub),
        isNull(tasks.deletedAt),
        or(sql`${tasks.status} <> 'done'`, gte(tasks.updatedAt, sql`now() - interval '3 days'`)),
      ),
    )
    .orderBy(desc(tasks.updatedAt))
    .limit(60)

  return c.json({
    items: rows.map((r) => ({
      id: r.t.id,
      number: r.t.number,
      title: r.t.title,
      status: r.t.status,
      priority: r.t.priority,
      dueDate: r.t.dueDate,
      project: { id: r.project.id, name: r.project.name, color: r.project.color },
    })),
  })
})

/**
 * Сменить статус СВОЕЙ задачи из любого проекта (SPEC §8.33).
 *
 * Обычная правка задачи требует project-токена, а трей показывает задачи из
 * всех проектов сразу — переключать токен ради одного клика бессмысленно.
 * Поэтому здесь узкая операция: только статус и только у задачи, которая на
 * тебя назначена.
 */
inboxRoute.patch(
  '/tasks/:taskId',
  zValidator('json', z.object({ status: z.enum(['todo', 'in_progress', 'review', 'done']) })),
  async (c) => {
    const { sub } = c.get('session')
    const { status } = c.req.valid('json')
    const taskId = c.req.param('taskId')

    const task = await db.query.tasks.findFirst({ where: and(eq(tasks.id, taskId), isNull(tasks.deletedAt)) })
    if (!task) return c.json({ error: 'Not found' }, 404)

    // Только своя задача: этот путь в обход проектных прав, и расширять его
    // до чужих задач нельзя.
    if (task.assigneeId !== sub) return c.json({ error: 'Not your task' }, 403)

    const [updated] = await db
      .update(tasks)
      .set({ status, updatedAt: new Date() })
      .where(eq(tasks.id, taskId))
      .returning()

    broadcast(task.projectId, 'tasks', { action: 'update', id: taskId })
    return c.json({ id: updated!.id, status: updated!.status })
  },
)

// Пометить прочитанными: конкретные id / сущность / весь проект / всё
inboxRoute.post(
  '/read',
  zValidator(
    'json',
    z.object({
      ids: z.array(z.string()).optional(),
      projectId: z.string().optional(),
      all: z.boolean().optional(),
      // Погасить всё, что вело на эту задачу или сообщение. Открыв задачу,
      // человек прочитал уведомление о ней — и не только то, по которому
      // пришёл: на одну задачу их накапливается несколько (назначили,
      // упомянули, прокомментировали), и гасить их по одному руками — работа,
      // которую он делать не станет. Бейдж после этого не сходился с тем, что
      // человек уже видел.
      entityType: z.string().optional(),
      entityId: z.string().optional(),
    }),
  ),
  async (c) => {
    const { sub } = c.get('session')
    const { ids, projectId, all, entityType, entityId } = c.req.valid('json')
    const now = new Date()
    if (all) {
      await db.update(notifications).set({ readAt: now }).where(and(eq(notifications.userId, sub), isNull(notifications.readAt)))
    } else if (entityType && entityId) {
      await db
        .update(notifications)
        .set({ readAt: now })
        .where(
          and(
            eq(notifications.userId, sub),
            eq(notifications.entityType, entityType),
            eq(notifications.entityId, entityId),
            isNull(notifications.readAt),
          ),
        )
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
