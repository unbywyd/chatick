import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { projectFeatures, projectIntegrations, projectMembers, projects, releases, users } from '../db/schema.js'
import { requireSession, type SessionEnv } from '../auth.js'
import { canCreateProjects, companyRoleOf, hasPermission } from './projects.js'
import { serialize, tasksForReleases } from './releases.js'

/**
 * Версии всех проектов компании одним запросом — для экрана «Версии» в v2.
 *
 * Зачем отдельная ручка: в v2 один экран на компанию, а /api/v1/releases
 * живёт внутри проекта. Обход проектов с клиента — это запрос на каждый
 * проект (у StartPlan их больше тридцати) плюс запрос вебхука на каждый
 * включённый; на копии базы такой обход шёл 8 секунд. Здесь — один.
 *
 * Права те же, что у проектной ручки, и проверяются для КАЖДОГО проекта:
 * видимость проекта (участник или менеджер/админ компании), включённая
 * функция releases и releases.read. Только чтение; секрет вебхука сюда не
 * попадает — его отдаёт /api/v1/integrations/expo тем, у кого releases.manage.
 */
export const releasesCompanyRoute = new Hono<SessionEnv>()
releasesCompanyRoute.use('*', requireSession)

releasesCompanyRoute.get('/', zValidator('query', z.object({ companyId: z.string().min(1) })), async (c) => {
  const { sub } = c.get('session')
  const { companyId } = c.req.valid('query')
  const role = await companyRoleOf(companyId, sub)
  if (!role) return c.json({ error: 'Forbidden' }, 403)

  // Видимые проекты — по тому же правилу, что и список проектов компании.
  const all = await db.query.projects.findMany({ where: and(eq(projects.companyId, companyId), isNull(projects.archivedAt)) })
  let ids = all.map((p) => p.id)
  if (!canCreateProjects(role) && ids.length) {
    const mine = await db.query.projectMembers.findMany({ where: and(eq(projectMembers.userId, sub), inArray(projectMembers.projectId, ids)) })
    const set = new Set(mine.map((m) => m.projectId))
    ids = ids.filter((id) => set.has(id))
  }
  if (!ids.length) return c.json({ projects: {}, items: [] })

  const on = await db.query.projectFeatures.findMany({
    where: and(inArray(projectFeatures.projectId, ids), eq(projectFeatures.feature, 'releases')),
  })
  const readable: string[] = []
  for (const f of on) if (await hasPermission(f.projectId, sub, 'releases.read')) readable.push(f.projectId)
  if (!readable.length) return c.json({ projects: {}, items: [] })

  const hooks = await db.query.projectIntegrations.findMany({
    where: and(inArray(projectIntegrations.projectId, readable), eq(projectIntegrations.kind, 'expo')),
  })
  const hookBy = new Map(hooks.map((h) => [h.projectId, h]))

  const rows = await db
    .select({ r: releases, u: users })
    .from(releases)
    .leftJoin(users, eq(users.id, releases.ownerId))
    .where(inArray(releases.projectId, readable))
    .orderBy(desc(releases.createdAt))
    .limit(1000)
  const byRelease = await tasksForReleases(rows.map((x) => x.r.id))

  return c.json({
    // Проекты, где версии включены и видны; остальных здесь нет — «выключено».
    projects: Object.fromEntries(
      readable.map((id) => {
        const h = hookBy.get(id)
        return [id, { expo: { connected: Boolean(h), live: Boolean(h?.lastEventAt) } }]
      }),
    ),
    items: rows.map((x) => ({ ...serialize(x.r, x.u, byRelease.get(x.r.id)), projectId: x.r.projectId })),
  })
})
