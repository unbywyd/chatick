import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { releases, releaseEvents, taskReleases, tasks, users, projectMembers } from '../db/schema.js'
import { requireProject, type ProjectEnv } from '../auth.js'
import { hasPermission } from './projects.js'
import { isFeatureEnabled } from '../lib/features.js'
import { BUILD_TYPES, buildType, firstStage, isLiveStage, isValidStage } from '../lib/release-stages.js'
import { logActivity } from '../lib/audit.js'
import { notify } from '../lib/notify.js'
import { companyOf, projectPath } from '../lib/links.js'
import { sanitizeHtml } from '../lib/sanitize-html.js'
import { notifyTask } from './tasks.js'
import { broadcast, tasksChanged } from '../ws.js'

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
  buildProfile: r.buildProfile,
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


/**
 * Кого касается смена стадии версии.
 *
 * Автор — он её завёл и хочет знать, что с ней стало: «залил в TestFlight»,
 * «прошли ревью» — ответ на вопрос, который иначе задают голосом.
 *
 * Исполнители связанных задач — по правилу «только затронутым»: они делают
 * работу, ради которой версия и существует.
 *
 * Тому, кто сам двигает стадию, не уходит ничего: notify() исключает актора из
 * получателей, отдельной проверки не нужно.
 */
export async function notifyReleaseStage(
  projectId: string,
  actorId: string,
  release: typeof releases.$inferSelect,
  toStatus: string,
) {
  const linked = await db
    .select({ t: tasks })
    .from(taskReleases)
    .innerJoin(tasks, eq(tasks.id, taskReleases.taskId))
    .where(eq(taskReleases.releaseId, release.id))

  const recipients = [release.ownerId, ...linked.map((l) => l.t.assigneeId)].filter(
    (x): x is string => Boolean(x),
  )
  if (!recipients.length) return

  const actor = await db.query.users.findFirst({ where: eq(users.id, actorId) })
  const label = buildType(release.buildType)?.stages.find((s) => s.key === toStatus)?.label ?? toStatus
  const companyId = await companyOf(projectId)
  void notify({
    projectId,
    event: 'release_status',
    recipientIds: recipients,
    actorId,
    actorName: actor?.name || 'Someone',
    // Один переход — одно уведомление: без стадии в ключе повторный проход по
    // той же лестнице молча схлопнулся бы в дубль.
    dedupeKey: `release_status:${release.id}:${toStatus}`,
    link: companyId ? projectPath(companyId, projectId, `/releases/${release.id}`) : '',
    preview: release.notes ?? '',
    vars: { ref: `${release.version} (${release.buildType})`, status: label },
    entityType: 'release',
    entityId: release.id,
  })
}

const createSchema = z.object({
  version: z.string().min(1).max(50),
  buildType: z.string().min(1).max(50),
  /** Необязателен: без него берётся первая стадия набора. */
  status: z.string().max(50).optional(),
  referenceUrl: z.string().url().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  /** Чем собрано: development | preview | production или своё. */
  buildProfile: z.string().max(50).nullable().optional(),
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
      buildProfile: b.buildProfile ?? null,
      // Версия может родиться сразу выкаченной — тогда дата ставится сразу.
      releasedAt: isLiveStage(b.buildType, status) ? new Date() : null,
    })
    .returning()

  await db.insert(releaseEvents).values({
    releaseId: row!.id,
    status,
    fromStatus: null,
    // Ключ, а не текст: строка ложится в базу навсегда, а язык у читателя
    // свой. Интерфейс переведёт по нему, старые записи останутся читаемыми.
    comment: b.comment?.trim() || '@created',
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
  buildProfile: z.string().max(50).nullable().optional(),
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
  if (b.buildProfile !== undefined) patch.buildProfile = b.buildProfile
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
  void notifyReleaseStage(g.projectId, g.sub, existing, b.status)
  broadcast(g.projectId, 'releases_changed', {})

  const owner = row!.ownerId ? await db.query.users.findFirst({ where: eq(users.id, row!.ownerId) }) : null
  return c.json(serialize(row!, owner))
})



/**
 * «Запросить сборку»: задача + версия + связь между ними, одним действием.
 *
 * Зачем ручка, а не три вызова из интерфейса: между ними бывает обрыв, и
 * тогда остаётся полусостояние — задача поставлена, версии нет, или наоборот.
 * Здесь либо всё, либо ничего.
 *
 * Зачем вообще: менеджер не «создаёт версию» — он ПРОСИТ человека собрать
 * билд. Версия у этой просьбы появляется сразу, чтобы было куда двигать
 * стадию, а задача несёт исполнителя и срок, которых у версии нет.
 *
 * Права нужны обе: releases.manage — завести версию, tasks.create — поручить
 * работу. Одного мало: иначе получилось бы, что человек раздаёт задачи, не
 * имея на это права, просто зайдя с другой вкладки.
 */
const requestSchema = z.object({
  version: z.string().min(1).max(50),
  buildType: z.string().min(1).max(50),
  /** Кому поручаем. Пусто — задача без исполнителя, так тоже бывает. */
  assigneeId: z.string().nullable().optional(),
  /** Что именно нужно: попадёт и в описание задачи, и в первую запись истории. */
  comment: z.string().max(2000).optional(),
  referenceUrl: z.string().url().max(2000).nullable().optional(),
  buildProfile: z.string().max(50).nullable().optional(),
  estimateMinutes: z.number().int().positive().optional(),
})

releasesRoute.post('/request', zValidator('json', requestSchema), async (c) => {
  const g = await guard(c as never, 'releases.manage')
  if ('error' in g) return c.json({ error: g.error }, g.status)
  if (!(await hasPermission(g.projectId, g.sub, 'tasks.create'))) {
    return c.json({ error: 'Forbidden: tasks.create is required to ask someone for a build' }, 403)
  }

  const b = c.req.valid('json')
  if (!buildType(b.buildType)) {
    return c.json({ error: `Unknown buildType: ${b.buildType}` }, 400)
  }
  const status = firstStage(b.buildType)!

  // Исполнитель обязан быть участником проекта: поручить работу человеку,
  // который не увидит задачу, — то же самое, что не поручить никому.
  if (b.assigneeId) {
    const member = await db.query.projectMembers.findFirst({
      where: and(eq(projectMembers.projectId, g.projectId), eq(projectMembers.userId, b.assigneeId)),
    })
    if (!member) return c.json({ error: 'The assignee is not a member of this project' }, 400)
  }

  const label = buildType(b.buildType)!.label
  const [{ next, minSort }] = (await db
    .select({
      next: sql<number>`coalesce(max(cast(substring(${tasks.number} from 6) as int)), 0) + 1`,
      minSort: sql<number>`coalesce(min(${tasks.sortOrder}), 0)`,
    })
    .from(tasks)
    .where(eq(tasks.projectId, g.projectId))) as [{ next: number; minSort: number }]

  const [task] = await db
    .insert(tasks)
    .values({
      projectId: g.projectId,
      number: `TASK-${next}`,
      sortOrder: minSort - 1,
      // Название говорит, что просят, а не «версия 1.4»: задача живёт в общем
      // списке, и там «1.4» без глагола ничего не значит.
      title: `${label} ${b.version}`,
      description: b.comment?.trim() ? sanitizeHtml(`<p>${b.comment.trim()}</p>`) : '',
      status: 'todo',
      priority: 'normal',
      assigneeId: b.assigneeId ?? null,
      createdById: g.sub,
      estimateMinutes: b.estimateMinutes ? String(b.estimateMinutes) : null,
    })
    .returning()

  const [release] = await db
    .insert(releases)
    .values({
      projectId: g.projectId,
      version: b.version.trim(),
      buildType: b.buildType,
      status,
      ownerId: g.sub,
      referenceUrl: b.referenceUrl ?? null,
      buildProfile: b.buildProfile ?? null,
      notes: b.comment?.trim() || null,
    })
    .returning()

  await db.insert(releaseEvents).values({
    releaseId: release!.id,
    status,
    fromStatus: null,
    comment: b.comment?.trim() || `@requested:${task!.number}`,
    actorId: g.sub,
  })
  await db.insert(taskReleases).values({ taskId: task!.id, releaseId: release!.id })

  void logActivity({
    projectId: g.projectId,
    actorId: g.sub,
    action: 'create',
    entityType: 'release',
    entityId: release!.id,
    entityLabel: `${release!.version} (${release!.buildType}) ← ${task!.number}`,
  })
  // Человек узнаёт о поручении так же, как о любой другой задаче.
  if (task!.assigneeId) {
    void notifyTask(g.projectId, g.sub, task!, { assigneeChanged: true, mentions: false })
  }
  broadcast(g.projectId, 'releases_changed', {})
  tasksChanged(g.projectId, [task!.assigneeId, g.sub])

  return c.json(
    {
      task: { id: task!.id, number: task!.number, title: task!.title },
      release: { id: release!.id, version: release!.version, buildType: release!.buildType, status: release!.status },
    },
    201,
  )
})

/**
 * Привязка задач к версии.
 *
 * Живёт на маршруте версий, а не задач, потому что право здесь тоже про
 * версии: кто ведёт релизы, тот и решает, что в них уезжает. Требовать ради
 * этого tasks.edit значило бы, что связать задачу с версией нельзя, не имея
 * права переписывать саму задачу.
 *
 * Задача — это запрос на работу: «собери прод-билд» с исполнителем и сроком.
 * Версия — то, что из этой работы получилось. Поэтому связь и нужна: у версии
 * нет исполнителя, а у задачи нет стадии выката.
 */
releasesRoute.get('/:id/task-candidates', async (c) => {
  const g = await guard(c as never, 'releases.manage')
  if ('error' in g) return c.json({ error: g.error }, g.status)

  const q = (c.req.query('q') ?? '').trim()
  const linked = await db
    .select({ taskId: taskReleases.taskId })
    .from(taskReleases)
    .where(eq(taskReleases.releaseId, c.req.param('id')))
  const already = new Set(linked.map((l) => l.taskId))

  const rows = await db
    .select({ t: tasks })
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, g.projectId),
        sql`${tasks.deletedAt} is null`,
        q ? or(ilike(tasks.title, `%${q}%`), ilike(tasks.number, `%${q}%`))! : undefined,
      ),
    )
    .orderBy(desc(tasks.updatedAt))
    .limit(50)

  return c.json({
    items: rows
      .filter((r) => !already.has(r.t.id))
      .map((r) => ({ id: r.t.id, number: r.t.number, title: r.t.title, status: r.t.status })),
  })
})

releasesRoute.post('/:id/tasks', zValidator('json', z.object({ taskId: z.string().min(1) })), async (c) => {
  const g = await guard(c as never, 'releases.manage')
  if ('error' in g) return c.json({ error: g.error }, g.status)

  const releaseId = c.req.param('id')
  const release = await db.query.releases.findFirst({
    where: and(eq(releases.id, releaseId), eq(releases.projectId, g.projectId)),
  })
  if (!release) return c.json({ error: 'Not found' }, 404)

  // Задача обязана быть из этого же проекта: иначе версия одного проекта
  // потянула бы за собой работу из чужого.
  const { taskId } = c.req.valid('json')
  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.projectId, g.projectId)),
  })
  if (!task) return c.json({ error: 'Task not found in this project' }, 404)

  await db.insert(taskReleases).values({ taskId, releaseId }).onConflictDoNothing()
  broadcast(g.projectId, 'releases_changed', {})
  tasksChanged(g.projectId, [task.assigneeId, task.createdById])
  return c.json({ ok: true, task: { id: task.id, number: task.number, title: task.title, status: task.status } })
})

releasesRoute.delete('/:id/tasks/:taskId', async (c) => {
  const g = await guard(c as never, 'releases.manage')
  if ('error' in g) return c.json({ error: g.error }, g.status)

  const releaseId = c.req.param('id')
  const release = await db.query.releases.findFirst({
    where: and(eq(releases.id, releaseId), eq(releases.projectId, g.projectId)),
  })
  if (!release) return c.json({ error: 'Not found' }, 404)

  // Снятие связи не трогает ни задачу, ни версию — они живут дальше каждая
  // своей жизнью. Это и есть смысл необязательной связи.
  await db
    .delete(taskReleases)
    .where(and(eq(taskReleases.releaseId, releaseId), eq(taskReleases.taskId, c.req.param('taskId'))))
  broadcast(g.projectId, 'releases_changed', {})
  return c.json({ ok: true })
})

/**
 * Удаления версии нет намеренно.
 *
 * Версия — это факт: она была собрана и куда-то уехала. Стереть её значит
 * стереть ответ на «что было в проде в тот вторник». Ошибочную версию
 * закрывают стадией и комментарием, а не забвением.
 */
