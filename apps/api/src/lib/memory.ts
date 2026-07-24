import { and, asc, desc, eq, gt, gte, ilike, lte, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { chatSummaries, files, messages, projects, tasks, users } from '../db/schema.js'
import { hasPermission } from '../routes/projects.js'
import { projectLlm, complete, type ToolDef, type ToolHandler } from './llm.js'

// Память ИИ (SPEC §5.6): саммари-цепочка + инструменты + фоновое сжатие.

const TAIL_SIZE = 30 // живой хвост в промпте

// --- Промпт-контекст: оглавление + последнее саммари + живой хвост ----------

export async function buildMemoryContext(projectId: string): Promise<string> {
  const [summaries, tail] = await Promise.all([
    db.query.chatSummaries.findMany({
      where: eq(chatSummaries.projectId, projectId),
      orderBy: [desc(chatSummaries.toAt)],
      limit: 30,
    }),
    db
      .select({ msg: messages, author: users })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.authorId))
      .where(and(eq(messages.projectId, projectId), eq(messages.mode, 'group'), eq(messages.status, 'delivered')))
      .orderBy(desc(messages.createdAt))
      .limit(TAIL_SIZE),
  ])

  const parts: string[] = []
  if (summaries.length > 0) {
    parts.push(
      'CONVERSATION INDEX (older history, use get_summary/search_messages tools for details):',
      ...summaries
        .slice(1)
        .reverse()
        .map((s) => `- [${s.id}] "${s.name}" (${s.fromAt.toISOString().slice(0, 10)}..${s.toAt.toISOString().slice(0, 10)}, ${s.messageCount} msgs)`),
      '',
      `LATEST SUMMARY "${summaries[0]!.name}":`,
      summaries[0]!.content,
    )
  }
  parts.push(
    '',
    'RECENT MESSAGES:',
    ...tail.reverse().map((r) => `${r.author?.name ?? 'AI'}: ${r.msg.text}`),
  )
  return parts.join('\n')
}

// --- Инструменты -------------------------------------------------------------

export function memoryTools(projectId: string, actorUserId: string): { tools: ToolDef[]; handlers: Record<string, ToolHandler> } {
  const tools: ToolDef[] = [
    {
      name: 'read_chat',
      description:
        'Read recent GROUP chat messages (the team conversation). Use when the user asks about what was said in the chat. Paginate back with before (ISO date).',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'messages to read, default 30, max 60' },
          before: { type: 'string', description: 'ISO date — read messages older than this' },
        },
      },
    },
    {
      name: 'list_summaries',
      description: 'List conversation summaries (name, dates, message count). Paginated, newest first.',
      parameters: { type: 'object', properties: { page: { type: 'number', description: '1-based page, 20 per page' } } },
    },
    {
      name: 'get_summary',
      description: 'Get the full text of one conversation summary by its id.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'search_summaries',
      description:
        'Search the History (daily conversation summaries). Filter by text and/or a date range (ISO YYYY-MM-DD). Use to recall what happened on/around a date without scanning raw messages.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'optional text to match in summary name/content' },
          from: { type: 'string', description: 'optional start date YYYY-MM-DD' },
          to: { type: 'string', description: 'optional end date YYYY-MM-DD' },
        },
      },
    },
    {
      name: 'search_messages',
      description: 'Full-text search across the ENTIRE raw chat history. Use for facts not in summaries.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    {
      name: 'list_files',
      description: 'List project files (name, id, who uploaded, when). Optionally filter by name.',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
    {
      name: 'list_tasks',
      description: 'List project tasks (number, title, status, priority, assignee, due date).',
      parameters: { type: 'object', properties: { status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'done'] } } },
    },
    {
      name: 'get_task',
      description: 'Get one task with full description by its number (e.g. TASK-5).',
      parameters: { type: 'object', properties: { number: { type: 'string' } }, required: ['number'] },
    },
    {
      name: 'create_task',
      description: "Create a task. Requires the author's tasks.create permission.",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        },
        required: ['title'],
      },
    },
    {
      name: 'update_task',
      description: "Update a task's title/description/priority by number. Requires tasks.edit.",
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        },
        required: ['number'],
      },
    },
    {
      name: 'change_task_status',
      description: 'Change task status by number. Requires tasks.changeStatus.',
      parameters: {
        type: 'object',
        properties: { number: { type: 'string' }, status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'done'] } },
        required: ['number', 'status'],
      },
    },
    {
      name: 'delete_task',
      description: 'Delete a task by number. Requires tasks.delete.',
      parameters: { type: 'object', properties: { number: { type: 'string' } }, required: ['number'] },
    },
  ]

  const findTask = (number: string) =>
    db.query.tasks.findFirst({ where: and(eq(tasks.projectId, projectId), eq(tasks.number, number.toUpperCase())) })

  const handlers: Record<string, ToolHandler> = {
    read_chat: async (args) => {
      const limit = Math.min(60, Math.max(1, Number(args.limit) || 30))
      const before = typeof args.before === 'string' && args.before ? new Date(args.before) : null
      const where = and(
        eq(messages.projectId, projectId),
        eq(messages.mode, 'group'),
        eq(messages.status, 'delivered'),
        ...(before && !isNaN(before.getTime()) ? [sql`${messages.createdAt} < ${before}`] : []),
      )
      const rows = await db
        .select({ msg: messages, author: users })
        .from(messages)
        .leftJoin(users, eq(users.id, messages.authorId))
        .where(where)
        .orderBy(desc(messages.createdAt))
        .limit(limit)
      if (!rows.length) return 'No messages.'
      return rows
        .reverse()
        .map((r) => `[${r.msg.createdAt.toISOString().slice(0, 16)}] ${r.author?.name ?? 'AI'}: ${r.msg.text.slice(0, 500)}`)
        .join('\n')
    },
    list_summaries: async (args) => {
      const page = Math.max(1, Number(args.page) || 1)
      const rows = await db.query.chatSummaries.findMany({
        where: eq(chatSummaries.projectId, projectId),
        orderBy: [desc(chatSummaries.toAt)],
        limit: 20,
        offset: (page - 1) * 20,
      })
      if (rows.length === 0) return page === 1 ? 'No summaries yet.' : 'No more summaries.'
      return rows
        .map((s) => `[${s.id}] "${s.name}" ${s.fromAt.toISOString().slice(0, 10)}..${s.toAt.toISOString().slice(0, 10)} (${s.messageCount} msgs)`)
        .join('\n')
    },
    get_summary: async (args) => {
      const s = await db.query.chatSummaries.findFirst({
        where: and(eq(chatSummaries.id, String(args.id)), eq(chatSummaries.projectId, projectId)),
      })
      return s ? `"${s.name}"\n${s.content}` : 'Summary not found.'
    },
    search_summaries: async (args) => {
      const q = String(args.query ?? '').trim()
      const from = String(args.from ?? '').trim()
      const to = String(args.to ?? '').trim()
      const conds = [eq(chatSummaries.projectId, projectId)]
      if (q) conds.push(or(ilike(chatSummaries.name, `%${q}%`), ilike(chatSummaries.content, `%${q}%`))!)
      if (from && !isNaN(Date.parse(from))) conds.push(gte(chatSummaries.toAt, new Date(from)))
      if (to && !isNaN(Date.parse(to))) conds.push(lte(chatSummaries.fromAt, new Date(to + 'T23:59:59')))
      const rows = await db
        .select()
        .from(chatSummaries)
        .where(and(...conds))
        .orderBy(desc(chatSummaries.toAt))
        .limit(15)
      if (!rows.length) return 'No summaries found for that filter.'
      return rows
        .map((s) => `[${s.id}] "${s.name}" (${s.fromAt.toISOString().slice(0, 10)}..${s.toAt.toISOString().slice(0, 10)})\n${s.content.slice(0, 400)}`)
        .join('\n\n')
    },
    search_messages: async (args) => {
      const q = String(args.query ?? '').trim()
      if (!q) return 'Empty query.'
      const rows = await db
        .select({ msg: messages, author: users })
        .from(messages)
        .leftJoin(users, eq(users.id, messages.authorId))
        .where(and(eq(messages.projectId, projectId), eq(messages.status, 'delivered'), ilike(messages.text, `%${q}%`)))
        .orderBy(desc(messages.createdAt))
        .limit(20)
      if (!rows.length) return 'Nothing found.'
      return rows.map((r) => `[${r.msg.createdAt.toISOString().slice(0, 16)}] ${r.author?.name ?? 'AI'}: ${r.msg.text.slice(0, 300)}`).join('\n')
    },
    list_files: async (args) => {
      const q = typeof args.query === 'string' ? args.query.trim() : ''
      const rows = await db
        .select({ file: files, uploader: users })
        .from(files)
        .leftJoin(users, eq(users.id, files.uploadedById))
        .where(q ? and(eq(files.projectId, projectId), ilike(files.name, `%${q}%`)) : eq(files.projectId, projectId))
        .orderBy(desc(files.createdAt))
        .limit(30)
      if (!rows.length) return 'No files.'
      // ссылки логические: клиент открывает файл по id через таб «Файлы»
      return rows
        .map((r) => `"${r.file.name}" (id=${r.file.id}, ${r.uploader?.name ?? '?'}, ${r.file.createdAt.toISOString().slice(0, 10)})`)
        .join('\n')
    },
    list_tasks: async (args) => {
      const status = typeof args.status === 'string' ? args.status : null
      const rows = await db
        .select({ task: tasks, assignee: users })
        .from(tasks)
        .leftJoin(users, eq(users.id, tasks.assigneeId))
        .where(
          status
            ? and(eq(tasks.projectId, projectId), eq(tasks.status, status as 'todo'))
            : eq(tasks.projectId, projectId),
        )
        .orderBy(desc(tasks.createdAt))
        .limit(50)
      if (!rows.length) return 'No tasks.'
      return rows
        .map(
          (r) =>
            `${r.task.number} [${r.task.status}/${r.task.priority}] "${r.task.title}"${r.assignee ? ` → ${r.assignee.name}` : ''}${r.task.dueDate ? ` due ${r.task.dueDate.toISOString().slice(0, 10)}` : ''}`,
        )
        .join('\n')
    },
    get_task: async (args) => {
      const t = await findTask(String(args.number ?? ''))
      if (!t) return 'Task not found.'
      return `${t.number} [${t.status}/${t.priority}] "${t.title}"\n${t.description || '(no description)'}`
    },
    create_task: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'tasks.create')))
        return 'PERMISSION DENIED: the author does not have the tasks.create permission. Politely refuse.'
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
          title: String(args.title ?? '').slice(0, 300),
          description: String(args.description ?? '').slice(0, 10_000),
          priority: (['low', 'normal', 'high', 'urgent'].includes(String(args.priority)) ? args.priority : 'normal') as 'normal',
          createdById: actorUserId,
        })
        .returning()
      return `Created ${row!.number}: "${row!.title}"`
    },
    update_task: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'tasks.edit')))
        return 'PERMISSION DENIED: the author does not have the tasks.edit permission. Politely refuse.'
      const t = await findTask(String(args.number ?? ''))
      if (!t) return 'Task not found.'
      const patch: Record<string, unknown> = {}
      if (typeof args.title === 'string') patch.title = args.title.slice(0, 300)
      if (typeof args.description === 'string') patch.description = args.description.slice(0, 10_000)
      if (['low', 'normal', 'high', 'urgent'].includes(String(args.priority))) patch.priority = args.priority
      if (!Object.keys(patch).length) return 'Nothing to update.'
      await db.update(tasks).set(patch).where(eq(tasks.id, t.id))
      return `Updated ${t.number}.`
    },
    change_task_status: async (args) => {
      const allowed =
        (await hasPermission(projectId, actorUserId, 'tasks.changeStatus')) ||
        (await hasPermission(projectId, actorUserId, 'tasks.edit'))
      if (!allowed) return 'PERMISSION DENIED: the author cannot change task statuses. Politely refuse.'
      const t = await findTask(String(args.number ?? ''))
      if (!t) return 'Task not found.'
      const status = String(args.status ?? '')
      if (!['todo', 'in_progress', 'review', 'done'].includes(status)) return 'Invalid status.'
      await db.update(tasks).set({ status: status as 'todo' }).where(eq(tasks.id, t.id))
      return `${t.number} → ${status}.`
    },
    delete_task: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'tasks.delete')))
        return 'PERMISSION DENIED: the author does not have the tasks.delete permission. Politely refuse.'
      const t = await findTask(String(args.number ?? ''))
      if (!t) return 'Task not found.'
      await db.delete(tasks).where(eq(tasks.id, t.id))
      return `Deleted ${t.number}.`
    },
  }

  return { tools, handlers }
}

// --- Фоновое сжатие: саммари ПО ДНЯМ на языке проекта (SPEC §8.5) -------------

const LANG_NAMES: Record<string, string> = { en: 'English', ru: 'Russian', he: 'Hebrew' }
// Токен-эвристика: ~4 символа на токен; целимся ≤ ~2500 токенов исходника на саммари.
const MAX_CHARS_PER_SUMMARY = 10_000
const UTC_DAY = (d: Date) => d.toISOString().slice(0, 10)

type MsgRow = { msg: typeof messages.$inferSelect; author: typeof users.$inferSelect | null }

async function summarizeChunk(
  cfg: NonNullable<Awaited<ReturnType<typeof projectLlm>>>,
  langName: string,
  day: string,
  chunk: MsgRow[],
  part: number,
  total: number,
): Promise<void> {
  const transcript = chunk
    .map((r) => `[${r.msg.createdAt.toISOString().slice(11, 16)}] ${r.author?.name ?? 'AI'}: ${r.msg.text}`)
    .join('\n')

  const raw = await complete(cfg, {
    system: [
      `You compress one day of team chat into a summary for long-term memory. Date: ${day}${total > 1 ? ` (part ${part}/${total})` : ''}.`,
      'Capture: decisions, facts, statuses, questions+answers, mentioned files/tasks, who did what. Omit chit-chat.',
      'First line: a SHORT conversation name (3-6 words, no quotes). Then a blank line. Then the summary (bullet points ok).',
      `IMPORTANT: write BOTH the name and the summary strictly in ${langName}, regardless of the chat's original language.`,
    ].join('\n'),
    user: transcript,
    maxTokens: 900,
  })
  if (!raw) throw new Error('empty summary')

  const [firstLine, ...restLines] = raw.trim().split('\n')
  let name = (firstLine ?? 'Conversation').replace(/^["#\s]+|["\s]+$/g, '').slice(0, 120) || 'Conversation'
  if (total > 1) name = `${name} (${part}/${total})`
  const content = restLines.join('\n').trim() || raw.trim()

  await db.insert(chatSummaries).values({
    projectId: chunk[0]!.msg.projectId,
    name,
    content,
    fromAt: chunk[0]!.msg.createdAt,
    toAt: chunk[chunk.length - 1]!.msg.createdAt,
    messageCount: String(chunk.length),
  })
}

/**
 * Сжать сообщения в саммари ПО ДНЯМ. За вызов обрабатывает один самый старый
 * ПОЛНОСТЬЮ ЗАВЕРШЁННЫЙ день (сегодняшний не трогаем — он ещё дописывается).
 * Крупный день дробится на несколько саммари по токен-бюджету. Fail-safe.
 */
export async function maybeCompress(projectId: string): Promise<void> {
  try {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
    if (!project) return
    const cfg = await projectLlm(projectId)
    if (!cfg) return
    const aiConfig = JSON.parse(project.aiConfig || '{}') as { language?: string }
    const langName = LANG_NAMES[aiConfig.language ?? 'en'] ?? 'English'

    const cursor = project.lastSummarizedAt ?? new Date(0)
    // берём достаточно, чтобы точно захватить весь старый день
    const rows = await db
      .select({ msg: messages, author: users })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.authorId))
      .where(
        and(
          eq(messages.projectId, projectId),
          eq(messages.mode, 'group'),
          eq(messages.status, 'delivered'),
          gt(messages.createdAt, cursor),
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(1000)

    if (rows.length === 0) return

    const today = UTC_DAY(new Date())
    const oldestDay = UTC_DAY(rows[0]!.msg.createdAt)
    // если весь несжатый остаток — это сегодня, ждём (день не завершён)
    if (oldestDay === today) return

    const dayRows = rows.filter((r) => UTC_DAY(r.msg.createdAt) === oldestDay)

    // дробим день на части по символьному бюджету
    const chunks: MsgRow[][] = []
    let cur: MsgRow[] = []
    let curChars = 0
    for (const r of dayRows) {
      const len = (r.msg.text?.length ?? 0) + 32
      if (cur.length && curChars + len > MAX_CHARS_PER_SUMMARY) {
        chunks.push(cur)
        cur = []
        curChars = 0
      }
      cur.push(r)
      curChars += len
    }
    if (cur.length) chunks.push(cur)

    for (let i = 0; i < chunks.length; i++) {
      await summarizeChunk(cfg, langName, oldestDay, chunks[i]!, i + 1, chunks.length)
    }

    const lastTs = dayRows[dayRows.length - 1]!.msg.createdAt
    await db.update(projects).set({ lastSummarizedAt: lastTs }).where(eq(projects.id, projectId))
    console.log(`[memory] summarized day ${oldestDay} of ${projectId}: ${dayRows.length} msgs → ${chunks.length} summary(ies)`)
  } catch (e) {
    console.error('[memory] compress failed:', e)
  }
}
