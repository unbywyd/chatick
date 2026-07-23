import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { credentials, credentialAccessLog, users } from '../db/schema.js'
import { requireProject, type ProjectEnv } from '../auth.js'
import { encrypt, decrypt } from '../lib/crypto.js'
import { hasPermission } from './projects.js'

// Кредишены — самая чувствительная зона (SPEC + модель угроз):
//  - значения в БД только AES-256-GCM шифротекстом; ключ в .env
//  - список отдаёт ТОЛЬКО метаданные; значение — отдельный /reveal
//  - каждый reveal/create/update/delete — в аудит-лог (без значений)
//  - доступ через пермишены credentials.read / credentials.manage
//  - значения кредишенов НИКОГДА не попадают в контекст ИИ
export const credentialsRoute = new Hono<ProjectEnv>()
credentialsRoute.use('*', requireProject)

const VALUE_MAX = 10_000

async function audit(
  projectId: string,
  userId: string,
  action: 'reveal' | 'create' | 'update' | 'delete',
  credentialId: string | null,
  credentialName: string,
) {
  await db.insert(credentialAccessLog).values({ projectId, userId, action, credentialId, credentialName })
}

// Список — только метаданные, значений здесь нет
credentialsRoute.get('/', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'credentials.read'))) return c.json({ error: 'Forbidden' }, 403)

  const rows = await db
    .select({ cred: credentials, creator: users })
    .from(credentials)
    .leftJoin(users, eq(users.id, credentials.createdById))
    .where(eq(credentials.projectId, projectId))
    .orderBy(desc(credentials.createdAt))

  return c.json(
    rows.map((r) => ({
      id: r.cred.id,
      name: r.cred.name,
      createdAt: r.cred.createdAt,
      updatedAt: r.cred.updatedAt,
      creator: r.creator ? { id: r.creator.id, name: r.creator.name } : null,
    })),
  )
})

// Раскрыть значение — отдельный эндпоинт, всегда в аудит
credentialsRoute.post('/:credId/reveal', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'credentials.read'))) return c.json({ error: 'Forbidden' }, 403)

  const credId = c.req.param('credId')
  const cred = await db.query.credentials.findFirst({
    where: and(eq(credentials.id, credId), eq(credentials.projectId, projectId)),
  })
  if (!cred) return c.json({ error: 'Not found' }, 404)

  await audit(projectId, sub, 'reveal', cred.id, cred.name)

  let value: string
  try {
    value = decrypt(cred.valueEncrypted)
  } catch {
    return c.json({ error: 'Decryption failed' }, 500)
  }
  // no-store: значение не должно осесть в кэшах
  c.header('Cache-Control', 'no-store')
  return c.json({ value })
})

// Создать
credentialsRoute.post(
  '/',
  zValidator('json', z.object({ name: z.string().min(1).max(200), value: z.string().min(1).max(VALUE_MAX) })),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    if (!(await hasPermission(projectId, sub, 'credentials.manage'))) return c.json({ error: 'Forbidden' }, 403)

    const { name, value } = c.req.valid('json')
    const [row] = await db
      .insert(credentials)
      .values({ projectId, name, valueEncrypted: encrypt(value), createdById: sub })
      .returning()
    await audit(projectId, sub, 'create', row!.id, name)
    return c.json({ id: row!.id, name: row!.name, createdAt: row!.createdAt }, 201)
  },
)

// Обновить (имя и/или значение)
credentialsRoute.patch(
  '/:credId',
  zValidator(
    'json',
    z.object({ name: z.string().min(1).max(200).optional(), value: z.string().min(1).max(VALUE_MAX).optional() }),
  ),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    if (!(await hasPermission(projectId, sub, 'credentials.manage'))) return c.json({ error: 'Forbidden' }, 403)

    const credId = c.req.param('credId')
    const cred = await db.query.credentials.findFirst({
      where: and(eq(credentials.id, credId), eq(credentials.projectId, projectId)),
    })
    if (!cred) return c.json({ error: 'Not found' }, 404)

    const { name, value } = c.req.valid('json')
    const patch: Record<string, unknown> = {}
    if (name !== undefined) patch.name = name
    if (value !== undefined) patch.valueEncrypted = encrypt(value)
    const [row] = await db.update(credentials).set(patch).where(eq(credentials.id, credId)).returning()

    await audit(projectId, sub, 'update', credId, row!.name)
    return c.json({ id: row!.id, name: row!.name, updatedAt: row!.updatedAt })
  },
)

// Удалить
credentialsRoute.delete('/:credId', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'credentials.manage'))) return c.json({ error: 'Forbidden' }, 403)

  const credId = c.req.param('credId')
  const cred = await db.query.credentials.findFirst({
    where: and(eq(credentials.id, credId), eq(credentials.projectId, projectId)),
  })
  if (!cred) return c.json({ error: 'Not found' }, 404)

  await db.delete(credentials).where(eq(credentials.id, credId))
  await audit(projectId, sub, 'delete', credId, cred.name)
  return c.json({ ok: true })
})

// Аудит-лог — только owner/admin проекта
credentialsRoute.get('/audit', async (c) => {
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
      credentialName: r.log.credentialName,
      createdAt: r.log.createdAt,
      user: r.user ? { id: r.user.id, name: r.user.name, email: r.user.email } : null,
    })),
  )
})
