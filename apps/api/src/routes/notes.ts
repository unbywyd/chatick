import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm'
import { companyOf, projectPath } from '../lib/links.js'
import { db } from '../db/client.js'
import { messages, notes, projects, tasks, users } from '../db/schema.js'
import { requireProject, type ProjectEnv } from '../auth.js'
import { hasPermission, ownsOrManages } from './projects.js'
import { logActivity } from '../lib/audit.js'
import { htmlToText, sanitizeHtml } from '../lib/sanitize-html.js'
import { notify } from '../lib/notify.js'
import { broadcast } from '../ws.js'

// Заметки проекта (SPEC §8.31): журнал решений, противоречий и напоминаний.
// Отдельный домен прав notes: журнал стоит уметь открывать шире или уже, чем
// документы — например, дать читать всем, а фиксировать противоречия немногим.
export const notesRoute = new Hono<ProjectEnv>()
notesRoute.use('*', requireProject)

export const NOTE_TYPES = ['note', 'solution', 'problem', 'decision', 'contradiction', 'mismatch', 'gap', 'reminder', 'business'] as const
// mismatch — реализация разошлась с макетом/докой (есть источник истины и отклонение);
// gap — в самом макете/спеке чего-то нет (случай не описан, идти к автору).
// Оба отличаются от contradiction: там спорят люди, а не документы.
export type NoteType = (typeof NOTE_TYPES)[number]

/** Цитата из чата или откуда угодно. text — копия: сообщение может исчезнуть. */
const sourceSchema = z.object({
  messageId: z.string().nullable().optional(),
  text: z.string().max(4000),
  authorName: z.string().max(200).optional(),
  sentAt: z.string().optional(),
})

const parseJson = <T,>(raw: string, fallback: T): T => {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

type Source = z.infer<typeof sourceSchema>

const serialize = (
  n: typeof notes.$inferSelect,
  author?: { id: string; name: string; avatarUrl: string | null } | null,
  projectName?: string,
  // Задача, выросшая из заметки. Одного taskId мало: «задача создана» без
  // номера и названия — тупик, из которого не перейти к самой задаче.
  task?: { id: string; number: string; title: string; status: string } | null,
) => ({
  id: n.id,
  projectId: n.projectId,
  projectName: projectName ?? null,
  type: n.type as NoteType,
  title: n.title,
  body: n.body,
  tags: parseJson<string[]>(n.tags, []),
  scope: n.scope as 'project' | 'company',
  sources: parseJson<Source[]>(n.sources, []),
  mentionedIds: parseJson<string[]>(n.mentionedIds, []),
  remindAt: n.remindAt,
  taskId: n.taskId,
  task: task ?? null,
  createdVia: n.createdVia,
  author: author ?? null,
  createdAt: n.createdAt,
  updatedAt: n.updatedAt,
})

const alive = sql`${notes.deletedAt} is null`

/**
 * Фильтры списка. Поиск идёт по заголовку, тексту и тегам сразу — искать
 * «dns» в одном лишь заголовке бесполезно, решение описано в теле.
 */
const listQuery = z.object({
  q: z.string().optional(),
  type: z.string().optional(), // csv
  tag: z.string().optional(), // csv, И-условие
  authorId: z.string().optional(),
  mentions: z.string().optional(), // userId — заметки, где человек упомянут
  from: z.string().optional(), // ISO date
  to: z.string().optional(),
  scope: z.enum(['project', 'company']).optional(), // company = искать по всей компании
  limit: z.coerce.number().min(1).max(200).default(100),
})

notesRoute.get('/', zValidator('query', listQuery), async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'notes.read'))) return c.json({ error: 'Forbidden' }, 403)
  const f = c.req.valid('query')

  const conds = [alive]

  // scope=company: к своим заметкам добавляем company-заметки других проектов
  // компании — ради «столкнулся в новом проекте, нашёл решение из старого».
  if (f.scope === 'company') {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
    conds.push(
      project?.companyId
        ? or(eq(notes.projectId, projectId), and(eq(notes.companyId, project.companyId), eq(notes.scope, 'company')))!
        : eq(notes.projectId, projectId),
    )
  } else {
    conds.push(eq(notes.projectId, projectId))
  }

  const types = (f.type ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (types.length) conds.push(inArray(notes.type, types))
  if (f.authorId) conds.push(eq(notes.authorId, f.authorId))
  if (f.from) conds.push(gte(notes.createdAt, new Date(f.from)))
  if (f.to) {
    // «по 5 марта» включает весь день, иначе фильтр по дате всегда теряет последний
    const to = new Date(f.to)
    if (!f.to.includes('T')) to.setHours(23, 59, 59, 999)
    conds.push(lte(notes.createdAt, to))
  }
  if (f.mentions) conds.push(sql`${notes.mentionedIds}::jsonb ? ${f.mentions}`)

  // теги — И-условие: bug+dns означает обе метки сразу
  for (const tag of (f.tag ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    conds.push(sql`${notes.tags}::jsonb ? ${tag}`)
  }

  const q = (f.q ?? '').trim()
  if (q) {
    const like = `%${q}%`
    conds.push(or(sql`${notes.title} ilike ${like}`, sql`${notes.body} ilike ${like}`, sql`${notes.tags} ilike ${like}`)!)
  }

  const rows = await db
    .select({ n: notes, author: users, project: projects, task: tasks })
    .from(notes)
    .leftJoin(users, eq(users.id, notes.authorId))
    .leftJoin(projects, eq(projects.id, notes.projectId))
    // Удалённую задачу не подставляем: заметка переживает задачу, и ссылка
    // в никуда хуже её отсутствия.
    .leftJoin(tasks, and(eq(tasks.id, notes.taskId), sql`${tasks.deletedAt} is null`))
    .where(and(...conds))
    .orderBy(desc(notes.createdAt))
    .limit(f.limit)

  return c.json(
    rows.map((r) =>
      serialize(
        r.n,
        r.author ? { id: r.author.id, name: r.author.name, avatarUrl: r.author.avatarUrl } : null,
        r.project?.name,
        r.task ? { id: r.task.id, number: r.task.number, title: r.task.title, status: r.task.status } : null,
      ),
    ),
  )
})

/** Теги, уже использованные в проекте — для автодополнения и фильтров. */
notesRoute.get('/tags', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'notes.read'))) return c.json({ error: 'Forbidden' }, 403)
  const rows = await db.select({ tags: notes.tags }).from(notes).where(and(eq(notes.projectId, projectId), alive)).limit(1000)
  const counts = new Map<string, number>()
  for (const r of rows) for (const t of parseJson<string[]>(r.tags, [])) counts.set(t, (counts.get(t) ?? 0) + 1)
  return c.json(
    [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count })),
  )
})

notesRoute.get('/:id', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'notes.read'))) return c.json({ error: 'Forbidden' }, 403)
  const row = await db
    .select({ n: notes, author: users, project: projects, task: tasks })
    .from(notes)
    .leftJoin(users, eq(users.id, notes.authorId))
    .leftJoin(projects, eq(projects.id, notes.projectId))
    .leftJoin(tasks, and(eq(tasks.id, notes.taskId), sql`${tasks.deletedAt} is null`))
    .where(and(eq(notes.id, c.req.param('id')), alive))
    .limit(1)
  const found = row[0]
  if (!found) return c.json({ error: 'Not found' }, 404)

  // чужая заметка доступна, только если она company-видимая и компания та же
  if (found.n.projectId !== projectId) {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
    const shared = found.n.scope === 'company' && found.n.companyId && found.n.companyId === project?.companyId
    if (!shared) return c.json({ error: 'Not found' }, 404)
  }

  return c.json(
    serialize(
      found.n,
      found.author ? { id: found.author.id, name: found.author.name, avatarUrl: found.author.avatarUrl } : null,
      found.project?.name,
      found.task ? { id: found.task.id, number: found.task.number, title: found.task.title, status: found.task.status } : null,
    ),
  )
})

const bodySchema = z.object({
  type: z.enum(NOTE_TYPES).default('note'),
  title: z.string().max(300).default(''),
  body: z.string().max(50_000).default(''),
  tags: z.array(z.string().max(50)).max(20).default([]),
  scope: z.enum(['project', 'company']).default('project'),
  sources: z.array(sourceSchema).max(50).default([]),
  mentionedIds: z.array(z.string()).max(50).default([]),
  remindAt: z.string().nullable().optional(),
  /** id сообщений чата — сервер сам подтянет текст и автора в sources */
  sourceMessageIds: z.array(z.string()).max(50).default([]),
})

/**
 * Собирает источники из id сообщений: копируем текст и автора СЕЙЧАС, чтобы
 * доказательство пережило удаление сообщения или обрезку истории.
 */
async function sourcesFromMessages(ids: string[], projectId: string): Promise<Source[]> {
  if (!ids.length) return []
  const rows = await db
    .select({ m: messages, u: users })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorId))
    .where(and(eq(messages.projectId, projectId), inArray(messages.id, ids)))
  const byId = new Map(rows.map((r) => [r.m.id, r]))
  // сохраняем порядок, в котором их перечислили: для противоречия важна цепочка
  return ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((r) => ({
      messageId: r!.m.id,
      text: r!.m.text,
      authorName: r!.u?.name ?? 'AI',
      sentAt: r!.m.createdAt.toISOString(),
    }))
}

/** Общая логика создания — переиспользуется мостом. */
export async function createNote(
  projectId: string,
  authorId: string,
  input: z.infer<typeof bodySchema>,
  via: 'ui' | 'bridge' | 'ai' = 'ui',
) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  const fromChat = await sourcesFromMessages(input.sourceMessageIds, projectId)
  const sources = [...input.sources, ...fromChat]

  const [row] = await db
    .insert(notes)
    .values({
      projectId,
      companyId: project?.companyId ?? null,
      type: input.type,
      title: input.title.slice(0, 300),
      body: sanitizeHtml(input.body),
      tags: JSON.stringify([...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))]),
      scope: input.scope,
      sources: JSON.stringify(sources),
      mentionedIds: JSON.stringify(input.mentionedIds),
      remindAt: input.remindAt ? new Date(input.remindAt) : null,
      authorId,
      createdVia: via,
    })
    .returning()

  void logActivity({
    projectId,
    actorId: authorId,
    action: 'create',
    entityType: 'note',
    entityId: row!.id,
    entityLabel: row!.title || htmlToText(row!.body).slice(0, 80),
  })
  broadcast(projectId, 'notes', { action: 'create', id: row!.id })

  // упомянули — предупредим: заметка часто и заводится ради того, чтобы человек её увидел
  if (input.mentionedIds.length) {
    const author = await db.query.users.findFirst({ where: eq(users.id, authorId) })
    void notify({
      projectId,
      event: 'note_mention',
      recipientIds: input.mentionedIds.filter((id) => id !== authorId),
      actorId: authorId,
      actorName: author?.name || 'Someone',
      dedupeKey: `note_mention:${row!.id}`,
      link: projectPath((await companyOf(projectId)) ?? '', projectId, `/notes?note=${row!.id}`),
      preview: row!.title || htmlToText(row!.body).slice(0, 200),
      entityType: 'note',
      entityId: row!.id,
    })
  }

  return row!
}

notesRoute.post('/', zValidator('json', bodySchema), async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'notes.write'))) return c.json({ error: 'Forbidden' }, 403)
  const row = await createNote(projectId, sub, c.req.valid('json'), 'ui')
  return c.json(serialize(row), 201)
})

notesRoute.patch('/:id', zValidator('json', bodySchema.partial()), async (c) => {
  const { projectId, sub } = c.get('auth')
  const existing = await db.query.notes.findFirst({
    where: and(eq(notes.id, c.req.param('id')), eq(notes.projectId, projectId), alive),
  })
  if (!existing) return c.json({ error: 'Not found' }, 404)

  // Своя заметка — своя ответственность; чужую переписывать нельзя. Журнал
  // ценен, только если запись остаётся тем, что написал её автор.
  if (!(await hasPermission(projectId, sub, 'notes.write'))) return c.json({ error: 'Forbidden' }, 403)
  if (!(await ownsOrManages(projectId, sub, [existing.authorId]))) {
    return c.json({ error: 'Forbidden: you can only edit notes you wrote' }, 403)
  }

  const p = c.req.valid('json')
  const patch: Partial<typeof notes.$inferInsert> = { updatedAt: new Date() }
  if (p.type !== undefined) patch.type = p.type
  if (p.title !== undefined) patch.title = p.title.slice(0, 300)
  if (p.body !== undefined) patch.body = sanitizeHtml(p.body)
  if (p.tags !== undefined) patch.tags = JSON.stringify([...new Set(p.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))])
  if (p.scope !== undefined) patch.scope = p.scope
  if (p.mentionedIds !== undefined) patch.mentionedIds = JSON.stringify(p.mentionedIds)
  if (p.remindAt !== undefined) {
    patch.remindAt = p.remindAt ? new Date(p.remindAt) : null
    patch.remindedAt = null // сдвинули дату — напомнить заново
  }
  if (p.sources !== undefined || p.sourceMessageIds?.length) {
    const fromChat = await sourcesFromMessages(p.sourceMessageIds ?? [], projectId)
    patch.sources = JSON.stringify([...(p.sources ?? parseJson<Source[]>(existing.sources, [])), ...fromChat])
  }

  const [row] = await db.update(notes).set(patch).where(eq(notes.id, existing.id)).returning()
  void logActivity({
    projectId,
    actorId: sub,
    action: 'update',
    entityType: 'note',
    entityId: row!.id,
    entityLabel: row!.title || htmlToText(row!.body).slice(0, 80),
    meta: { changed: Object.keys(p) },
  })
  broadcast(projectId, 'notes', { action: 'update', id: row!.id })
  return c.json(serialize(row!))
})

/**
 * Заметка → задача (SPEC §8.31). Заметка ОСТАЁТСЯ: она объясняет, почему
 * задача такая, и хранит цитаты, из которых выросла. Ссылка двусторонняя.
 */
export async function noteToTask(
  projectId: string,
  userId: string,
  noteId: string,
  overrides: { title?: string; assigneeId?: string | null; priority?: string; dueDate?: string | null } = {},
) {
  const note = await db.query.notes.findFirst({
    where: and(eq(notes.id, noteId), eq(notes.projectId, projectId), alive),
  })
  if (!note) return { error: 'Note not found', status: 404 as const }
  if (note.taskId) {
    const existing = await db.query.tasks.findFirst({ where: eq(tasks.id, note.taskId) })
    // повторный клик не должен плодить дубликаты — возвращаем уже созданную
    if (existing) return { task: existing, already: true }
  }

  const [{ next, minSort }] = (await db
    .select({
      next: sql<number>`coalesce(max(cast(substring(${tasks.number} from 6) as int)), 0) + 1`,
      minSort: sql<number>`coalesce(min(${tasks.sortOrder}), 0)`,
    })
    .from(tasks)
    .where(eq(tasks.projectId, projectId))) as [{ next: number; minSort: number }]

  const title = (overrides.title ?? note.title ?? '').trim() || htmlToText(note.body).slice(0, 120) || 'Untitled'
  // цитаты из чата тянем в описание: без них задача теряет доказательную часть
  const quotes = parseJson<Source[]>(note.sources, [])
  const quoteHtml = quotes.length
    ? `<hr><p><b>Из переписки:</b></p>${quotes
        .map((q) => `<blockquote><p>${q.authorName ?? '—'}: ${htmlToText(q.text).slice(0, 500)}</p></blockquote>`)
        .join('')}`
    : ''

  const [row] = await db
    .insert(tasks)
    .values({
      projectId,
      number: `TASK-${next}`,
      sortOrder: minSort - 1,
      title: title.slice(0, 300),
      description: `${note.body}${quoteHtml}`,
      status: 'todo',
      priority: (overrides.priority as 'normal') ?? 'normal',
      dueDate: overrides.dueDate ? new Date(overrides.dueDate) : null,
      assigneeId: overrides.assigneeId ?? null,
      createdById: userId,
    })
    .returning()

  await db.update(notes).set({ taskId: row!.id, updatedAt: new Date() }).where(eq(notes.id, note.id))

  void logActivity({
    projectId,
    actorId: userId,
    action: 'create',
    entityType: 'task',
    entityId: row!.id,
    entityLabel: `${row!.number}: ${row!.title}`,
    meta: { fromNote: note.id },
  })
  broadcast(projectId, 'tasks', { action: 'create', id: row!.id })
  broadcast(projectId, 'notes', { action: 'update', id: note.id })
  return { task: row!, already: false }
}

notesRoute.post('/:id/task', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'notes.read'))) return c.json({ error: 'Forbidden' }, 403)
  // создаём ЗАДАЧУ — значит и права нужны задачные
  if (!(await hasPermission(projectId, sub, 'tasks.create'))) return c.json({ error: 'Forbidden' }, 403)

  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const res = await noteToTask(projectId, sub, c.req.param('id'), {
    title: typeof b.title === 'string' ? b.title : undefined,
    assigneeId: typeof b.assigneeId === 'string' ? b.assigneeId : null,
    priority: typeof b.priority === 'string' ? b.priority : undefined,
    dueDate: typeof b.dueDate === 'string' ? b.dueDate : null,
  })
  if ('error' in res) return c.json({ error: res.error }, res.status)
  return c.json({ id: res.task.id, number: res.task.number, title: res.task.title, already: res.already }, res.already ? 200 : 201)
})

notesRoute.delete('/:id', async (c) => {
  const { projectId, sub } = c.get('auth')
  const existing = await db.query.notes.findFirst({
    where: and(eq(notes.id, c.req.param('id')), eq(notes.projectId, projectId), alive),
  })
  if (!existing) return c.json({ error: 'Not found' }, 404)

  // Свою заметку участник убирает сам; чужую — только с notes.delete.
  const canDeleteAny = await hasPermission(projectId, sub, 'notes.delete')
  const canDeleteOwn =
    (await hasPermission(projectId, sub, 'notes.write')) &&
    (await ownsOrManages(projectId, sub, [existing.authorId]))
  if (!canDeleteAny && !canDeleteOwn) return c.json({ error: 'Forbidden' }, 403)

  await db.update(notes).set({ deletedAt: new Date(), deletedById: sub }).where(eq(notes.id, existing.id))
  void logActivity({
    projectId,
    actorId: sub,
    action: 'delete',
    entityType: 'note',
    entityId: existing.id,
    entityLabel: existing.title || htmlToText(existing.body).slice(0, 80),
  })
  broadcast(projectId, 'notes', { action: 'delete', id: existing.id })
  return c.json({ ok: true })
})
