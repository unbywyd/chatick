import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { releases, releaseEvents, taskReleases, tasks, users } from '../db/schema.js'
import { requireProject, type ProjectEnv } from '../auth.js'
import { hasPermission } from './projects.js'
import { isFeatureEnabled } from '../lib/features.js'
import { BUILD_TYPES, buildType, firstStage, isLiveStage, isValidStage } from '../lib/release-stages.js'
import { logActivity } from '../lib/audit.js'
import { broadcast } from '../ws.js'

/**
 * Версии проекта (SPEC §8.46): что и куда выкачено.
 *
 * Отвечает на вопрос, который сейчас задают голосом в переписке: «какая версия
 * в проде». Ответ должен лежать на странице, а не в памяти человека.
 *
 * Функция включается отдельно и по умолчанию выключена, поэтому КАЖДАЯ ручка
 * начинается с проверки. Спрятанная вкладка ничего не защищает: и мост, и
 * прямой запрос обходят интерфейс, не заметив его.
 */
export const releasesRoute = new Hono<ProjectEnv>()
releasesRoute.use('*', requireProject)

/**
 * Общий вход: функция включена и права на месте.
 *
 * Одной функцией, а не тремя строками в каждой ручке: забытая проверка здесь
 * означает доступ к чужим релизам, и заметить это по коду ручки невозможно.
 */
async function guard(c: { get: (k: 'auth') => { projectId: string; sub: string } }, need: 'releases.read' | 'releases.manage') {
  const { projectId, sub } = c.get('auth')
  if (!(await isFeatureEnabled(projectId, 'releases'))) {
    return { error: 'Releases are turned off for this project', status: 404 as const }
  }
  if (!(await hasPermission(projectId, sub, need))) {
    return { error: 'Forbidden', status: 403 as const }
  }
  return { projectId, sub }
}

const serialize = (
  r: typeof releases.$inferSelect,
  owner?: { id: string; name: string; avatarUrl: string | null } | null,
  linkedTasks?: { id: string; number: string; title: string; status: string }[],
) => ({
  id: r.id,
  version: r.version,
  buildType: r.buildType,
  buildTypeLabel: buildType(r.buildType)?.label ?? r.buildType,
  status: r.status,
  statusLabel: buildType(r.buildType)?.stages.find((s) => s.key === r.status)?.label ?? r.status,
  isLive: isLiveStage(r.buildType, r.status),
  /** Автор версии. Кому поручено — только в связанной задаче, второго поля нет. */
  owner: owner ?? null,
  referenceUrl: r.referenceUrl,
  notes: r.notes,
  releasedAt: r.releasedAt,
  tasks: linkedTasks ?? [],
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
})

/** Задачи, связанные с версиями. Одним запросом: иначе N+1 на каждой строке. */
async function tasksForReleases(releaseIds: string[]) {
  const map = new Map<string, { id: string; number: string; title: string; status: string }[]>()
  if (!releaseIds.length) return map
  const rows = await db
    .select({ releaseId: taskReleases.releaseId, t: tasks })
    .from(taskReleases)
    .innerJoin(tasks, eq(tasks.id, taskReleases.taskId))
    .where(inArray(taskReleases.releaseId, releaseIds))
  for (const row of rows) {
    const list = map.get(row.releaseId) ?? []
    list.push({ id: row.t.id, number: row.t.number, title: row.t.title, status: row.t.status })
    map.set(row.releaseId, list)
  }
  return map
}

/** Наборы стадий — интерфейсу, чтобы не дублировать лестницы на клиенте. */
releasesRoute.get('/build-types', async (c) => {
  const g = await guard(c as never, 'releases.read')
  if ('error' in g) return c.json({ error: g.error }, g.status)
  return c.json({ buildTypes: BUILD_TYPES })
})

releasesRoute.get('/', async (c) => {
  const g = await guard(c as never, 'releases.read')
  if ('error' in g) return c.json({ error: g.error }, g.status)

  const rows = await db
    .select({ r: releases, u: users })
    .from(releases)
    .leftJoin(users, eq(users.id, releases.ownerId))
    .where(eq(releases.projectId, g.projectId))
    .orderBy(desc(releases.createdAt))
    .limit(200)

  const byRelease = await tasksForReleases(rows.map((x) => x.r.id))

  /**
   * Сводка «что сейчас в проде» — то, ради чего страницу открывают.
   *
   * Считается здесь, а не на клиенте: правило «последняя доехавшая версия
   * этого типа» одно, и разъехаться двум его копиям нельзя.
   */
  const live: Record<string, { version: string; releasedAt: Date | null; id: string }> = {}
  for (const { r } of rows) {
    if (!isLiveStage(r.buildType, r.status)) continue
    const cur = live[r.buildType]
    // rows отсортированы по createdAt: первая встреченная и есть последняя.
    if (!cur) live[r.buildType] = { version: r.version, releasedAt: r.releasedAt, id: r.id }
  }

  return c.json({
    items: rows.map((x) => serialize(x.r, x.u, byRelease.get(x.r.id))),
    live,
  })
})

releasesRoute.get('/:id', async (c) => {
  const g = await guard(c as never, 'releases.read')
  if ('error' in g) return c.json({ error: g.error }, g.status)

  const row = await db
    .select({ r: releases, u: users })
    .from(releases)
    .leftJoin(users, eq(users.id, releases.ownerId))
    .where(and(eq(releases.id, c.req.param('id')), eq(releases.projectId, g.projectId)))
    .limit(1)
  if (!row.length) return c.json({ error: 'Not found' }, 404)

  // Лента стадий: зачем версия неделю висит в ревью — ответ здесь.
  const events = await db
    .select({ e: releaseEvents, u: users })
    .from(releaseEvents)
    .leftJoin(users, eq(users.id, releaseEvents.actorId))
    .where(eq(releaseEvents.releaseId, row[0]!.r.id))
    .orderBy(desc(releaseEvents.createdAt))

  const byRelease = await tasksForReleases([row[0]!.r.id])
  return c.json({
    ...serialize(row[0]!.r, row[0]!.u, byRelease.get(row[0]!.r.id)),
    events: events.map((x) => ({
      id: x.e.id,
      status: x.e.status,
      fromStatus: x.e.fromStatus,
      statusLabel: buildType(row[0]!.r.buildType)?.stages.find((s) => s.key === x.e.status)?.label ?? x.e.status,
      comment: x.e.comment,
      actor: x.u ? { id: x.u.id, name: x.u.name, avatarUrl: x.u.avatarUrl } : null,
      createdAt: x.e.createdAt,
    })),
  })
})

const createSchema = z.object({
  version: z.string().min(1).max(50),
  buildType: z.string().min(1).max(50),
  /** Необязателен: без него берётся первая стадия набора. */
  status: z.string().max(50).optional(),
  referenceUrl: z.string().url().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  /** Комментарий к созданию — попадает в ленту первой записью. */
  comment: z.string().max(2000).optional(),
})

releasesRoute.post('/', zValidator('json', createSchema), async (c) => {
  const g = await guard(c as never, 'releases.manage')
  if ('error' in g) return c.json({ error: g.error }, g.status)
  const b = c.req.valid('json')

  if (!buildType(b.buildType)) {
    return c.json({ error: `Unknown buildType: ${b.buildType}. Use one of: ${BUILD_TYPES.map((t) => t.key).join(', ')}` }, 400)
  }
  const status = b.status ?? firstStage(b.buildType)!
  if (!isValidStage(b.buildType, status)) {
    const allowed = buildType(b.buildType)!.stages.map((s) => s.key).join(', ')
    return c.json({ error: `Unknown status "${status}" for ${b.buildType}. Allowed: ${allowed}` }, 400)
  }

  const [row] = await db
    .insert(releases)
    .values({
      projectId: g.projectId,
      version: b.version.trim(),
      buildType: b.buildType,
      status,
      ownerId: g.sub,
      referenceUrl: b.referenceUrl ?? null,
      notes: b.notes ?? null,
      // Версия может родиться сразу выкаченной — тогда дата ставится сразу.
      releasedAt: isLiveStage(b.buildType, status) ? new Date() : null,
    })
    .returning()

  await db.insert(releaseEvents).values({
    releaseId: row!.id,
    status,
    fromStatus: null,
    comment: b.comment?.trim() || 'Version created',
    actorId: g.sub,
  })

  void logActivity({
    projectId: g.projectId,
    actorId: g.sub,
    action: 'create',
    entityType: 'release',
    entityId: row!.id,
    entityLabel: `${row!.version} (${row!.buildType})`,
  })
  broadcast(g.projectId, 'releases_changed', {})

  const owner = await db.query.users.findFirst({ where: eq(users.id, g.sub) })
  return c.json(serialize(row!, owner), 201)
})

const updateSchema = z.object({
  version: z.string().min(1).max(50).optional(),
  referenceUrl: z.string().url().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
})

releasesRoute.patch('/:id', zValidator('json', updateSchema), async (c) => {
  const g = await guard(c as never, 'releases.manage')
  if ('error' in g) return c.json({ error: g.error }, g.status)

  const existing = await db.query.releases.findFirst({
    where: and(eq(releases.id, c.req.param('id')), eq(releases.projectId, g.projectId)),
  })
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const b = c.req.valid('json')
  const patch: Record<string, unknown> = { updatedAt: new Date() }
  if (b.version !== undefined) patch.version = b.version.trim()
  if (b.referenceUrl !== undefined) patch.referenceUrl = b.referenceUrl
  if (b.notes !== undefined) patch.notes = b.notes
  if (Object.keys(patch).length === 1) return c.json({ error: 'Nothing to update' }, 400)

  const [row] = await db.update(releases).set(patch).where(eq(releases.id, existing.id)).returning()
  broadcast(g.projectId, 'releases_changed', {})
  const owner = row!.ownerId ? await db.query.users.findFirst({ where: eq(users.id, row!.ownerId) }) : null
  return c.json(serialize(row!, owner))
})

/**
 * Смена стадии — отдельной ручкой, а не полем в PATCH.
 *
 * Потому что у неё своё обязательное условие: комментарий. В общем PATCH его
 * пришлось бы требовать «иногда», и первая же правка заметки без стадии
 * упёрлась бы в «объясните, почему».
 */
const stageSchema = z.object({
  status: z.string().min(1).max(50),
  comment: z.string().min(1).max(2000),
})

releasesRoute.post('/:id/stage', zValidator('json', stageSchema), async (c) => {
  const g = await guard(c as never, 'releases.manage')
  if ('error' in g) return c.json({ error: g.error }, g.status)

  const existing = await db.query.releases.findFirst({
    where: and(eq(releases.id, c.req.param('id')), eq(releases.projectId, g.projectId)),
  })
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const b = c.req.valid('json')
  if (!isValidStage(existing.buildType, b.status)) {
    const allowed = buildType(existing.buildType)?.stages.map((s) => s.key).join(', ') ?? ''
    return c.json({ error: `Unknown status "${b.status}" for ${existing.buildType}. Allowed: ${allowed}` }, 400)
  }
  if (b.status === existing.status) return c.json({ error: 'The version is already at this stage' }, 400)

  const nowLive = isLiveStage(existing.buildType, b.status)
  const [row] = await db
    .update(releases)
    .set({
      status: b.status,
      updatedAt: new Date(),
      // Дата выката ставится один раз: откат и повторный выход не должны
      // переписывать момент, когда версия впервые доехала до людей.
      releasedAt: nowLive && !existing.releasedAt ? new Date() : existing.releasedAt,
    })
    .where(eq(releases.id, existing.id))
    .returning()

  await db.insert(releaseEvents).values({
    releaseId: existing.id,
    status: b.status,
    fromStatus: existing.status,
    comment: b.comment.trim(),
    actorId: g.sub,
  })

  void logActivity({
    projectId: g.projectId,
    actorId: g.sub,
    action: 'update',
    entityType: 'release',
    entityId: existing.id,
    entityLabel: `${existing.version} ${existing.status} → ${b.status}`,
  })
  broadcast(g.projectId, 'releases_changed', {})

  const owner = row!.ownerId ? await db.query.users.findFirst({ where: eq(users.id, row!.ownerId) }) : null
  return c.json(serialize(row!, owner))
})

/**
 * Удаления версии нет намеренно.
 *
 * Версия — это факт: она была собрана и куда-то уехала. Стереть её значит
 * стереть ответ на «что было в проде в тот вторник». Ошибочную версию
 * закрывают стадией и комментарием, а не забвением.
 */
