import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { files, tasks, users } from '../db/schema.js'
import { requireProject, type ProjectEnv } from '../auth.js'
import { hasPermission } from './projects.js'

// Задачи проекта — project-токен; права per-user (SPEC §4.3) на каждое действие
export const tasksRoute = new Hono<ProjectEnv>()
tasksRoute.use('*', requireProject)

const STATUSES = ['todo', 'in_progress', 'review', 'done'] as const
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

const taskShape = {
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).default(''),
  status: z.enum(STATUSES).default('todo'),
  priority: z.enum(PRIORITIES).default('normal'),
  sortOrder: z.number().optional(),
  dueDate: z.string().datetime({ offset: true }).nullable().optional(),
  assigneeId: z.string().nullable().optional(),
}

function serialize(row: typeof tasks.$inferSelect, assignee?: typeof users.$inferSelect | null) {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    sortOrder: row.sortOrder,
    dueDate: row.dueDate,
    assignee: assignee ? { id: assignee.id, name: assignee.name, avatarUrl: assignee.avatarUrl } : null,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// Список задач проекта (фильтры — на клиенте, объём в рамках проекта небольшой)
tasksRoute.get('/', async (c) => {
  const { projectId } = c.get('auth')
  const rows = await db
    .select({
      task: tasks,
      assignee: users,
      attachmentsCount: sql<number>`(select count(*)::int from ${files} where ${files.taskId} = ${tasks.id})`,
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .where(eq(tasks.projectId, projectId))
    .orderBy(asc(tasks.sortOrder), desc(tasks.createdAt))
  return c.json(rows.map((r) => ({ ...serialize(r.task, r.assignee), attachmentsCount: r.attachmentsCount })))
})

// Создать — tasks.create
tasksRoute.post('/', zValidator('json', z.object(taskShape)), async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.create'))) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')

  // порядковый номер в рамках проекта: TASK-<max+1>; новая задача — наверх группы
  const [{ next, minSort }] = (await db
    .select({
      next: sql<number>`coalesce(max(cast(substring(${tasks.number} from 6) as int)), 0) + 1`,
      minSort: sql<number>`coalesce(min(${tasks.sortOrder}), 0)`,
    })
    .from(tasks)
    .where(eq(tasks.projectId, projectId))) as [{ next: number; minSort: number }]

  const [row] = await db
    .insert(tasks)
    .values({
      projectId,
      number: `TASK-${next}`,
      sortOrder: minSort - 1,
      title: body.title,
      description: body.description,
      status: body.status,
      priority: body.priority,
      dueDate: body.dueDate ? new Date(body.dueDate) : null,
      assigneeId: body.assigneeId ?? null,
      createdById: sub,
    })
    .returning()

  const assignee = row!.assigneeId ? await db.query.users.findFirst({ where: eq(users.id, row!.assigneeId) }) : null
  return c.json(serialize(row!, assignee), 201)
})

// Обновить: смена только статуса — tasks.changeStatus; всё остальное — tasks.edit
tasksRoute.patch(
  '/:taskId',
  zValidator('json', z.object({ ...taskShape, title: taskShape.title.optional(), status: z.enum(STATUSES).optional(), priority: z.enum(PRIORITIES).optional(), description: z.string().max(10_000).optional() })),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    const taskId = c.req.param('taskId')
    const task = await db.query.tasks.findFirst({ where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)) })
    if (!task) return c.json({ error: 'Not found' }, 404)

    const body = c.req.valid('json')
    const keys = Object.keys(body)
    // смена статуса (в т.ч. drag между группами с новым sortOrder) и чистая пересортировка — по changeStatus
    const statusOnly = keys.every((k) => k === 'status' || k === 'sortOrder')

    const permitted = statusOnly
      ? (await hasPermission(projectId, sub, 'tasks.changeStatus')) || (await hasPermission(projectId, sub, 'tasks.edit'))
      : await hasPermission(projectId, sub, 'tasks.edit')
    if (!permitted) return c.json({ error: 'Forbidden' }, 403)

    const patch: Record<string, unknown> = {}
    if (body.title !== undefined) patch.title = body.title
    if (body.description !== undefined) patch.description = body.description
    if (body.status !== undefined) patch.status = body.status
    if (body.priority !== undefined) patch.priority = body.priority
    if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder
    if (body.dueDate !== undefined) patch.dueDate = body.dueDate ? new Date(body.dueDate) : null
    if (body.assigneeId !== undefined) patch.assigneeId = body.assigneeId

    const [row] = await db.update(tasks).set(patch).where(eq(tasks.id, taskId)).returning()
    const assignee = row!.assigneeId ? await db.query.users.findFirst({ where: eq(users.id, row!.assigneeId) }) : null
    return c.json(serialize(row!, assignee))
  },
)

// Удалить — tasks.delete
tasksRoute.delete('/:taskId', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.delete'))) return c.json({ error: 'Forbidden' }, 403)

  const taskId = c.req.param('taskId')
  const task = await db.query.tasks.findFirst({ where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)) })
  if (!task) return c.json({ error: 'Not found' }, 404)

  await db.delete(tasks).where(eq(tasks.id, taskId))
  return c.json({ ok: true })
})
