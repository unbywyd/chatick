import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../db/client.js'
import { companies, companyMembers, projectMembers, projects, tasks, timeEntries, users } from '../db/schema.js'
import { checkKey, logCall, type KeyScope } from '../lib/company-key.js'
import { defaultPermissions } from './projects.js'
import { sendAddedToProjectMail } from '../lib/mail-added.js'
import { localeFor } from '../lib/locale.js'
import { issueEnterToken } from '../lib/enter-link.js'
import { env } from '../env.js'

// Внешний API для систем-заказчиков (SPEC-INTEGRATION).
//
// Отдельный префикс /api/v1/ext и отдельная проверка: сессий людей здесь нет
// вовсе, только ключ компании. Так проще рассуждать о правах — ни одна ручка
// отсюда не может случайно оказаться доступной обычному пользователю.
//
// Кто главный: проекты и люди приходят СНАРУЖИ. Мы их не выдумываем, а
// принимаем, храним связь с внешним идентификатором и отдаём обратно всё, что
// вокруг них наросло.

type ExtEnv = { Variables: { companyId: string; keyId: string } }

export const extRoute = new Hono<ExtEnv>()

const PROJECT_COLORS = ['#6366f1', '#f97316', '#14b8a6', '#e11d48', '#8b5cf6', '#0ea5e9', '#84cc16']

const ipOf = (c: { req: { header: (k: string) => string | undefined } }) =>
  (c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || '').split(',')[0]!.trim()

/** Требует ключ с нужным правом. Каждый вызов — в журнал, удачный и нет. */
const guard = (needed: KeyScope) =>
  createMiddleware<ExtEnv>(async (c, next) => {
    const ip = ipOf(c)
    const res = await checkKey(c.req.header('Authorization'), needed, ip)

    if (!res.ok) {
      // Причину называем: интегратору нужно понять, что чинить — иначе он
      // будет гадать между «не тот ключ» и «нет права».
      const message = {
        unknown: 'Unknown or malformed API key',
        revoked: 'This key has been revoked',
        ip: 'This key is not allowed from your address',
        scope: `Key lacks the required scope: ${needed}`,
      }[res.reason]
      return c.json({ error: message }, res.reason === 'scope' ? 403 : 401)
    }

    c.set('companyId', res.companyId)
    c.set('keyId', res.keyId)
    await next()
    logCall({
      companyId: res.companyId,
      keyId: res.keyId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      ip,
    })
  })

/** Уникальный slug: он общий на всю базу, а имена проектов у разных компаний совпадают. */
const slugOf = (name: string) =>
  `${name.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project'}-${nanoid(6)}`

const serializeProject = (p: typeof projects.$inferSelect) => ({
  id: p.id,
  externalId: p.externalId,
  name: p.name,
  externalName: p.externalName,
  slug: p.slug,
  about: p.about,
  color: p.color,
  createdAt: p.createdAt,
})

// --- проекты -----------------------------------------------------------------

extRoute.get('/projects', guard('read:all'), async (c) => {
  const rows = await db.select().from(projects).where(eq(projects.companyId, c.get('companyId')))
  return c.json({ items: rows.map(serializeProject), count: rows.length })
})

/**
 * Создать или обновить проект по внешнему идентификатору.
 *
 * Идемпотентно: повторный вызов с тем же externalId не плодит проекты, а
 * обновляет существующий. Внешняя система может слать своё состояние сколько
 * угодно раз — например, после сбоя связи, — и не бояться дублей.
 */
extRoute.post('/projects', guard('projects:write'), async (c) => {
  const companyId = c.get('companyId')
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>

  const externalId = typeof b.externalId === 'string' ? b.externalId.trim() : ''
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!externalId) return c.json({ error: 'externalId is required' }, 400)
  if (!name) return c.json({ error: 'name is required' }, 400)

  const externalName = typeof b.externalName === 'string' ? b.externalName.trim().slice(0, 300) : null
  const about = typeof b.about === 'string' ? b.about.slice(0, 5000) : ''

  const existing = await db.query.projects.findFirst({
    where: and(eq(projects.companyId, companyId), eq(projects.externalId, externalId)),
  })

  if (existing) {
    const [updated] = await db
      .update(projects)
      .set({ name: name.slice(0, 200), externalName, ...(about ? { about } : {}) })
      .where(eq(projects.id, existing.id))
      .returning()
    return c.json({ created: false, project: serializeProject(updated!) })
  }

  const [created] = await db
    .insert(projects)
    .values({
      companyId,
      externalId,
      externalName,
      name: name.slice(0, 200),
      about,
      slug: slugOf(name),
      color: PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)]!,
    })
    .returning()

  return c.json({ created: true, project: serializeProject(created!) }, 201)
})

extRoute.patch('/projects/:externalId', guard('projects:write'), async (c) => {
  const companyId = c.get('companyId')
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.companyId, companyId), eq(projects.externalId, c.req.param('externalId'))),
  })
  if (!project) return c.json({ error: 'Project not found' }, 404)

  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim().slice(0, 200)
  if (typeof b.externalName === 'string') patch.externalName = b.externalName.trim().slice(0, 300) || null
  if (typeof b.about === 'string') patch.about = b.about.slice(0, 5000)
  if (!Object.keys(patch).length) {
    return c.json({ error: 'Nothing to change. Supported: name, externalName, about.' }, 400)
  }

  const [updated] = await db.update(projects).set(patch).where(eq(projects.id, project.id)).returning()
  return c.json({ project: serializeProject(updated!) })
})

// --- участники проекта -------------------------------------------------------

/**
 * Добавить людей в проект по их внешним идентификаторам.
 *
 * Без подтверждения — так и просили: список людей ведёт сама компания в своей
 * системе, и спрашивать у человека «согласны ли вы» второй раз незачем.
 * Письмо о добавлении уходит постфактум, отдельно.
 */
extRoute.post('/projects/:externalId/members', guard('users:write'), async (c) => {
  const companyId = c.get('companyId')
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.companyId, companyId), eq(projects.externalId, c.req.param('externalId'))),
  })
  if (!project) return c.json({ error: 'Project not found' }, 404)

  const b = (await c.req.json().catch(() => ({}))) as { members?: unknown }
  const incoming = Array.isArray(b.members) ? b.members : []
  if (!incoming.length) return c.json({ error: 'members: [{ externalUserId, role? }] is required' }, 400)

  const wanted = incoming
    .map((x) => x as { externalUserId?: unknown; role?: unknown })
    .filter((x) => typeof x.externalUserId === 'string' && x.externalUserId)
    .map((x) => ({
      externalUserId: x.externalUserId as string,
      role: (['owner', 'admin', 'member'] as const).includes(x.role as never) ? (x.role as 'member') : 'member',
    }))

  const found = await db
    .select()
    .from(users)
    .where(inArray(users.externalId, wanted.map((w) => w.externalUserId)))
  const byExternal = new Map(found.map((u) => [u.externalId!, u]))

  const added: string[] = []
  const unknown: string[] = []

  for (const w of wanted) {
    const user = byExternal.get(w.externalUserId)
    if (!user) {
      // Человека ещё не завели — говорим прямо, а не молчим: иначе внешняя
      // система будет уверена, что добавила его в проект.
      unknown.push(w.externalUserId)
      continue
    }

    // В компанию — тоже: доступ к проекту без членства в компании оставил бы
    // человека без списка проектов и без права что-либо открыть.
    await db
      .insert(companyMembers)
      .values({ companyId, userId: user.id, role: 'member' })
      .onConflictDoNothing()

    const already = await db.query.projectMembers.findFirst({
      where: and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, user.id)),
    })
    if (already) continue

    await db.insert(projectMembers).values({
      projectId: project.id,
      userId: user.id,
      role: w.role,
      permissions: JSON.stringify(defaultPermissions(w.role)),
      // Правила чата человек не принимал — но и не мог: его добавили снаружи.
      // Ставим отметку, иначе он упрётся в экран согласия, которого не ждал.
      rulesAcceptedAt: new Date(),
    })
    added.push(w.externalUserId)
  }

  return c.json({ added: added.length, addedIds: added, unknownUsers: unknown })
})

extRoute.delete('/projects/:externalId/members/:externalUserId', guard('users:write'), async (c) => {
  const companyId = c.get('companyId')
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.companyId, companyId), eq(projects.externalId, c.req.param('externalId'))),
  })
  if (!project) return c.json({ error: 'Project not found' }, 404)

  const user = await db.query.users.findFirst({ where: eq(users.externalId, c.req.param('externalUserId')) })
  if (!user) return c.json({ error: 'User not found' }, 404)

  // Уходит доступ, а не следы: сообщения и задачи человека остаются на месте.
  await db
    .delete(projectMembers)
    .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, user.id)))

  return c.json({ ok: true })
})

// --- пользователи ------------------------------------------------------------

type IncomingUser = {
  externalId: string
  email: string
  name: string
  companyRole: 'admin' | 'manager' | 'member'
  projects: { externalProjectId: string; role: 'owner' | 'admin' | 'member' }[]
  notify: boolean
}

/** Разобрать одного человека из тела. Возвращает причину, а не просто null. */
function parseUser(raw: unknown): { user: IncomingUser } | { error: string } {
  const b = (raw ?? {}) as Record<string, unknown>
  const externalId = typeof b.externalId === 'string' ? b.externalId.trim() : ''
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''

  if (!externalId) return { error: 'externalId is required' }
  if (!email || !email.includes('@')) return { error: `invalid email for ${externalId}` }

  const roles = ['admin', 'manager', 'member'] as const
  const projects = Array.isArray(b.projects)
    ? b.projects
        .map((p) => p as Record<string, unknown>)
        .filter((p) => typeof p.externalProjectId === 'string' && p.externalProjectId)
        .map((p) => ({
          externalProjectId: p.externalProjectId as string,
          role: (['owner', 'admin', 'member'] as const).includes(p.role as never)
            ? (p.role as 'member')
            : ('member' as const),
        }))
    : []

  return {
    user: {
      externalId,
      email,
      name: typeof b.name === 'string' ? b.name.trim().slice(0, 200) : '',
      companyRole: roles.includes(b.companyRole as never) ? (b.companyRole as 'member') : 'member',
      projects,
      // Молчать по умолчанию нельзя: человек должен узнать, что у него
      // появился доступ. Отключить можно явно — например, при первичном
      // переносе всей команды, когда сотня писем разом никому не нужна.
      notify: b.notify !== false,
    },
  }
}

type UpsertOutcome = { externalId: string; created: boolean; userId: string; projects: number }

/**
 * Завести или обновить человека и раздать ему проекты.
 *
 * Ключ поиска — externalId, затем email: человек мог зарегистрироваться сам
 * через Google раньше, чем его завела внешняя система, и заводить второго
 * с той же почтой нельзя — почта уникальна, и вставка просто упадёт.
 */
async function upsertUser(companyId: string, companyName: string, u: IncomingUser): Promise<UpsertOutcome> {
  let user =
    (await db.query.users.findFirst({ where: eq(users.externalId, u.externalId) })) ??
    (await db.query.users.findFirst({ where: eq(users.email, u.email) }))

  let created = false
  if (!user) {
    const [row] = await db.insert(users).values({ email: u.email, name: u.name, externalId: u.externalId }).returning()
    user = row!
    created = true
  } else if (!user.externalId) {
    // Человек уже был у нас, но без связи — привязываем к их системе, иначе
    // при следующем вызове мы снова будем искать его по почте.
    const [row] = await db.update(users).set({ externalId: u.externalId }).where(eq(users.id, user.id)).returning()
    user = row!
  }

  await db
    .insert(companyMembers)
    .values({ companyId, userId: user.id, role: u.companyRole })
    .onConflictDoNothing()

  let addedTo = 0
  for (const p of u.projects) {
    const project = await db.query.projects.findFirst({
      where: and(eq(projects.companyId, companyId), eq(projects.externalId, p.externalProjectId)),
    })
    if (!project) continue

    const already = await db.query.projectMembers.findFirst({
      where: and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, user.id)),
    })
    if (already) continue

    await db.insert(projectMembers).values({
      projectId: project.id,
      userId: user.id,
      role: p.role,
      permissions: JSON.stringify(defaultPermissions(p.role)),
      rulesAcceptedAt: new Date(),
    })
    addedTo++

    if (u.notify) {
      // В фоне: письмо не должно задерживать ответ внешней системе, а сбой
      // почты — отменять уже выданный доступ.
      // Язык: свой у человека, иначе язык проекта или компании. У заведённого
      // через API своих настроек ещё нет — он их не открывал.
      void localeFor({ userId: user.id, projectId: project.id }).then((locale) =>
        sendAddedToProjectMail({
          to: user!.email,
          companyName,
          projectName: project.name,
          projectId: project.id,
          locale,
        }),
      )
    }
  }

  return { externalId: u.externalId, created, userId: user.id, projects: addedTo }
}

extRoute.post('/users', guard('users:write'), async (c) => {
  const companyId = c.get('companyId')
  const parsed = parseUser(await c.req.json().catch(() => ({})))
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)

  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) })
  const out = await upsertUser(companyId, company?.name ?? '', parsed.user)
  return c.json(out, out.created ? 201 : 200)
})

/**
 * Пачкой. Первичный перенос команды — это сотни людей, и по одному запросу на
 * каждого превращается в час ожидания и половину списка при обрыве связи.
 */
extRoute.post('/users/batch', guard('users:write'), async (c) => {
  const companyId = c.get('companyId')
  const b = (await c.req.json().catch(() => ({}))) as { users?: unknown }
  const incoming = Array.isArray(b.users) ? b.users : []

  if (!incoming.length) return c.json({ error: 'users: [...] is required' }, 400)
  if (incoming.length > 500) {
    return c.json({ error: `Too many users: ${incoming.length}. Maximum per call is 500.` }, 400)
  }

  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) })
  const companyName = company?.name ?? ''

  const results: UpsertOutcome[] = []
  const failed: { externalId: string; error: string }[] = []

  for (const raw of incoming) {
    const parsed = parseUser(raw)
    if ('error' in parsed) {
      const id = (raw as Record<string, unknown>)?.externalId
      failed.push({ externalId: typeof id === 'string' ? id : '(no externalId)', error: parsed.error })
      continue
    }
    try {
      results.push(await upsertUser(companyId, companyName, parsed.user))
    } catch (e) {
      // Один сбойный не должен уносить остальных: половина команды в системе
      // лучше, чем ничего, — а по списку failed видно, что доделать.
      failed.push({ externalId: parsed.user.externalId, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return c.json({
    processed: results.length,
    created: results.filter((r) => r.created).length,
    updated: results.filter((r) => !r.created).length,
    failed,
    items: results,
  })
})

extRoute.get('/users', guard('read:all'), async (c) => {
  const rows = await db
    .select({ user: users, role: companyMembers.role })
    .from(companyMembers)
    .innerJoin(users, eq(users.id, companyMembers.userId))
    .where(eq(companyMembers.companyId, c.get('companyId')))

  return c.json({
    items: rows.map((r) => ({
      externalId: r.user.externalId,
      email: r.user.email,
      name: r.user.name,
      companyRole: r.role,
    })),
    count: rows.length,
  })
})

/** Убрать из компании: доступ пропадает, задачи и сообщения остаются. */
extRoute.delete('/users/:externalId', guard('users:write'), async (c) => {
  const companyId = c.get('companyId')
  const user = await db.query.users.findFirst({ where: eq(users.externalId, c.req.param('externalId')) })
  if (!user) return c.json({ error: 'User not found' }, 404)

  const companyProjects = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.companyId, companyId))

  if (companyProjects.length) {
    await db.delete(projectMembers).where(
      and(
        eq(projectMembers.userId, user.id),
        inArray(projectMembers.projectId, companyProjects.map((p) => p.id)),
      ),
    )
  }
  await db
    .delete(companyMembers)
    .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, user.id)))

  return c.json({ ok: true })
})

// --- чтение для внешней статистики -------------------------------------------
//
// Ради этого раздела заказчик и переезжает: задачи и часы живут у нас, а его
// отчётность остаётся у него. Отдаём то, что относится к его компании.
//
// Чего здесь нет намеренно: содержимое чата — это переписка людей, а не
// отчётность; значения секретов — никогда и никому; личные диалоги с ИИ.

/** Проект компании по внешнему идентификатору — или отказ. */
async function projectByExternal(companyId: string, externalId: string) {
  return db.query.projects.findFirst({
    where: and(eq(projects.companyId, companyId), eq(projects.externalId, externalId)),
  })
}

/** Границы периода из строки запроса. Без них выгрузка тянет всю историю. */
function periodOf(c: { req: { query: (k: string) => string | undefined } }) {
  const from = c.req.query('from')
  const to = c.req.query('to')
  return {
    from: from && !isNaN(Date.parse(from)) ? new Date(from) : null,
    // «по 5 марта» включает весь день, иначе фильтр всегда теряет последний.
    to: to && !isNaN(Date.parse(to)) ? new Date(to.length <= 10 ? `${to}T23:59:59` : to) : null,
  }
}

extRoute.get('/projects/:externalId/tasks', guard('read:all'), async (c) => {
  const project = await projectByExternal(c.get('companyId'), c.req.param('externalId'))
  if (!project) return c.json({ error: 'Project not found' }, 404)

  const { from, to } = periodOf(c)
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 200, 1), 500)
  const conds = [eq(tasks.projectId, project.id), isNull(tasks.deletedAt)]
  if (from) conds.push(gte(tasks.createdAt, from))
  if (to) conds.push(lte(tasks.createdAt, to))

  const rows = await db
    .select({ task: tasks, assignee: users })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .where(and(...conds))
    .orderBy(desc(tasks.createdAt))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  return c.json({
    items: rows.slice(0, limit).map((r) => ({
      number: r.task.number,
      title: r.task.title,
      status: r.task.status,
      priority: r.task.priority,
      estimateMinutes: r.task.estimateMinutes ? Number(r.task.estimateMinutes) : null,
      dueDate: r.task.dueDate,
      // Их система знает людей по своему идентификатору — им и отвечаем.
      assignee: r.assignee ? { externalId: r.assignee.externalId, email: r.assignee.email, name: r.assignee.name } : null,
      createdAt: r.task.createdAt,
      updatedAt: r.task.updatedAt,
    })),
    hasMore,
    ...(hasMore ? { hint: 'Truncated. Narrow the period or raise limit (max 500).' } : {}),
  })
})

extRoute.get('/projects/:externalId/time', guard('read:all'), async (c) => {
  const project = await projectByExternal(c.get('companyId'), c.req.param('externalId'))
  if (!project) return c.json({ error: 'Project not found' }, 404)

  const { from, to } = periodOf(c)
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 200, 1), 500)
  const conds = [eq(timeEntries.projectId, project.id), sql`${timeEntries.endedAt} is not null`]
  if (from) conds.push(gte(timeEntries.startedAt, from))
  if (to) conds.push(lte(timeEntries.startedAt, to))

  const rows = await db
    .select({ entry: timeEntries, user: users, task: tasks })
    .from(timeEntries)
    .innerJoin(users, eq(users.id, timeEntries.userId))
    .leftJoin(tasks, eq(tasks.id, timeEntries.taskId))
    .where(and(...conds))
    .orderBy(desc(timeEntries.startedAt))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const items = rows.slice(0, limit).map((r) => ({
    user: { externalId: r.user.externalId, email: r.user.email, name: r.user.name },
    taskNumber: r.task?.number ?? null,
    description: r.entry.description,
    startedAt: r.entry.startedAt,
    endedAt: r.entry.endedAt,
    // Минуты считаем здесь: в базе их нет, они выводятся из времён, и пусть
    // это делает одна сторона, а не каждый потребитель по-своему.
    minutes: r.entry.endedAt
      ? Math.round((new Date(r.entry.endedAt).getTime() - new Date(r.entry.startedAt).getTime()) / 60_000)
      : 0,
  }))

  return c.json({
    items,
    totalMinutes: items.reduce((sum, x) => sum + x.minutes, 0),
    hasMore,
    ...(hasMore ? { hint: 'Truncated. Narrow the period or raise limit (max 500).' } : {}),
  })
})

/**
 * Сводка по компании — то, что их дашборд показывает без обхода всех проектов.
 */
extRoute.get('/stats/summary', guard('read:all'), async (c) => {
  const companyId = c.get('companyId')
  const { from, to } = periodOf(c)

  const companyProjects = await db.select().from(projects).where(eq(projects.companyId, companyId))
  if (!companyProjects.length) return c.json({ projects: [], totals: { projects: 0, tasks: 0, done: 0, minutes: 0 } })

  const ids = companyProjects.map((p) => p.id)

  const taskStats = await db
    .select({
      projectId: tasks.projectId,
      total: sql<number>`count(*)::int`,
      done: sql<number>`count(*) filter (where ${tasks.status} = 'done')::int`,
      overdue: sql<number>`count(*) filter (where ${tasks.status} <> 'done' and ${tasks.dueDate} < now())::int`,
    })
    .from(tasks)
    .where(and(inArray(tasks.projectId, ids), isNull(tasks.deletedAt)))
    .groupBy(tasks.projectId)

  const timeConds = [inArray(timeEntries.projectId, ids), sql`${timeEntries.endedAt} is not null`]
  if (from) timeConds.push(gte(timeEntries.startedAt, from))
  if (to) timeConds.push(lte(timeEntries.startedAt, to))

  const timeStats = await db
    .select({
      projectId: timeEntries.projectId,
      minutes: sql<number>`coalesce(sum(extract(epoch from (${timeEntries.endedAt} - ${timeEntries.startedAt})) / 60), 0)::int`,
    })
    .from(timeEntries)
    .where(and(...timeConds))
    .groupBy(timeEntries.projectId)

  const byTasks = new Map(taskStats.map((r) => [r.projectId, r]))
  const byTime = new Map(timeStats.map((r) => [r.projectId, r.minutes]))

  const items = companyProjects.map((p) => ({
    externalId: p.externalId,
    name: p.name,
    externalName: p.externalName,
    tasks: byTasks.get(p.id)?.total ?? 0,
    done: byTasks.get(p.id)?.done ?? 0,
    overdue: byTasks.get(p.id)?.overdue ?? 0,
    minutes: byTime.get(p.id) ?? 0,
  }))

  return c.json({
    projects: items,
    totals: {
      projects: items.length,
      tasks: items.reduce((s, x) => s + x.tasks, 0),
      done: items.reduce((s, x) => s + x.done, 0),
      minutes: items.reduce((s, x) => s + x.minutes, 0),
    },
  })
})

/** Часы одного человека по всем проектам компании — «сколько он отработал». */
extRoute.get('/users/:externalId/time', guard('read:all'), async (c) => {
  const companyId = c.get('companyId')
  const user = await db.query.users.findFirst({ where: eq(users.externalId, c.req.param('externalId')) })
  if (!user) return c.json({ error: 'User not found' }, 404)

  const companyProjects = await db.select({ id: projects.id, externalId: projects.externalId, name: projects.name }).from(projects).where(eq(projects.companyId, companyId))
  if (!companyProjects.length) return c.json({ items: [], totalMinutes: 0 })

  const { from, to } = periodOf(c)
  const conds = [
    eq(timeEntries.userId, user.id),
    inArray(timeEntries.projectId, companyProjects.map((p) => p.id)),
    sql`${timeEntries.endedAt} is not null`,
  ]
  if (from) conds.push(gte(timeEntries.startedAt, from))
  if (to) conds.push(lte(timeEntries.startedAt, to))

  const rows = await db
    .select({
      projectId: timeEntries.projectId,
      minutes: sql<number>`coalesce(sum(extract(epoch from (${timeEntries.endedAt} - ${timeEntries.startedAt})) / 60), 0)::int`,
    })
    .from(timeEntries)
    .where(and(...conds))
    .groupBy(timeEntries.projectId)

  const byId = new Map(companyProjects.map((p) => [p.id, p]))
  const items = rows.map((r) => ({
    project: { externalId: byId.get(r.projectId)?.externalId ?? null, name: byId.get(r.projectId)?.name ?? '' },
    minutes: r.minutes,
  }))

  return c.json({ items, totalMinutes: items.reduce((s, x) => s + x.minutes, 0) })
})

// --- переход из их системы к нам ---------------------------------------------

/**
 * Ссылка, которая проводит человека внутрь без повторного входа.
 *
 * Их система уже знает, кто он: он вошёл у них. Просить его войти второй раз —
 * лишний шаг, из-за которого переходом просто не будут пользоваться.
 *
 * Ссылку собирать вручную нельзя: она содержит одноразовый токен, который
 * выдаём мы. Отсюда и ручка — вместо описания формата в документации.
 */
extRoute.post('/users/:externalId/login-link', guard('users:write'), async (c) => {
  const companyId = c.get('companyId')
  const user = await db.query.users.findFirst({ where: eq(users.externalId, c.req.param('externalId')) })
  if (!user) return c.json({ error: 'User not found' }, 404)

  // Ключ компании выдаёт ссылку только СВОЕМУ участнику: иначе одна компания
  // могла бы войти под человеком из другой.
  const member = await db.query.companyMembers.findFirst({
    where: and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, user.id)),
  })
  if (!member) return c.json({ error: 'User is not a member of this company' }, 403)

  const b = (await c.req.json().catch(() => ({}))) as { to?: unknown; externalProjectId?: unknown }

  // Удобство: можно указать не путь, а свой идентификатор проекта — их
  // система наших идентификаторов не знает и знать не должна.
  let to = typeof b.to === 'string' ? b.to : null
  if (!to && typeof b.externalProjectId === 'string') {
    const project = await projectByExternal(companyId, b.externalProjectId)
    if (project) to = `/p/${project.id}`
  }

  const { token, expiresInSec } = issueEnterToken(user.id, companyId, to)
  return c.json({ url: `${env.APP_URL}/#/enter?token=${encodeURIComponent(token)}`, expiresInSec })
})

// --- о компании --------------------------------------------------------------

extRoute.get('/company', guard('read:all'), async (c) => {
  const company = await db.query.companies.findFirst({ where: eq(companies.id, c.get('companyId')) })
  if (!company) return c.json({ error: 'Not found' }, 404)
  const [{ n: projectCount }] = (await db
    .select({ n: db.$count(projects, eq(projects.companyId, company.id)) })
    .from(projects)
    .limit(1)) as unknown as [{ n: number }]
  return c.json({
    id: company.id,
    name: company.name,
    externalSystemName: company.externalSystemName,
    projectsViaApiOnly: company.projectsViaApiOnly,
    projects: projectCount ?? 0,
  })
})
