import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, ilike, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { activityLog, users } from '../db/schema.js'
import { requireProject, type ProjectEnv } from '../auth.js'

// Журнал действий проекта (SPEC §8.21). Project-токен; видят все участники.
export const activityRoute = new Hono<ProjectEnv>()
activityRoute.use('*', requireProject)

activityRoute.get(
  '/',
  zValidator(
    'query',
    z.object({
      q: z.string().optional(),
      actorId: z.string().optional(),
      entityType: z.string().optional(),
      action: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      page: z.coerce.number().min(1).default(1),
    }),
  ),
  async (c) => {
    const { projectId } = c.get('auth')
    const { q, actorId, entityType, action, from, to, page } = c.req.valid('query')
    const PAGE = 50
    const conds = [eq(activityLog.projectId, projectId)]
    if (q && q.trim()) conds.push(ilike(activityLog.entityLabel, `%${q.trim()}%`))
    if (actorId) conds.push(eq(activityLog.actorId, actorId))
    if (entityType) conds.push(eq(activityLog.entityType, entityType))
    if (action) conds.push(eq(activityLog.action, action as 'create'))
    if (from && !isNaN(Date.parse(from))) conds.push(sql`${activityLog.createdAt} >= ${new Date(from)}`)
    if (to && !isNaN(Date.parse(to))) conds.push(sql`${activityLog.createdAt} <= ${new Date(to + 'T23:59:59')}`)

    const rows = await db
      .select({ a: activityLog, actor: users })
      .from(activityLog)
      .leftJoin(users, eq(users.id, activityLog.actorId))
      .where(and(...conds))
      .orderBy(desc(activityLog.createdAt))
      .limit(PAGE + 1)
      .offset((page - 1) * PAGE)

    const hasMore = rows.length > PAGE
    return c.json({
      page,
      hasMore,
      items: rows.slice(0, PAGE).map((r) => ({
        id: r.a.id,
        action: r.a.action,
        entityType: r.a.entityType,
        entityId: r.a.entityId,
        entityLabel: r.a.entityLabel,
        meta: r.a.meta ? JSON.parse(r.a.meta) : null,
        createdAt: r.a.createdAt,
        actor: r.actor ? { id: r.actor.id, name: r.actor.name, avatarUrl: r.actor.avatarUrl } : null, // null = ИИ/система
      })),
    })
  },
)
