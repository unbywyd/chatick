import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { and, eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../db/client.js'
import { companies, companyMembers, projectMembers, projects, users } from '../db/schema.js'
import { checkKey, logCall, type KeyScope } from '../lib/company-key.js'
import { defaultPermissions } from './projects.js'

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
