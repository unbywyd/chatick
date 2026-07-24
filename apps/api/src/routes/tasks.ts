import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { files, projects, taskComments, taskGroups, taskNotes, tasks, users } from '../db/schema.js'
import { requireProject, type ProjectEnv } from '../auth.js'
import { hasPermission } from './projects.js'
import { improveTask, validateTask, generateTaskNotes } from '../lib/llm.js'
import { buildTeamContext } from '../lib/memory.js'
import { notify, extractMentions } from '../lib/notify.js'
import { broadcast } from '../ws.js'

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
  groupId: z.string().nullable().optional(),
  estimateMinutes: z.number().int().min(0).max(100000).nullable().optional(),
}

// Уведомления по задаче: назначение, смена статуса, упоминания в описании (SPEC §8.9).
async function notifyTask(
  projectId: string,
  actorId: string,
  task: typeof tasks.$inferSelect,
  opts: { assigneeChanged?: boolean; statusChanged?: boolean; mentions?: boolean },
) {
  const actor = await db.query.users.findFirst({ where: eq(users.id, actorId) })
  const actorName = actor?.name || 'Someone'
  const link = `/p/${projectId}?task=${task.id}`

  if (opts.assigneeChanged && task.assigneeId) {
    await notify({
      projectId,
      event: 'task_assigned',
      recipientIds: [task.assigneeId],
      actorId,
      actorName,
      dedupeKey: `task_assigned:${task.id}:${task.assigneeId}`,
      link,
      preview: task.title,
    })
  }
  if (opts.statusChanged && task.assigneeId) {
    await notify({
      projectId,
      event: 'task_status',
      recipientIds: [task.assigneeId],
      actorId,
      actorName,
      dedupeKey: `task_status:${task.id}:${task.status}:${task.assigneeId}`,
      link,
      preview: task.title,
      vars: { ref: task.number, status: task.status },
    })
  }
  if (opts.mentions) {
    const mentioned = extractMentions(task.description)
    if (mentioned.length) {
      await notify({
        projectId,
        event: 'task_mention',
        recipientIds: mentioned,
        actorId,
        actorName,
        dedupeKey: `task_mention:${task.id}`,
        link,
        preview: task.title,
      })
    }
  }
}

function serialize(row: typeof tasks.$inferSelect, assignee?: typeof users.$inferSelect | null) {
  return {
    id: row.id,
    number: row.number,
    groupId: row.groupId,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    estimateMinutes: row.estimateMinutes ? Number(row.estimateMinutes) : null,
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
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.read'))) return c.json({ error: 'Forbidden' }, 403)
  const rows = await db
    .select({
      task: tasks,
      assignee: users,
      attachmentsCount: sql<number>`(select count(*)::int from ${files} where ${files.taskId} = ${tasks.id} and ${files.deletedAt} is null)`,
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

  // aiConfig.improveTasks: адаптировать под язык проекта + слегка улучшить (fail-open)
  let { title, description } = body
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  const aiConfig = JSON.parse(project?.aiConfig || '{}') as { improveTasks?: boolean; generateTaskNotes?: boolean; language?: string }
  let aiImproved = false
  if (aiConfig.improveTasks) {
    const improved = await improveTask(projectId, { title, description, language: aiConfig.language ?? 'en' })
    if (improved) {
      title = improved.title
      description = improved.description
      aiImproved = true
    }
  }

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
      title,
      description,
      status: body.status,
      priority: body.priority,
      dueDate: body.dueDate ? new Date(body.dueDate) : null,
      assigneeId: body.assigneeId ?? null,
      groupId: body.groupId ?? null,
      estimateMinutes: body.estimateMinutes != null ? String(body.estimateMinutes) : null,
      createdById: sub,
    })
    .returning()

  const assignee = row!.assigneeId ? await db.query.users.findFirst({ where: eq(users.id, row!.assigneeId) }) : null
  void notifyTask(projectId, sub, row!, { assigneeChanged: Boolean(row!.assigneeId), mentions: true })

  // Заметки ИИ (SPEC §8.14): генерируем в фоне, только если включено; broadcast не нужен — клиент подтянет
  if (aiConfig.generateTaskNotes) {
    void (async () => {
      try {
        const teamContext = await buildTeamContext(projectId)
        const notes = await generateTaskNotes(projectId, { title, description, language: aiConfig.language ?? 'en', teamContext })
        if (notes && notes.length) {
          await db.insert(taskNotes).values(notes.map((n) => ({ taskId: row!.id, projectId, kind: n.kind, body: n.body })))
        }
      } catch (e) {
        console.error('[tasks] generateTaskNotes failed:', e)
      }
    })()
  }

  broadcast(projectId, 'tasks_changed', {})
  return c.json({ ...serialize(row!, assignee), aiImproved, notesPending: Boolean(aiConfig.generateTaskNotes) }, 201)
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
    // drag: смена статуса/группы/порядка — по changeStatus (лёгкое перемещение на доске)
    const statusOnly = keys.every((k) => k === 'status' || k === 'sortOrder' || k === 'groupId')

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
    if (body.groupId !== undefined) patch.groupId = body.groupId
    if (body.estimateMinutes !== undefined) patch.estimateMinutes = body.estimateMinutes != null ? String(body.estimateMinutes) : null

    const [row] = await db.update(tasks).set(patch).where(eq(tasks.id, taskId)).returning()
    const assignee = row!.assigneeId ? await db.query.users.findFirst({ where: eq(users.id, row!.assigneeId) }) : null
    void notifyTask(projectId, sub, row!, {
      assigneeChanged: body.assigneeId !== undefined && body.assigneeId !== task.assigneeId && Boolean(row!.assigneeId),
      statusChanged: body.status !== undefined && body.status !== task.status,
      mentions: body.description !== undefined && body.description !== task.description,
    })
    broadcast(projectId, 'tasks_changed', {})
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
  broadcast(projectId, 'tasks_changed', {})
  return c.json({ ok: true })
})

// --- Группы задач = спринты (SPEC §8.6) --------------------------------------

const HEX = /^#[0-9a-fA-F]{6}$/

// Список групп проекта
tasksRoute.get('/groups', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.read'))) return c.json({ error: 'Forbidden' }, 403)
  const rows = await db
    .select()
    .from(taskGroups)
    .where(eq(taskGroups.projectId, projectId))
    .orderBy(asc(taskGroups.sortOrder), asc(taskGroups.createdAt))
  return c.json(rows.map((g) => ({ id: g.id, name: g.name, color: g.color, sortOrder: g.sortOrder })))
})

// Создать группу — tasks.edit
tasksRoute.post(
  '/groups',
  zValidator('json', z.object({ name: z.string().min(1).max(120), color: z.string().regex(HEX).default('#64748b') })),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    if (!(await hasPermission(projectId, sub, 'tasks.edit'))) return c.json({ error: 'Forbidden' }, 403)
    const { name, color } = c.req.valid('json')
    const [{ minSort }] = (await db
      .select({ minSort: sql<number>`coalesce(min(${taskGroups.sortOrder}), 0)` })
      .from(taskGroups)
      .where(eq(taskGroups.projectId, projectId))) as [{ minSort: number }]
    const [row] = await db
      .insert(taskGroups)
      .values({ projectId, name, color, sortOrder: minSort - 1, createdById: sub })
      .returning()
    broadcast(projectId, 'tasks_changed', {})
    return c.json({ id: row!.id, name: row!.name, color: row!.color, sortOrder: row!.sortOrder }, 201)
  },
)

// Обновить группу (имя/цвет/порядок) — tasks.edit
tasksRoute.patch(
  '/groups/:groupId',
  zValidator(
    'json',
    z.object({ name: z.string().min(1).max(120).optional(), color: z.string().regex(HEX).optional(), sortOrder: z.number().optional() }),
  ),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    if (!(await hasPermission(projectId, sub, 'tasks.edit'))) return c.json({ error: 'Forbidden' }, 403)
    const groupId = c.req.param('groupId')
    const group = await db.query.taskGroups.findFirst({ where: and(eq(taskGroups.id, groupId), eq(taskGroups.projectId, projectId)) })
    if (!group) return c.json({ error: 'Not found' }, 404)
    const b = c.req.valid('json')
    const patch: Record<string, unknown> = {}
    if (b.name !== undefined) patch.name = b.name
    if (b.color !== undefined) patch.color = b.color
    if (b.sortOrder !== undefined) patch.sortOrder = b.sortOrder
    const [row] = await db.update(taskGroups).set(patch).where(eq(taskGroups.id, groupId)).returning()
    broadcast(projectId, 'tasks_changed', {})
    return c.json({ id: row!.id, name: row!.name, color: row!.color, sortOrder: row!.sortOrder })
  },
)

// Удалить группу — tasks.edit. Задачи не трогаем: groupId → null (остаются «без группы»)
tasksRoute.delete('/groups/:groupId', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.edit'))) return c.json({ error: 'Forbidden' }, 403)
  const groupId = c.req.param('groupId')
  const group = await db.query.taskGroups.findFirst({ where: and(eq(taskGroups.id, groupId), eq(taskGroups.projectId, projectId)) })
  if (!group) return c.json({ error: 'Not found' }, 404)
  await db.delete(taskGroups).where(eq(taskGroups.id, groupId)) // FK onDelete: set null
  broadcast(projectId, 'tasks_changed', {})
  return c.json({ ok: true })
})

// --- Заметки ИИ к задаче (SPEC §8.14) ----------------------------------------

// Список заметок ИИ по задаче
tasksRoute.get('/:taskId/notes', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.read'))) return c.json({ error: 'Forbidden' }, 403)
  const taskId = c.req.param('taskId')
  const rows = await db
    .select()
    .from(taskNotes)
    .where(and(eq(taskNotes.taskId, taskId), eq(taskNotes.projectId, projectId)))
    .orderBy(asc(taskNotes.createdAt))
  return c.json(rows.map((n) => ({ id: n.id, kind: n.kind, body: n.body, createdAt: n.createdAt })))
})

// Удалить заметку — tasks.edit (можно почистить нерелевантное)
tasksRoute.delete('/:taskId/notes/:noteId', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.edit'))) return c.json({ error: 'Forbidden' }, 403)
  const { noteId } = c.req.param()
  await db.delete(taskNotes).where(and(eq(taskNotes.id, noteId), eq(taskNotes.projectId, projectId)))
  return c.json({ ok: true })
})

// Перегенерировать заметки вручную (tasks.edit): удаляет старые ИИ-заметки и создаёт новые
tasksRoute.post('/:taskId/notes/regenerate', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.edit'))) return c.json({ error: 'Forbidden' }, 403)
  const taskId = c.req.param('taskId')
  const task = await db.query.tasks.findFirst({ where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)) })
  if (!task) return c.json({ error: 'Not found' }, 404)
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  const language = (JSON.parse(project?.aiConfig || '{}') as { language?: string }).language ?? 'en'
  const teamContext = await buildTeamContext(projectId)
  const notes = await generateTaskNotes(projectId, { title: task.title, description: task.description, language, teamContext })
  if (notes === null) return c.json({ error: 'AI unavailable' }, 503)
  await db.delete(taskNotes).where(and(eq(taskNotes.taskId, taskId), eq(taskNotes.projectId, projectId)))
  if (notes.length) await db.insert(taskNotes).values(notes.map((n) => ({ taskId, projectId, kind: n.kind, body: n.body })))
  return c.json({ count: notes.length })
})

// --- Комментарии задач (SPEC §8.9) -------------------------------------------

async function commentFiles(commentIds: string[]) {
  if (!commentIds.length) return new Map<string, { id: string; name: string; mime: string; deleted: boolean }[]>()
  const rows = await db.query.files.findMany({ where: sql`${files.commentId} in (${sql.join(commentIds.map((id) => sql`${id}`), sql`, `)})` })
  const map = new Map<string, { id: string; name: string; mime: string; deleted: boolean }[]>()
  for (const f of rows) {
    if (!f.commentId) continue
    const arr = map.get(f.commentId) ?? []
    arr.push({ id: f.id, name: f.name, mime: f.mime, deleted: Boolean(f.deletedAt) })
    map.set(f.commentId, arr)
  }
  return map
}

// Список комментариев задачи
tasksRoute.get('/:taskId/comments', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.read'))) return c.json({ error: 'Forbidden' }, 403)
  const taskId = c.req.param('taskId')
  const rows = await db
    .select({ comment: taskComments, author: users })
    .from(taskComments)
    .leftJoin(users, eq(users.id, taskComments.authorId))
    .where(and(eq(taskComments.taskId, taskId), eq(taskComments.projectId, projectId)))
    .orderBy(asc(taskComments.createdAt))
  const fileMap = await commentFiles(rows.map((r) => r.comment.id))
  return c.json(
    rows.map((r) => ({
      id: r.comment.id,
      body: r.comment.body,
      replyToId: r.comment.replyToId,
      createdAt: r.comment.createdAt,
      author: r.author ? { id: r.author.id, name: r.author.name, avatarUrl: r.author.avatarUrl } : null,
      files: fileMap.get(r.comment.id) ?? [],
    })),
  )
})

// Создать комментарий — нужен tasks.read (комментировать может любой, кто видит задачи).
// attachmentIds: файлы проекта (без владельца-сообщения) привязываются к комментарию и задаче.
tasksRoute.post(
  '/:taskId/comments',
  zValidator('json', z.object({ body: z.string().min(1).max(10_000), replyToId: z.string().nullable().optional(), attachmentIds: z.array(z.string()).default([]) })),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    if (!(await hasPermission(projectId, sub, 'tasks.read'))) return c.json({ error: 'Forbidden' }, 403)
    const taskId = c.req.param('taskId')
    const task = await db.query.tasks.findFirst({ where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)) })
    if (!task) return c.json({ error: 'Not found' }, 404)

    const { body, replyToId, attachmentIds } = c.req.valid('json')
    const [row] = await db.insert(taskComments).values({ taskId, projectId, authorId: sub, body, replyToId: replyToId ?? null }).returning()

    // привязать файлы к комментарию + задаче (файл появляется и в разделе Files задачи)
    if (attachmentIds.length) {
      await db
        .update(files)
        .set({ commentId: row!.id, taskId, pendingUntil: null })
        .where(and(sql`${files.id} in (${sql.join(attachmentIds.map((id) => sql`${id}`), sql`, `)})`, eq(files.projectId, projectId), eq(files.uploadedById, sub)))
    }

    const author = await db.query.users.findFirst({ where: eq(users.id, sub) })
    const actorName = author?.name || 'Someone'
    const link = `/p/${projectId}?task=${taskId}`

    // уведомления: упоминания в комментарии + автору/ассайни задачи о новом комментарии
    const mentioned = extractMentions(body)
    if (mentioned.length)
      void notify({ projectId, event: 'comment_mention', recipientIds: mentioned, actorId: sub, actorName, dedupeKey: `comment_mention:${row!.id}`, link, preview: body })
    const watchers = [task.assigneeId, task.createdById].filter((x): x is string => Boolean(x) && x !== sub && !mentioned.includes(x!))
    if (watchers.length)
      void notify({ projectId, event: 'task_comment', recipientIds: watchers, actorId: sub, actorName, dedupeKey: `task_comment:${row!.id}`, link, preview: body, vars: { ref: task.number } })

    broadcast(projectId, 'task_comments_changed', { taskId })
    const fileMap = await commentFiles([row!.id])
    return c.json(
      {
        id: row!.id,
        body: row!.body,
        replyToId: row!.replyToId,
        createdAt: row!.createdAt,
        author: author ? { id: author.id, name: author.name, avatarUrl: author.avatarUrl } : null,
        files: fileMap.get(row!.id) ?? [],
      },
      201,
    )
  },
)

// Редактировать комментарий — только автор
tasksRoute.patch('/:taskId/comments/:commentId', zValidator('json', z.object({ body: z.string().min(1).max(10_000) })), async (c) => {
  const { projectId, sub } = c.get('auth')
  const commentId = c.req.param('commentId')
  const comment = await db.query.taskComments.findFirst({ where: and(eq(taskComments.id, commentId), eq(taskComments.projectId, projectId)) })
  if (!comment) return c.json({ error: 'Not found' }, 404)
  if (comment.authorId !== sub) return c.json({ error: 'Forbidden' }, 403)
  const [row] = await db.update(taskComments).set({ body: c.req.valid('json').body }).where(eq(taskComments.id, commentId)).returning()
  broadcast(projectId, 'task_comments_changed', { taskId: comment.taskId })
  return c.json({ id: row!.id, body: row!.body })
})

// Удалить комментарий — автор, owner или admin
tasksRoute.delete('/:taskId/comments/:commentId', async (c) => {
  const { projectId, sub, role } = c.get('auth')
  const commentId = c.req.param('commentId')
  const comment = await db.query.taskComments.findFirst({ where: and(eq(taskComments.id, commentId), eq(taskComments.projectId, projectId)) })
  if (!comment) return c.json({ error: 'Not found' }, 404)
  if (comment.authorId !== sub && role !== 'owner' && role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
  await db.delete(taskComments).where(eq(taskComments.id, commentId))
  broadcast(projectId, 'task_comments_changed', { taskId: comment.taskId })
  return c.json({ ok: true })
})

// ИИ-валидация задачи в форме создания/редактирования (SPEC §8.6): «Проверить мою задачу».
// Не сохраняет ничего — возвращает совет + улучшенный вариант для apply.
tasksRoute.post('/validate', zValidator('json', z.object({ title: z.string().default(''), description: z.string().default('') })), async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.read'))) return c.json({ error: 'Forbidden' }, 403)
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  const language = (JSON.parse(project?.aiConfig || '{}') as { language?: string }).language ?? 'en'
  const { title, description } = c.req.valid('json')
  const result = await validateTask(projectId, { title, description, language })
  if (!result) return c.json({ error: 'AI unavailable' }, 503)
  return c.json(result)
})
