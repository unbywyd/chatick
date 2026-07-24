import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { credentials, resourceSecrets, credentialAccessLog, users } from '../db/schema.js'
import { requireProject, type ProjectEnv } from '../auth.js'
import { encrypt, decrypt } from '../lib/crypto.js'
import { hasPermission } from './projects.js'
import { logActivity } from '../lib/audit.js'

// Ресурсы (SPEC §8.1): ссылка + описание + опциональные секреты.
// Секреты — самая чувствительная часть: значения только AES-256-GCM,
// список отдаёт лишь метаданные, значение — отдельный /reveal с аудитом,
// значения секретов НИКОГДА не попадают в контекст ИИ.
export const resourcesRoute = new Hono<ProjectEnv>()
resourcesRoute.use('*', requireProject)

const VALUE_MAX = 10_000

async function audit(projectId: string, userId: string, action: 'reveal' | 'create' | 'update' | 'delete', resourceId: string | null, name: string) {
  await db.insert(credentialAccessLog).values({ projectId, userId, action, credentialId: resourceId, credentialName: name })
}

// Список — метаданные ресурсов + счётчик секретов (без значений)
resourcesRoute.get('/', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'credentials.read'))) return c.json({ error: 'Forbidden' }, 403)

  const rows = await db
    .select({ r: credentials, creator: users })
    .from(credentials)
    .leftJoin(users, eq(users.id, credentials.createdById))
    .where(and(eq(credentials.projectId, projectId), sql`${credentials.deletedAt} is null`))
    .orderBy(desc(credentials.createdAt))

  // счётчики секретов батчом
  const secretRows = await db.select({ resourceId: resourceSecrets.resourceId }).from(resourceSecrets)
  const counts = new Map<string, number>()
  for (const s of secretRows) counts.set(s.resourceId, (counts.get(s.resourceId) ?? 0) + 1)

  return c.json(
    rows.map((r) => ({
      id: r.r.id,
      name: r.r.name,
      url: r.r.url,
      description: r.r.description,
      source: r.r.source,
      messageId: r.r.messageId,
      secretCount: counts.get(r.r.id) ?? 0,
      createdAt: r.r.createdAt,
      updatedAt: r.r.updatedAt,
      creator: r.creator ? { id: r.creator.id, name: r.creator.name } : null,
    })),
  )
})

// Детали одного ресурса + список секретов (метаданные, значения скрыты)
resourcesRoute.get('/:id', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'credentials.read'))) return c.json({ error: 'Forbidden' }, 403)
  const r = await db.query.credentials.findFirst({ where: and(eq(credentials.id, c.req.param('id')), eq(credentials.projectId, projectId)) })
  if (!r) return c.json({ error: 'Not found' }, 404)
  const secrets = await db.query.resourceSecrets.findMany({ where: eq(resourceSecrets.resourceId, r.id), orderBy: (t, { asc }) => [asc(t.createdAt)] })
  return c.json({
    id: r.id,
    name: r.name,
    url: r.url,
    description: r.description,
    source: r.source,
    messageId: r.messageId,
    secrets: secrets.map((s) => ({ id: s.id, label: s.label })),
  })
})

// Создать ресурс (name обязателен; url/description/секреты опциональны)
resourcesRoute.post(
  '/',
  zValidator(
    'json',
    z.object({
      name: z.string().min(1).max(200),
      url: z.string().max(2000).nullable().optional(),
      description: z.string().max(5000).default(''),
      secrets: z.array(z.object({ label: z.string().max(120).default(''), value: z.string().min(1).max(VALUE_MAX) })).max(20).default([]),
      // ИИ создаёт из чата: source=chat, messageId — связь
      source: z.enum(['manual', 'chat']).default('manual'),
      messageId: z.string().nullable().optional(),
    }),
  ),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    if (!(await hasPermission(projectId, sub, 'credentials.manage'))) return c.json({ error: 'Forbidden' }, 403)
    const { name, url, description, secrets, source, messageId } = c.req.valid('json')

    const [row] = await db
      .insert(credentials)
      .values({ projectId, name, url: url ?? null, description, source, messageId: messageId ?? null, createdById: sub })
      .returning()
    if (secrets.length) {
      await db.insert(resourceSecrets).values(secrets.map((s) => ({ resourceId: row!.id, label: s.label, valueEncrypted: encrypt(s.value) })))
    }
    await audit(projectId, sub, 'create', row!.id, name)
    return c.json({ id: row!.id, name: row!.name }, 201)
  },
)

// Обновить метаданные ресурса
resourcesRoute.patch(
  '/:id',
  zValidator('json', z.object({ name: z.string().min(1).max(200).optional(), url: z.string().max(2000).nullable().optional(), description: z.string().max(5000).optional() })),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    if (!(await hasPermission(projectId, sub, 'credentials.manage'))) return c.json({ error: 'Forbidden' }, 403)
    const id = c.req.param('id')
    const r = await db.query.credentials.findFirst({ where: and(eq(credentials.id, id), eq(credentials.projectId, projectId)) })
    if (!r) return c.json({ error: 'Not found' }, 404)
    const { name, url, description } = c.req.valid('json')
    const patch: Record<string, unknown> = {}
    if (name !== undefined) patch.name = name
    if (url !== undefined) patch.url = url
    if (description !== undefined) patch.description = description
    await db.update(credentials).set(patch).where(eq(credentials.id, id))
    await audit(projectId, sub, 'update', id, name ?? r.name)
    return c.json({ ok: true })
  },
)

// Удалить ресурс (каскадом секреты)
resourcesRoute.delete('/:id', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'credentials.manage'))) return c.json({ error: 'Forbidden' }, 403)
  const id = c.req.param('id')
  const r = await db.query.credentials.findFirst({ where: and(eq(credentials.id, id), eq(credentials.projectId, projectId)) })
  if (!r) return c.json({ error: 'Not found' }, 404)
  // soft-delete (SPEC §8.21): восстановимо 7 дней
  await db.update(credentials).set({ deletedAt: new Date(), deletedById: sub }).where(eq(credentials.id, id))
  await audit(projectId, sub, 'delete', id, r.name)
  void logActivity({ projectId, actorId: sub, action: 'delete', entityType: 'resource', entityId: id, entityLabel: r.name })
  return c.json({ ok: true })
})

// Корзина ресурсов
resourcesRoute.get('/trash', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'credentials.manage'))) return c.json({ error: 'Forbidden' }, 403)
  const rows = await db
    .select({ r: credentials, deleter: users })
    .from(credentials)
    .leftJoin(users, eq(users.id, credentials.deletedById))
    .where(and(eq(credentials.projectId, projectId), sql`${credentials.deletedAt} is not null`))
    .orderBy(desc(credentials.deletedAt))
  return c.json(rows.map((x) => ({ id: x.r.id, name: x.r.name, deletedAt: x.r.deletedAt, deletedBy: x.deleter ? { id: x.deleter.id, name: x.deleter.name, avatarUrl: x.deleter.avatarUrl } : null })))
})

// Восстановить ресурс
resourcesRoute.post('/:id/restore', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'credentials.manage'))) return c.json({ error: 'Forbidden' }, 403)
  const id = c.req.param('id')
  const r = await db.query.credentials.findFirst({ where: and(eq(credentials.id, id), eq(credentials.projectId, projectId)) })
  if (!r) return c.json({ error: 'Not found' }, 404)
  await db.update(credentials).set({ deletedAt: null, deletedById: null }).where(eq(credentials.id, id))
  void logActivity({ projectId, actorId: sub, action: 'restore', entityType: 'resource', entityId: id, entityLabel: r.name })
  return c.json({ ok: true })
})

// --- Секреты под ресурсом ---------------------------------------------------

async function ownResource(projectId: string, resourceId: string) {
  return db.query.credentials.findFirst({ where: and(eq(credentials.id, resourceId), eq(credentials.projectId, projectId)) })
}

resourcesRoute.post(
  '/:id/secrets',
  zValidator('json', z.object({ label: z.string().max(120).default(''), value: z.string().min(1).max(VALUE_MAX) })),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    if (!(await hasPermission(projectId, sub, 'credentials.manage'))) return c.json({ error: 'Forbidden' }, 403)
    const r = await ownResource(projectId, c.req.param('id'))
    if (!r) return c.json({ error: 'Not found' }, 404)
    const { label, value } = c.req.valid('json')
    const [s] = await db.insert(resourceSecrets).values({ resourceId: r.id, label, valueEncrypted: encrypt(value) }).returning()
    await audit(projectId, sub, 'update', r.id, r.name)
    return c.json({ id: s!.id, label: s!.label }, 201)
  },
)

// Раскрыть значение секрета — в аудит
resourcesRoute.post('/:id/secrets/:secretId/reveal', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'credentials.read'))) return c.json({ error: 'Forbidden' }, 403)
  const r = await ownResource(projectId, c.req.param('id'))
  if (!r) return c.json({ error: 'Not found' }, 404)
  const s = await db.query.resourceSecrets.findFirst({ where: and(eq(resourceSecrets.id, c.req.param('secretId')), eq(resourceSecrets.resourceId, r.id)) })
  if (!s) return c.json({ error: 'Not found' }, 404)
  await audit(projectId, sub, 'reveal', r.id, r.name)
  let value: string
  try {
    value = decrypt(s.valueEncrypted)
  } catch {
    return c.json({ error: 'Decryption failed' }, 500)
  }
  c.header('Cache-Control', 'no-store')
  return c.json({ value })
})

resourcesRoute.delete('/:id/secrets/:secretId', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'credentials.manage'))) return c.json({ error: 'Forbidden' }, 403)
  const r = await ownResource(projectId, c.req.param('id'))
  if (!r) return c.json({ error: 'Not found' }, 404)
  await db.delete(resourceSecrets).where(and(eq(resourceSecrets.id, c.req.param('secretId')), eq(resourceSecrets.resourceId, r.id)))
  await audit(projectId, sub, 'update', r.id, r.name)
  return c.json({ ok: true })
})

// Аудит-лог — owner/admin
resourcesRoute.get('/audit/log', async (c) => {
  const { projectId, role } = c.get('auth')
  if (role !== 'owner' && role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
  const rows = await db
    .select({ log: credentialAccessLog, user: users })
    .from(credentialAccessLog)
    .leftJoin(users, eq(users.id, credentialAccessLog.userId))
    .where(eq(credentialAccessLog.projectId, projectId))
    .orderBy(desc(credentialAccessLog.createdAt))
    .limit(200)
  return c.json(
    rows.map((r) => ({
      id: r.log.id,
      action: r.log.action,
      resourceName: r.log.credentialName,
      createdAt: r.log.createdAt,
      user: r.user ? { id: r.user.id, name: r.user.name, email: r.user.email } : null,
    })),
  )
})
