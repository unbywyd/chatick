import { Hono } from 'hono'
import { and, desc, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  documents,
  files,
  messages,
  projectMembers,
  projects,
  credentials,
  taskComments,
  taskGroups,
  tasks,
  users,
} from '../db/schema.js'
import { hasPermission, type ProjectPermission } from './projects.js'
import { authenticateBridge, closeSession, startDeviceAuth, pollDeviceAuth, type BridgeIdentity } from '../lib/bridge-auth.js'
import { connectDoc, guideDoc } from '../lib/bridge-docs.js'
import { logActivity } from '../lib/audit.js'
import { htmlToText } from '../lib/sanitize-html.js'
import { broadcast } from '../ws.js'
import { env } from '../env.js'

// Мост для внешнего ИИ (SPEC §8.27). Всё выполняется ОТ ИМЕНИ пользователя,
// одобрившего туннель, и проверяется теми же hasPermission, что и живой UI.

type BridgeEnv = { Variables: { bridge: BridgeIdentity } }
export const bridgeRoute = new Hono()

const APP = () => (env.APP_URL || 'https://app.chatick.com').replace(/\/$/, '')

// Внятная ошибка вместо пустого 500: читатель — агент, ему нужно понять,
// что пошло не так, и решить, чинить запрос или сдаться.
bridgeRoute.onError((err, c) => {
  console.error('[bridge]', err)
  return c.json({ error: 'Request failed', detail: String(err instanceof Error ? err.message : err) }, 500)
})

// --- Публичное: инструкция и device flow (без токена) ----------------------

bridgeRoute.get('/', (c) => c.text(connectDoc()))

bridgeRoute.post('/device', async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
  const clientName = typeof body.client === 'string' && body.client.trim() ? body.client.trim() : 'AI assistant'
  const { userCode, deviceCode, expiresInSec } = await startDeviceAuth(clientName)
  return c.json({
    userCode,
    deviceCode,
    verifyUrl: `${APP()}/#/connect`,
    expiresInSec,
    instructions: `Tell the human: open ${APP()}/#/connect and enter code ${userCode}. Then poll /x/device/poll with deviceCode.`,
  })
})

bridgeRoute.post('/device/poll', async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
  const deviceCode = typeof body.deviceCode === 'string' ? body.deviceCode : ''
  if (!deviceCode) return c.json({ error: 'deviceCode is required' }, 400)

  const r = await pollDeviceAuth(deviceCode)
  if (r.status !== 'approved') return c.json({ status: r.status })
  return c.json({
    status: 'approved',
    token: r.token,
    user: r.identity.user,
    project: r.identity.project,
    guideUrl: `${(process.env.API_PUBLIC_URL || 'https://api.chatick.com').replace(/\/$/, '')}/x/guide`,
    next: 'Read the guide with: curl -s <guideUrl> -H "authorization: Bearer <token>"',
  })
})

// --- Всё ниже требует токена ------------------------------------------------

bridgeRoute.use('/*', async (c, next) => {
  // публичные пути уже обработаны выше
  const path = new URL(c.req.url).pathname
  if (path === '/x' || path === '/x/' || path.startsWith('/x/device')) return next()

  const header = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
  const identity = await authenticateBridge(header ?? c.req.query('token'))
  if (!identity) {
    return c.json(
      {
        error: 'Tunnel closed or token invalid',
        hint: 'Run the device flow again — see GET /x for instructions.',
      },
      401,
    )
  }
  ;(c as unknown as { set: (k: 'bridge', v: BridgeIdentity) => void }).set('bridge', identity)
  return next()
})

const auth = (c: { get: (k: 'bridge') => BridgeIdentity }) => c.get('bridge')

/** Единая проверка прав: тот же механизм, что и для живого пользователя. */
async function require(c: { get: (k: 'bridge') => BridgeIdentity }, perm: ProjectPermission) {
  const id = auth(c)
  const ok = await hasPermission(id.projectId, id.userId, perm)
  return ok ? null : { error: `Forbidden: your account lacks ${perm} in this project`, permission: perm }
}

bridgeRoute.get('/guide', (c) => c.text(guideDoc(auth(c as never))))

// --- Контекст проекта -------------------------------------------------------

bridgeRoute.get('/context', async (c) => {
  const id = auth(c as never)
  const project = await db.query.projects.findFirst({ where: eq(projects.id, id.projectId) })
  if (!project) return c.json({ error: 'Not found' }, 404)

  const members = await db
    .select({ m: projectMembers, u: users })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, id.projectId))

  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      todo: sql<number>`count(*) filter (where ${tasks.status} = 'todo')::int`,
      inProgress: sql<number>`count(*) filter (where ${tasks.status} = 'in_progress')::int`,
      review: sql<number>`count(*) filter (where ${tasks.status} = 'review')::int`,
      done: sql<number>`count(*) filter (where ${tasks.status} = 'done')::int`,
      mine: sql<number>`count(*) filter (where ${tasks.assigneeId} = ${id.userId} and ${tasks.status} <> 'done')::int`,
    })
    .from(tasks)
    .where(and(eq(tasks.projectId, id.projectId), isNull(tasks.deletedAt)))

  const sprints = await db.query.taskGroups.findMany({
    where: and(eq(taskGroups.projectId, id.projectId), isNull(taskGroups.deletedAt)),
  })

  const aiConfig = JSON.parse(project.aiConfig || '{}') as { language?: string }

  return c.json({
    project: { id: project.id, name: project.name, about: project.about, language: aiConfig.language ?? 'en' },
    chatRules: project.chatRules,
    you: { ...id.user, permissions: id.permissions },
    members: members.map((r) => ({
      id: r.u.id,
      name: r.u.name,
      email: r.u.email,
      role: r.m.role,
      jobTitle: r.m.jobTitle,
      responsibility: r.m.responsibility,
      isYou: r.u.id === id.userId,
    })),
    sprints: sprints.map((s) => ({ id: s.id, name: s.name })),
    tasks: counts,
  })
})

// --- Хелперы ----------------------------------------------------------------

/** «me», id, имя или email → userId. */
async function resolveAssignee(id: BridgeIdentity, value: unknown): Promise<string | null | undefined> {
  if (value === null) return null // явный сброс
  if (typeof value !== 'string' || !value.trim()) return undefined
  const v = value.trim()
  if (v.toLowerCase() === 'me') return id.userId

  const rows = await db
    .select({ u: users })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, id.projectId))
  const lower = v.toLowerCase()
  const hit =
    rows.find((r) => r.u.id === v) ??
    rows.find((r) => r.u.email.toLowerCase() === lower) ??
    rows.find((r) => r.u.name.toLowerCase() === lower) ??
    rows.find((r) => r.u.name.toLowerCase().includes(lower))
  return hit?.u.id
}

/** ISO или «tomorrow» / «in 3 days» / «next monday». */
function parseDue(value: unknown): Date | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string' || !value.trim()) return undefined
  const v = value.trim().toLowerCase()
  const day = 86400_000
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0)

  if (v === 'today') return startOfDay(new Date())
  if (v === 'tomorrow') return startOfDay(new Date(Date.now() + day))
  const inDays = v.match(/^in (\d+) days?$/)
  if (inDays) return startOfDay(new Date(Date.now() + Number(inDays[1]) * day))
  const weekday = v.match(/^next (monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/)
  if (weekday) {
    const target = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(weekday[1]!)
    const now = new Date()
    const delta = ((target - now.getDay() + 7) % 7) || 7
    return startOfDay(new Date(Date.now() + delta * day))
  }
  const parsed = Date.parse(value)
  return isNaN(parsed) ? undefined : new Date(parsed)
}

const taskView = (t: typeof tasks.$inferSelect, assignee?: { id: string; name: string } | null) => ({
  id: t.id,
  number: t.number,
  title: t.title,
  description: t.description,
  status: t.status,
  priority: t.priority,
  estimateMinutes: t.estimateMinutes ? Number(t.estimateMinutes) : null,
  dueDate: t.dueDate,
  sprintId: t.groupId,
  assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
  updatedAt: t.updatedAt,
})

// --- Задачи -----------------------------------------------------------------

bridgeRoute.get('/tasks', async (c) => {
  const id = auth(c as never)
  const denied = await require(c as never, 'tasks.read')
  if (denied) return c.json(denied, 403)

  const conds = [eq(tasks.projectId, id.projectId), isNull(tasks.deletedAt)]
  const assignee = c.req.query('assignee')
  if (assignee) {
    const resolved = await resolveAssignee(id, assignee)
    if (resolved === undefined) return c.json({ error: `Unknown assignee: ${assignee}` }, 400)
    conds.push(resolved === null ? isNull(tasks.assigneeId) : eq(tasks.assigneeId, resolved))
  }
  const status = c.req.query('status')
  if (status) {
    const list = status.split(',').filter(Boolean) as ('todo' | 'in_progress' | 'review' | 'done')[]
    conds.push(inArray(tasks.status, list))
  }
  const sprint = c.req.query('sprint')
  if (sprint) conds.push(eq(tasks.groupId, sprint))
  const q = c.req.query('q')?.trim()
  if (q) conds.push(or(ilike(tasks.title, `%${q}%`), ilike(tasks.description, `%${q}%`))!)

  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50))
  const rows = await db
    .select({ t: tasks, u: users })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .where(and(...conds))
    .orderBy(desc(tasks.updatedAt))
    .limit(limit)

  return c.json({ items: rows.map((r) => taskView(r.t, r.u)), count: rows.length })
})

bridgeRoute.get('/tasks/:id', async (c) => {
  const id = auth(c as never)
  const denied = await require(c as never, 'tasks.read')
  if (denied) return c.json(denied, 403)
  const row = await db
    .select({ t: tasks, u: users })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .where(and(eq(tasks.id, c.req.param('id')), eq(tasks.projectId, id.projectId), isNull(tasks.deletedAt)))
    .limit(1)
  if (!row.length) return c.json({ error: 'Not found' }, 404)
  return c.json(taskView(row[0]!.t, row[0]!.u))
})

bridgeRoute.post('/tasks', async (c) => {
  const id = auth(c as never)
  const denied = await require(c as never, 'tasks.create')
  if (denied) return c.json(denied, 403)

  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const title = typeof b.title === 'string' ? b.title.trim() : ''
  if (!title) return c.json({ error: 'title is required' }, 400)

  const assigneeId = await resolveAssignee(id, b.assignee)
  if (b.assignee !== undefined && assigneeId === undefined) return c.json({ error: `Unknown assignee: ${String(b.assignee)}` }, 400)
  const dueDate = parseDue(b.dueDate)

  // Номер = max+1, а НЕ count: удалённые задачи оставляют дыры, и count
  // повторно выдаёт уже занятый номер (unique-индекс project+number).
  const [{ next }] = (await db
    .select({ next: sql<number>`coalesce(max(cast(substring(${tasks.number} from 6) as int)), 0) + 1` })
    .from(tasks)
    .where(eq(tasks.projectId, id.projectId))) as [{ next: number }]

  const [row] = await db
    .insert(tasks)
    .values({
      projectId: id.projectId,
      number: `TASK-${next}`,
      title: title.slice(0, 300),
      description: typeof b.description === 'string' ? b.description : '',
      status: (['todo', 'in_progress', 'review', 'done'] as const).includes(b.status as never)
        ? (b.status as 'todo')
        : 'todo',
      priority: (['low', 'normal', 'high', 'urgent'] as const).includes(b.priority as never)
        ? (b.priority as 'normal')
        : 'normal',
      assigneeId: assigneeId ?? null,
      dueDate: dueDate ?? null,
      estimateMinutes: b.estimateMinutes != null ? String(b.estimateMinutes) : null,
      groupId: typeof b.sprintId === 'string' ? b.sprintId : null,
      createdById: id.userId,
    })
    .returning()

  void logActivity({
    projectId: id.projectId,
    actorId: id.userId,
    action: 'create',
    entityType: 'task',
    entityId: row!.id,
    entityLabel: `${row!.number} ${row!.title}`,
  })
  broadcast(id.projectId, 'tasks_changed', {})
  // подтягиваем исполнителя, чтобы агент сразу видел, на кого задача ушла
  const who = row!.assigneeId ? await db.query.users.findFirst({ where: eq(users.id, row!.assigneeId) }) : null
  return c.json(taskView(row!, who), 201)
})

bridgeRoute.patch('/tasks/:id', async (c) => {
  const id = auth(c as never)
  const denied = await require(c as never, 'tasks.edit')
  if (denied) return c.json(denied, 403)

  const taskId = c.req.param('id')
  const existing = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.projectId, id.projectId), isNull(tasks.deletedAt)),
  })
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  if (typeof b.title === 'string') patch.title = b.title.slice(0, 300)
  if (typeof b.description === 'string') patch.description = b.description
  if ((['todo', 'in_progress', 'review', 'done'] as const).includes(b.status as never)) patch.status = b.status
  if ((['low', 'normal', 'high', 'urgent'] as const).includes(b.priority as never)) patch.priority = b.priority
  if (b.estimateMinutes !== undefined) patch.estimateMinutes = b.estimateMinutes == null ? null : String(b.estimateMinutes)
  if (b.sprintId !== undefined) patch.groupId = b.sprintId ?? null
  if (b.assignee !== undefined) {
    const resolved = await resolveAssignee(id, b.assignee)
    if (resolved === undefined) return c.json({ error: `Unknown assignee: ${String(b.assignee)}` }, 400)
    patch.assigneeId = resolved
  }
  if (b.dueDate !== undefined) {
    const due = parseDue(b.dueDate)
    if (due === undefined) return c.json({ error: `Cannot parse dueDate: ${String(b.dueDate)}` }, 400)
    patch.dueDate = due
  }
  if (!Object.keys(patch).length) return c.json({ error: 'Nothing to update' }, 400)

  const [row] = await db.update(tasks).set(patch).where(eq(tasks.id, taskId)).returning()
  void logActivity({
    projectId: id.projectId,
    actorId: id.userId,
    action: 'update',
    entityType: 'task',
    entityId: taskId,
    entityLabel: `${row!.number} ${row!.title}`,
  })
  broadcast(id.projectId, 'tasks_changed', {})
  const who = row!.assigneeId ? await db.query.users.findFirst({ where: eq(users.id, row!.assigneeId) }) : null
  return c.json(taskView(row!, who))
})

bridgeRoute.delete('/tasks/:id', async (c) => {
  const id = auth(c as never)
  const denied = await require(c as never, 'tasks.delete')
  if (denied) return c.json(denied, 403)
  const taskId = c.req.param('id')
  const existing = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.projectId, id.projectId), isNull(tasks.deletedAt)),
  })
  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.update(tasks).set({ deletedAt: new Date(), deletedById: id.userId }).where(eq(tasks.id, taskId))
  void logActivity({
    projectId: id.projectId,
    actorId: id.userId,
    action: 'delete',
    entityType: 'task',
    entityId: taskId,
    entityLabel: `${existing.number} ${existing.title}`,
  })
  broadcast(id.projectId, 'tasks_changed', {})
  return c.json({ ok: true, restorableForDays: 7 })
})

// --- Комментарии к задаче ---------------------------------------------------

bridgeRoute.get('/tasks/:id/comments', async (c) => {
  const id = auth(c as never)
  const denied = await require(c as never, 'tasks.read')
  if (denied) return c.json(denied, 403)
  const rows = await db
    .select({ c: taskComments, u: users })
    .from(taskComments)
    .leftJoin(users, eq(users.id, taskComments.authorId))
    .where(eq(taskComments.taskId, c.req.param('id')))
    .orderBy(taskComments.createdAt)
  return c.json({
    items: rows.map((r) => ({ id: r.c.id, text: r.c.body, author: r.u?.name ?? null, createdAt: r.c.createdAt })),
  })
})

bridgeRoute.post('/tasks/:id/comments', async (c) => {
  const id = auth(c as never)
  const denied = await require(c as never, 'tasks.read')
  if (denied) return c.json(denied, 403)
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const text = typeof b.text === 'string' ? b.text.trim() : ''
  if (!text) return c.json({ error: 'text is required' }, 400)

  const taskId = c.req.param('id')
  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.projectId, id.projectId), isNull(tasks.deletedAt)),
  })
  if (!task) return c.json({ error: 'Not found' }, 404)

  const [row] = await db.insert(taskComments).values({ taskId, projectId: id.projectId, authorId: id.userId, body: text }).returning()
  broadcast(id.projectId, 'task_comments_changed', { taskId })
  return c.json({ id: row!.id, createdAt: row!.createdAt }, 201)
})

// --- Спринты ----------------------------------------------------------------

bridgeRoute.get('/sprints', async (c) => {
  const id = auth(c as never)
  const denied = await require(c as never, 'tasks.read')
  if (denied) return c.json(denied, 403)
  const rows = await db.query.taskGroups.findMany({
    where: and(eq(taskGroups.projectId, id.projectId), isNull(taskGroups.deletedAt)),
  })
  return c.json({ items: rows.map((s) => ({ id: s.id, name: s.name })) })
})

bridgeRoute.post('/sprints', async (c) => {
  const id = auth(c as never)
  const denied = await require(c as never, 'tasks.create')
  if (denied) return c.json(denied, 403)
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name) return c.json({ error: 'name is required' }, 400)
  const [row] = await db
    .insert(taskGroups)
    .values({ projectId: id.projectId, name: name.slice(0, 120), createdById: id.userId })
    .returning()
  broadcast(id.projectId, 'tasks_changed', {})
  return c.json({ id: row!.id, name: row!.name }, 201)
})

// --- Документы --------------------------------------------------------------

bridgeRoute.get('/documents', async (c) => {
  const id = auth(c as never)
  const denied = await require(c as never, 'documents.read')
  if (denied) return c.json(denied, 403)
  const q = c.req.query('q')?.trim()
  const base = and(eq(documents.projectId, id.projectId), isNull(documents.deletedAt))
  const rows = await db.query.documents.findMany({
    where: q ? and(base, ilike(documents.title, `%${q}%`)) : base,
    orderBy: desc(documents.updatedAt),
    limit: 100,
  })
  return c.json({
    items: rows.map((d) => {
      const text = htmlToText(d.content)
      return { id: d.id, title: d.title || '—', chars: text.length, preview: text.slice(0, 160), updatedAt: d.updatedAt }
    }),
  })
})

bridgeRoute.get('/documents/:id', async (c) => {
  const id = auth(c as never)
  const denied = await require(c as never, 'documents.read')
  if (denied) return c.json(denied, 403)
  const d = await db.query.documents.findFirst({
    where: and(eq(documents.id, c.req.param('id')), eq(documents.projectId, id.projectId), isNull(documents.deletedAt)),
  })
  if (!d) return c.json({ error: 'Not found' }, 404)

  const asHtml = c.req.query('format') === 'html'
  const body = asHtml ? d.content : htmlToText(d.content)
  const offset = Math.max(0, Number(c.req.query('offset')) || 0)
  const limit = Math.min(20000, Math.max(200, Number(c.req.query('limit')) || 4000))
  const chunk = body.slice(offset, offset + limit)
  const end = offset + chunk.length
  return c.json({
    id: d.id,
    title: d.title,
    format: asHtml ? 'html' : 'text',
    totalChars: body.length,
    offset,
    returned: chunk.length,
    hasMore: end < body.length,
    nextOffset: end < body.length ? end : null,
    content: chunk,
  })
})

bridgeRoute.post('/documents', async (c) => {
  const id = auth(c as never)
  const denied = await require(c as never, 'documents.write')
  if (denied) return c.json(denied, 403)
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const title = typeof b.title === 'string' ? b.title.trim() : ''
  if (!title) return c.json({ error: 'title is required' }, 400)
  const [row] = await db
    .insert(documents)
    .values({
      projectId: id.projectId,
      title: title.slice(0, 300),
      content: typeof b.content === 'string' ? b.content.slice(0, 500_000) : '',
      createdById: id.userId,
      updatedById: id.userId,
    })
    .returning()
  void logActivity({
    projectId: id.projectId,
    actorId: id.userId,
    action: 'create',
    entityType: 'document',
    entityId: row!.id,
    entityLabel: row!.title,
  })
  broadcast(id.projectId, 'documents_changed', {})
  return c.json({ id: row!.id, title: row!.title }, 201)
})

bridgeRoute.patch('/documents/:id', async (c) => {
  const id = auth(c as never)
  const denied = await require(c as never, 'documents.write')
  if (denied) return c.json(denied, 403)
  const docId = c.req.param('id')
  const d = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.projectId, id.projectId), isNull(documents.deletedAt)),
  })
  if (!d) return c.json({ error: 'Not found' }, 404)

  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const patch: Record<string, unknown> = { updatedById: id.userId }
  if (typeof b.title === 'string') patch.title = b.title.slice(0, 300)
  if (typeof b.content === 'string') patch.content = b.content.slice(0, 500_000)
  if (Object.keys(patch).length === 1) return c.json({ error: 'Nothing to update' }, 400)

  // версия перед перезаписью — правка ИИ должна быть обратима
  const { snapshot } = await import('./documents.js')
  await snapshot(docId, d.title, d.content, id.userId, 'before AI bridge edit').catch(() => {})

  const [row] = await db.update(documents).set(patch).where(eq(documents.id, docId)).returning()
  void logActivity({
    projectId: id.projectId,
    actorId: id.userId,
    action: 'update',
    entityType: 'document',
    entityId: docId,
    entityLabel: row!.title,
  })
  broadcast(id.projectId, 'documents_changed', { id: docId })
  return c.json({ id: row!.id, title: row!.title })
})

bridgeRoute.post('/documents/:id/append', async (c) => {
  const id = auth(c as never)
  const denied = await require(c as never, 'documents.write')
  if (denied) return c.json(denied, 403)
  const docId = c.req.param('id')
  const d = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.projectId, id.projectId), isNull(documents.deletedAt)),
  })
  if (!d) return c.json({ error: 'Not found' }, 404)
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const add = typeof b.content === 'string' ? b.content : ''
  if (!add) return c.json({ error: 'content is required' }, 400)

  const { snapshot } = await import('./documents.js')
  await snapshot(docId, d.title, d.content, id.userId, 'before AI bridge append').catch(() => {})
  const next = `${d.content}${add}`.slice(0, 500_000)
  await db.update(documents).set({ content: next, updatedById: id.userId }).where(eq(documents.id, docId))
  broadcast(id.projectId, 'documents_changed', { id: docId })
  return c.json({ ok: true, totalChars: next.length })
})

bridgeRoute.delete('/documents/:id', async (c) => {
  const id = auth(c as never)
  const denied = await require(c as never, 'documents.delete')
  if (denied) return c.json(denied, 403)
  const docId = c.req.param('id')
  const d = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.projectId, id.projectId), isNull(documents.deletedAt)),
  })
  if (!d) return c.json({ error: 'Not found' }, 404)
  await db.update(documents).set({ deletedAt: new Date(), deletedById: id.userId }).where(eq(documents.id, docId))
  void logActivity({
    projectId: id.projectId,
    actorId: id.userId,
    action: 'delete',
    entityType: 'document',
    entityId: docId,
    entityLabel: d.title,
  })
  broadcast(id.projectId, 'documents_changed', {})
  return c.json({ ok: true, restorableForDays: 7 })
})

// --- Чат --------------------------------------------------------------------

bridgeRoute.get('/messages', async (c) => {
  const id = auth(c as never)
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50))
  const before = c.req.query('before')
  const conds = [eq(messages.projectId, id.projectId), eq(messages.mode, 'group' as const)]
  if (before && !isNaN(Date.parse(before))) conds.push(lt(messages.createdAt, new Date(before)))
  const rows = await db
    .select({ m: messages, u: users })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorId))
    .where(and(...conds))
    .orderBy(desc(messages.createdAt))
    .limit(limit)
  return c.json({
    items: rows.reverse().map((r) => ({
      id: r.m.id,
      text: r.m.text,
      author: r.u ? { id: r.u.id, name: r.u.name } : { id: 'ai', name: 'AI' },
      createdAt: r.m.createdAt,
    })),
  })
})

bridgeRoute.post('/messages', async (c) => {
  const id = auth(c as never)
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const text = typeof b.text === 'string' ? b.text.trim() : ''
  if (!text) return c.json({ error: 'text is required' }, 400)
  const [row] = await db
    .insert(messages)
    .values({
      projectId: id.projectId,
      authorId: id.userId,
      mode: 'group',
      status: 'delivered',
      rawSend: true, // минуя диспетчер: это уже осмысленное сообщение
      text: text.slice(0, 4000),
    })
    .returning()
  broadcast(id.projectId, 'message', {
    id: row!.id,
    mode: 'group',
    status: 'delivered',
    text: row!.text,
    replyToId: null,
    createdAt: row!.createdAt,
    authorId: id.userId,
    author: { id: id.user.id, name: id.user.name, avatarUrl: null },
  })
  return c.json({ id: row!.id }, 201)
})

// --- Ресурсы (только метаданные: значения секретов через мост не отдаём) -----

bridgeRoute.get('/resources', async (c) => {
  const id = auth(c as never)
  const denied = await require(c as never, 'resources.read')
  if (denied) return c.json(denied, 403)
  const rows = await db.query.credentials.findMany({
    where: and(eq(credentials.projectId, id.projectId), isNull(credentials.deletedAt)),
  })
  return c.json({
    items: rows.map((r: typeof credentials.$inferSelect) => ({ id: r.id, name: r.name, url: r.url, description: r.description })),
    note: 'Secret values are never exposed through the bridge.',
  })
})

// --- Файлы ------------------------------------------------------------------

bridgeRoute.get('/files', async (c) => {
  const id = auth(c as never)
  const denied = await require(c as never, 'files.read')
  if (denied) return c.json(denied, 403)
  const conds = [eq(files.projectId, id.projectId), isNull(files.deletedAt), isNull(files.pendingUntil)]
  const taskId = c.req.query('taskId')
  if (taskId) conds.push(eq(files.taskId, taskId))
  const q = c.req.query('q')?.trim()
  if (q) conds.push(ilike(files.name, `%${q}%`))
  const type = c.req.query('type')
  if (type === 'image') conds.push(ilike(files.mime, 'image/%'))

  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50))
  const rows = await db
    .select()
    .from(files)
    .where(and(...conds))
    .orderBy(desc(files.createdAt))
    .limit(limit)
  return c.json({
    items: rows.map((f) => ({
      id: f.id,
      name: f.name,
      mime: f.mime,
      size: Number(f.size),
      taskId: f.taskId,
      createdAt: f.createdAt,
      contentUrl: `${(process.env.API_PUBLIC_URL || 'https://api.chatick.com').replace(/\/$/, '')}/x/files/${f.id}/content`,
    })),
  })
})

// Загрузка и отдача файлов проксируются на основной files-роут: там уже есть
// оптимизация картинок, лимиты хранилища и выбор S3/R2 проекта. Дублировать
// эту логику в мосте — гарантированный рассинхрон.
bridgeRoute.post('/files', async (c) => {
  const id = auth(c as never)
  const denied = await require(c as never, 'files.upload')
  if (denied) return c.json(denied, 403)

  const { filesRoute } = await import('./files.js')
  const { signProjectToken } = await import('../auth.js')
  const token = await signProjectToken({
    sub: id.userId,
    email: id.user.email,
    projectId: id.projectId,
    role: 'member',
  })

  // тело пересылаем как есть; manager=1 — файл сразу постоянный, не временный
  const form = await c.req.formData()
  if (!form.get('taskId')) form.set('manager', '1')

  const res = await filesRoute.request('/', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  })
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (res.ok && payload.id) {
    void logActivity({
      projectId: id.projectId,
      actorId: id.userId,
      action: 'create',
      entityType: 'file',
      entityId: String(payload.id),
      entityLabel: String(payload.name ?? ''),
    })
  }
  return c.json(payload, res.status as 200)
})

bridgeRoute.get('/files/:id/content', async (c) => {
  const id = auth(c as never)
  const denied = await require(c as never, 'files.read')
  if (denied) return c.json(denied, 403)

  const file = await db.query.files.findFirst({
    where: and(eq(files.id, c.req.param('id')), eq(files.projectId, id.projectId)),
  })
  if (!file || file.deletedAt) return c.json({ error: 'Not found' }, 404)

  const { resolveStorage, getObjectStream } = await import('../lib/s3.js')
  const { Readable } = await import('node:stream')
  try {
    const store = await resolveStorage(file.projectId)
    const { body, contentType, contentLength } = await getObjectStream(store, file.key)
    c.header('Content-Type', contentType || file.mime)
    c.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`)
    if (contentLength) c.header('Content-Length', String(contentLength))
    return c.body(Readable.toWeb(body) as ReadableStream)
  } catch (e) {
    console.error('[bridge] file read failed:', e)
    return c.json({ error: 'Read failed' }, 500)
  }
})

bridgeRoute.delete('/files/:id', async (c) => {
  const id = auth(c as never)
  const denied = await require(c as never, 'files.delete')
  if (denied) return c.json(denied, 403)
  const file = await db.query.files.findFirst({
    where: and(eq(files.id, c.req.param('id')), eq(files.projectId, id.projectId)),
  })
  if (!file || file.deletedAt) return c.json({ error: 'Not found' }, 404)
  await db.update(files).set({ deletedAt: new Date(), deletedById: id.userId }).where(eq(files.id, file.id))
  void logActivity({
    projectId: id.projectId,
    actorId: id.userId,
    action: 'delete',
    entityType: 'file',
    entityId: file.id,
    entityLabel: file.name,
  })
  return c.json({ ok: true, restorableForDays: 7 })
})

// Закрыть туннель может и сам ИИ — по завершении работы это правильный тон.
bridgeRoute.post('/disconnect', async (c) => {
  const id = auth(c as never)
  await closeSession(id.sessionId, id.userId)
  return c.json({ ok: true, message: 'Tunnel closed. The token is now dead.' })
})

export default bridgeRoute
