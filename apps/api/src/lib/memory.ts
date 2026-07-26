import { and, asc, desc, eq, gt, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { chatSummaries, credentials, documents, files, messages, projectMembers, projects, resourceSecrets, taskComments, taskGroups, tasks, users } from '../db/schema.js'
import { hasPermission } from '../routes/projects.js'
import { snapshot } from '../routes/documents.js'
import { htmlToText } from './sanitize-html.js'
import { encrypt } from './crypto.js'
import { notify, extractMentions } from './notify.js'
import { projectLlm, complete, validateTask, type ToolDef, type ToolHandler } from './llm.js'
import { broadcast } from '../ws.js'
import { logActivity } from './audit.js'

// Память ИИ (SPEC §5.6): саммари-цепочка + инструменты + фоновое сжатие.

const TAIL_SIZE = 30 // живой хвост в промпте

// --- Промпт-контекст: оглавление + последнее саммари + живой хвост ----------

/**
 * Ростер команды с должностями и зонами ответственности (SPEC §8.12).
 * Опрокидывается в контекст ИИ, чтобы он знал, кто за что отвечает.
 */
export async function buildTeamContext(projectId: string): Promise<string> {
  const rows = await db
    .select({ name: users.name, email: users.email, jobTitle: projectMembers.jobTitle, responsibility: projectMembers.responsibility, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
  if (!rows.length) return ''
  const lines = rows.map((r) => {
    const who = r.name || r.email
    const bits = [r.jobTitle, r.responsibility && `responsible for: ${r.responsibility}`].filter(Boolean).join('; ')
    return `- ${who} (${r.role})${bits ? ` — ${bits}` : ''}`
  })
  return ['TEAM (who does what — use to route tasks/questions to the right person):', ...lines].join('\n')
}

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
  const team = await buildTeamContext(projectId)
  if (team) parts.push(team, '')
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
      description:
        "Create a task. You can set assignee (by member name or email), due date, time estimate, priority, status and sprint. Requires the author's tasks.create permission.",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
          status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'done'] },
          assignee: { type: 'string', description: 'member name or email to assign; omit for unassigned' },
          dueDate: { type: 'string', description: 'due date, ISO or YYYY-MM-DD' },
          estimateMinutes: { type: 'number', description: 'REQUIRED: time estimate in minutes assuming the person works WITH an AI assistant (realistic, usually shorter)' },
          sprint: { type: 'string', description: 'sprint/group name (created if missing is NOT done — use an existing one)' },
        },
        required: ['title'],
      },
    },
    {
      name: 'update_task',
      description:
        'Update a task by number: title/description/priority/status/assignee/due date/estimate/sprint. Only pass fields to change. Requires tasks.edit (status-only change needs tasks.changeStatus).',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
          status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'done'] },
          assignee: { type: 'string', description: 'member name/email, or "none" to unassign' },
          dueDate: { type: 'string', description: 'ISO or YYYY-MM-DD, or "none" to clear' },
          estimateMinutes: { type: 'number' },
          sprint: { type: 'string', description: 'existing sprint name, or "none" to remove' },
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
    // --- Пакетные операции: одна задача за вызов упирается в лимит шагов ---
    {
      name: 'create_tasks',
      description:
        'Create SEVERAL tasks in one call (max 50). Prefer this over calling create_task repeatedly. Each item takes the same fields as create_task. Requires tasks.create. ALWAYS set estimateMinutes on each item.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: 'Tasks to create',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
                status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'done'] },
                assignee: { type: 'string' },
                dueDate: { type: 'string' },
                estimateMinutes: { type: 'number' },
                sprint: { type: 'string' },
              },
              required: ['title'],
            },
          },
        },
        required: ['tasks'],
      },
    },
    {
      name: 'update_tasks',
      description:
        'Update SEVERAL tasks in one call (max 50). Either pass explicit numbers, or a filter to select them. The same changes apply to every selected task. Requires tasks.edit (status-only needs tasks.changeStatus). DESTRUCTIVE-ish: list the affected task numbers to the user and get explicit confirmation BEFORE calling this.',
      parameters: {
        type: 'object',
        properties: {
          numbers: { type: 'array', items: { type: 'string' }, description: 'Task numbers, e.g. ["TASK-1","TASK-2"]' },
          filter: {
            type: 'object',
            description: 'Alternative to numbers: select tasks by criteria',
            properties: {
              status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'done'] },
              assignee: { type: 'string', description: 'member name/email, or "me" for the author' },
              sprint: { type: 'string', description: 'sprint name' },
            },
          },
          changes: {
            type: 'object',
            description: 'What to set on every selected task',
            properties: {
              status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'done'] },
              priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
              assignee: { type: 'string', description: 'member name/email, or "none" to unassign' },
              dueDate: { type: 'string', description: 'ISO or YYYY-MM-DD, or "none" to clear' },
              estimateMinutes: { type: 'number' },
              sprint: { type: 'string', description: 'sprint name, or "none" to remove' },
            },
          },
        },
        required: ['changes'],
      },
    },
    {
      name: 'delete_tasks',
      description:
        'Delete SEVERAL tasks in one call (max 50, soft-delete, recoverable for 7 days). Requires tasks.delete. DESTRUCTIVE: you MUST list the exact task numbers to the user and receive explicit confirmation before calling this.',
      parameters: {
        type: 'object',
        properties: {
          numbers: { type: 'array', items: { type: 'string' } },
          filter: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'done'] },
              assignee: { type: 'string' },
              sprint: { type: 'string' },
            },
          },
        },
      },
    },
    // --- Ресурсы (SPEC §8.1) --- значения секретов НИКОГДА не читаются ИИ
    {
      name: 'list_resources',
      description: 'List project resources (name, id, url, description, secret count). Secret VALUES are never returned. Requires resources.read.',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
    {
      name: 'create_resource',
      description:
        'Save a resource (a link + description, optionally with named secrets like passwords/API keys shared in chat). Use when someone shares credentials or a useful link. Secrets are stored ENCRYPTED and can never be read back by the AI. Requires resources.manage.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          url: { type: 'string' },
          description: { type: 'string' },
          secrets: {
            type: 'array',
            description: 'named secret values to store encrypted',
            items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } }, required: ['value'] },
          },
          fromMessageId: { type: 'string', description: 'id of the chat message this came from (marks it "from chat")' },
        },
        required: ['name'],
      },
    },
    {
      name: 'update_resource',
      description: 'Update a resource (by id) — name / url / description. Requires resources.manage.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' }, url: { type: 'string' }, description: { type: 'string' } },
        required: ['id'],
      },
    },
    {
      name: 'add_resource_secret',
      description: 'Add a named secret (password/API key) to an existing resource (by id). Stored ENCRYPTED, never readable back. Requires resources.manage.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, label: { type: 'string' }, value: { type: 'string' } },
        required: ['id', 'value'],
      },
    },
    {
      name: 'delete_resource',
      description: 'Delete a resource and its secrets (by id). Requires resources.manage.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    // --- Спринты, ревью, заметки, файлы ---
    {
      name: 'create_sprint',
      description: 'Create a sprint/group (name, optional hex color). Requires tasks.edit. Then use update_task to move tasks into it.',
      parameters: { type: 'object', properties: { name: { type: 'string' }, color: { type: 'string', description: 'hex like #64748b' } }, required: ['name'] },
    },
    {
      name: 'review_task',
      description: 'AI-review a task (by number): is the title/description clear, specific, feasible? Returns advice. Read-only, changes nothing.',
      parameters: { type: 'object', properties: { number: { type: 'string' } }, required: ['number'] },
    },
    {
      name: 'delete_file',
      description: 'Delete a project file by id. Chat/task-linked files become "file deleted" (link kept). Requires files.delete.',
      parameters: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] },
    },
    // --- Комментарии к задачам (SPEC §8.9) — от лица пользователя ---
    {
      name: 'add_task_comment',
      description:
        'Add a comment to a task (by number) ON BEHALF OF THE USER. Use when the user wants to record a note/update on a task rather than post to chat. Requires tasks.read.',
      parameters: {
        type: 'object',
        properties: { number: { type: 'string' }, body: { type: 'string' } },
        required: ['number', 'body'],
      },
    },
    {
      name: 'list_task_comments',
      description: 'Read the comments on a task (by number) — author, time, text. Requires tasks.read.',
      parameters: { type: 'object', properties: { number: { type: 'string' } }, required: ['number'] },
    },
    {
      name: 'attach_file_to_task',
      description:
        'Attach an existing project file (by id, e.g. one shared in chat) to a task (by number). The file then appears in the task Files section. Requires files.upload + tasks.edit.',
      parameters: { type: 'object', properties: { fileId: { type: 'string' }, number: { type: 'string' } }, required: ['fileId', 'number'] },
    },
    {
      name: 'list_sprints',
      description: 'List the project sprints/groups (name + how many tasks). Use to know valid sprint names before assigning a task to one.',
      parameters: { type: 'object', properties: {} },
    },
    // --- Документы (SPEC §8.24) ---
    {
      name: 'list_documents',
      description: 'List project documents (id, title, size in characters, updated). Optionally filter by title.',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
    {
      name: 'read_document',
      description:
        'Read a document by id. Returns plain text by default — use format="html" only when you need the exact markup to edit it. LONG DOCUMENTS ARE READ IN CHUNKS: pass offset (characters, default 0) and limit (default 4000, max 8000). The response tells you the total length and whether more remains — call again with a bigger offset to continue.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          offset: { type: 'number', description: 'character offset to start from (default 0)' },
          limit: { type: 'number', description: 'characters to read (default 4000, max 8000)' },
          format: { type: 'string', enum: ['text', 'html'], description: 'text (default) or html when you need the markup' },
        },
        required: ['id'],
      },
    },
    {
      name: 'create_document',
      description:
        'Create a project document. Content is HTML (the editor is rich text): use <h1>/<h2>/<h3>, <p>, <ul>/<ol>/<li>, <strong>, <em>, <blockquote>, <pre><code>, <table>. Do NOT send markdown. Requires documents.write.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' }, content: { type: 'string' } },
        required: ['title'],
      },
    },
    {
      name: 'update_document',
      description:
        'Replace a document title and/or its whole content by id. Content is HTML, not markdown. Requires documents.write. For adding to the end use append_to_document. Destructive — ask the user to confirm first.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } },
        required: ['id'],
      },
    },
    {
      name: 'append_to_document',
      description: 'Append HTML to the END of a document (safe for long docs — no need to resend the whole text). Requires documents.write.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, content: { type: 'string' } }, required: ['id', 'content'] },
    },
    {
      name: 'delete_document',
      description: 'Delete a document by id (recoverable for 7 days). Requires documents.delete.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  ]

  const findTask = (number: string) =>
    db.query.tasks.findFirst({ where: and(eq(tasks.projectId, projectId), eq(tasks.number, number.toUpperCase()), sql`${tasks.deletedAt} is null`) })

  // Потолок пакетной операции: защищает от «закрой все задачи», понятого слишком
  // широко, и не даёт одному вызову переписать весь проект.
  const BATCH_LIMIT = 50

  /**
   * Выбор задач для пакетной операции: по явным номерам или по фильтру.
   * Возвращает ошибку текстом, чтобы ИИ понял причину, а не гадал.
   */
  async function selectTasks(
    args: Record<string, unknown>,
  ): Promise<{ rows: (typeof tasks.$inferSelect)[] } | { error: string }> {
    const numbers = Array.isArray(args.numbers) ? (args.numbers as unknown[]).map((n) => String(n).toUpperCase()) : []
    const filter = (args.filter ?? {}) as Record<string, unknown>
    const hasFilter = Object.keys(filter).length > 0

    if (!numbers.length && !hasFilter) {
      return { error: 'Specify either "numbers" (task numbers) or a "filter". Refusing to touch every task by accident.' }
    }
    if (numbers.length > BATCH_LIMIT) {
      return { error: `Too many tasks: ${numbers.length}. Maximum per call is ${BATCH_LIMIT} — split into several calls.` }
    }

    const conds = [eq(tasks.projectId, projectId), sql`${tasks.deletedAt} is null`]
    if (numbers.length) conds.push(inArray(tasks.number, numbers))
    if (typeof filter.status === 'string' && ['todo', 'in_progress', 'review', 'done'].includes(filter.status)) {
      conds.push(eq(tasks.status, filter.status as 'todo'))
    }
    if (filter.assignee !== undefined) {
      const id = String(filter.assignee).toLowerCase() === 'me' ? actorUserId : await resolveAssignee(filter.assignee)
      conds.push(id ? eq(tasks.assigneeId, id) : sql`${tasks.assigneeId} is null`)
    }
    if (filter.sprint !== undefined) {
      const groupId = await resolveSprint(filter.sprint)
      conds.push(groupId ? eq(tasks.groupId, groupId) : sql`${tasks.groupId} is null`)
    }

    const rows = await db
      .select()
      .from(tasks)
      .where(and(...conds))
      .limit(BATCH_LIMIT + 1)

    if (rows.length > BATCH_LIMIT) {
      return {
        error: `The filter matched more than ${BATCH_LIMIT} tasks. Narrow it down or pass explicit numbers — refusing to change that many at once.`,
      }
    }
    // о ненайденных номерах сообщаем: молча пропустить — значит соврать про результат
    if (numbers.length) {
      const found = new Set(rows.map((r) => r.number))
      const missing = numbers.filter((n) => !found.has(n))
      if (missing.length && !rows.length) return { error: `None of these tasks exist: ${missing.join(', ')}.` }
      if (missing.length) {
        return { rows, ...({ missing } as object) } as { rows: (typeof tasks.$inferSelect)[] }
      }
    }
    return { rows }
  }

  /** Создание одной задачи — общий код для create_task и create_tasks. */
  async function createOneTask(args: Record<string, unknown>): Promise<string> {
    const [{ next, minSort }] = (await db
      .select({
        next: sql<number>`coalesce(max(cast(substring(${tasks.number} from 6) as int)), 0) + 1`,
        minSort: sql<number>`coalesce(min(${tasks.sortOrder}), 0)`,
      })
      .from(tasks)
      .where(eq(tasks.projectId, projectId))) as [{ next: number; minSort: number }]
    const assigneeId = await resolveAssignee(args.assignee)
    const groupId = await resolveSprint(args.sprint)
    const due = parseDue(args.dueDate)
    const [row] = await db
      .insert(tasks)
      .values({
        projectId,
        number: `TASK-${next}`,
        sortOrder: minSort - 1,
        title: String(args.title ?? '').slice(0, 300),
        description: String(args.description ?? '').slice(0, 10_000),
        priority: (['low', 'normal', 'high', 'urgent'].includes(String(args.priority)) ? args.priority : 'normal') as 'normal',
        status: (['todo', 'in_progress', 'review', 'done'].includes(String(args.status)) ? args.status : 'todo') as 'todo',
        assigneeId: assigneeId ?? null,
        groupId: groupId ?? null,
        dueDate: due ?? null,
        estimateMinutes: typeof args.estimateMinutes === 'number' ? String(Math.max(0, Math.round(args.estimateMinutes))) : null,
        createdById: actorUserId,
      })
      .returning()
    await notifyTaskChange(projectId, actorUserId, row!, { assigned: Boolean(assigneeId), mentions: true })
    return row!.number
  }

  // разрешить исполнителя по имени/email → userId (или null для «none»/пусто)
  async function resolveAssignee(name: unknown): Promise<string | null | undefined> {
    if (name === undefined) return undefined // не менять
    const s = String(name).trim().toLowerCase()
    if (!s || s === 'none' || s === 'unassigned') return null
    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, projectId))
    const m = rows.find((r) => r.name.toLowerCase() === s || r.email.toLowerCase() === s) ?? rows.find((r) => r.name.toLowerCase().includes(s))
    return m?.id ?? null
  }
  // разрешить спринт по имени → groupId (или null для «none»)
  async function resolveSprint(name: unknown): Promise<string | null | undefined> {
    if (name === undefined) return undefined
    const s = String(name).trim().toLowerCase()
    if (!s || s === 'none') return null
    const rows = await db.select({ id: taskGroups.id, name: taskGroups.name }).from(taskGroups).where(eq(taskGroups.projectId, projectId))
    return rows.find((r) => r.name.toLowerCase() === s)?.id ?? rows.find((r) => r.name.toLowerCase().includes(s))?.id ?? null
  }
  const parseDue = (v: unknown): Date | null | undefined => {
    if (v === undefined) return undefined
    const s = String(v).trim().toLowerCase()
    if (!s || s === 'none') return null
    const d = new Date(s.length <= 10 ? s + 'T12:00:00' : s)
    return isNaN(d.getTime()) ? undefined : d
  }
  // уведомления по задаче при ИИ-действии (назначение / статус / упоминания)
  async function notifyTaskChange(
    pid: string,
    actorId: string,
    task: typeof tasks.$inferSelect,
    opts: { assigned?: boolean; statusChanged?: boolean; mentions?: boolean },
  ) {
    const actor = await db.query.users.findFirst({ where: eq(users.id, actorId) })
    const actorName = actor?.name || 'Someone'
    const link = `/p/${pid}/tasks/${task.id}`
    if (opts.assigned && task.assigneeId)
      void notify({ projectId: pid, event: 'task_assigned', recipientIds: [task.assigneeId], actorId, actorName, dedupeKey: `task_assigned:${task.id}:${task.assigneeId}`, link, preview: task.title, entityType: 'task', entityId: task.id })
    if (opts.statusChanged && task.assigneeId)
      void notify({ projectId: pid, event: 'task_status', recipientIds: [task.assigneeId], actorId, actorName, dedupeKey: `task_status:${task.id}:${task.status}:${task.assigneeId}`, link, preview: task.title, vars: { ref: task.number, status: task.status }, entityType: 'task', entityId: task.id })
    if (opts.mentions) {
      const mentioned = extractMentions(task.description)
      if (mentioned.length)
        void notify({ projectId: pid, event: 'task_mention', recipientIds: mentioned, actorId, actorName, dedupeKey: `task_mention:${task.id}`, link, preview: task.title, entityType: 'task', entityId: task.id })
    }
  }

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
      // только «настоящие» файлы: не удалённые и не временные (неотправленные вложения)
      const base = and(eq(files.projectId, projectId), sql`${files.deletedAt} is null`, sql`${files.pendingUntil} is null`)
      const rows = await db
        .select({ file: files, uploader: users })
        .from(files)
        .leftJoin(users, eq(users.id, files.uploadedById))
        .where(q ? and(base, ilike(files.name, `%${q}%`)) : base)
        .orderBy(desc(files.createdAt))
        .limit(30)
      if (!rows.length) return 'No files.'
      // ссылки логические: клиент открывает файл по id через таб «Файлы»
      return rows
        .map((r) => `"${r.file.name}" (id=${r.file.id}, ${r.uploader?.name ?? '?'}, ${r.file.createdAt.toISOString().slice(0, 10)})`)
        .join('\n')
    },
    list_tasks: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'tasks.read'))) return 'PERMISSION DENIED: the author cannot read tasks.'
      const status = typeof args.status === 'string' ? args.status : null
      const rows = await db
        .select({ task: tasks, assignee: users })
        .from(tasks)
        .leftJoin(users, eq(users.id, tasks.assigneeId))
        .where(
          status
            ? and(eq(tasks.projectId, projectId), eq(tasks.status, status as 'todo'), sql`${tasks.deletedAt} is null`)
            : and(eq(tasks.projectId, projectId), sql`${tasks.deletedAt} is null`),
        )
        .orderBy(desc(tasks.createdAt))
        .limit(50)
      if (!rows.length) return 'No tasks.'
      return rows
        .map((r) => {
          const est = r.task.estimateMinutes ? ` est ${r.task.estimateMinutes}m` : ''
          const due = r.task.dueDate ? ` due ${r.task.dueDate.toISOString().slice(0, 10)}` : ''
          return `${r.task.number} [${r.task.status}/${r.task.priority}] "${r.task.title}"${r.assignee ? ` → ${r.assignee.name}` : ''}${due}${est}`
        })
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
      if (!String(args.title ?? '').trim()) return 'A title is required.'
      const number = await createOneTask(args)
      broadcast(projectId, 'tasks_changed', {})
      return `Created ${number}: "${String(args.title).slice(0, 80)}".`
    },
    update_task: async (args) => {
      const t = await findTask(String(args.number ?? ''))
      if (!t) return 'Task not found.'
      // смена только статуса допускается по changeStatus; остальное — по edit
      const onlyStatus = Object.keys(args).every((k) => k === 'number' || k === 'status')
      const allowed = onlyStatus
        ? (await hasPermission(projectId, actorUserId, 'tasks.changeStatus')) || (await hasPermission(projectId, actorUserId, 'tasks.edit'))
        : await hasPermission(projectId, actorUserId, 'tasks.edit')
      if (!allowed) return 'PERMISSION DENIED: the author cannot edit this task. Politely refuse.'
      const patch: Record<string, unknown> = {}
      if (typeof args.title === 'string') patch.title = args.title.slice(0, 300)
      if (typeof args.description === 'string') patch.description = args.description.slice(0, 10_000)
      if (['low', 'normal', 'high', 'urgent'].includes(String(args.priority))) patch.priority = args.priority
      if (['todo', 'in_progress', 'review', 'done'].includes(String(args.status))) patch.status = args.status
      const assigneeId = await resolveAssignee(args.assignee)
      if (assigneeId !== undefined) patch.assigneeId = assigneeId
      const groupId = await resolveSprint(args.sprint)
      if (groupId !== undefined) patch.groupId = groupId
      const due = parseDue(args.dueDate)
      if (due !== undefined) patch.dueDate = due
      if (typeof args.estimateMinutes === 'number') patch.estimateMinutes = String(Math.max(0, Math.round(args.estimateMinutes)))
      if (!Object.keys(patch).length) return 'Nothing to update.'
      const [row] = await db.update(tasks).set(patch).where(eq(tasks.id, t.id)).returning()
      await notifyTaskChange(projectId, actorUserId, row!, {
        assigned: assigneeId !== undefined && assigneeId !== t.assigneeId && Boolean(assigneeId),
        statusChanged: patch.status !== undefined && patch.status !== t.status,
        mentions: typeof args.description === 'string' && args.description !== t.description,
      })
      broadcast(projectId, 'tasks_changed', {})
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
      broadcast(projectId, 'tasks_changed', {})
      return `${t.number} → ${status}.`
    },
    delete_task: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'tasks.delete')))
        return 'PERMISSION DENIED: the author does not have the tasks.delete permission. Politely refuse.'
      const t = await findTask(String(args.number ?? ''))
      if (!t) return 'Task not found.'
      // soft-delete (восстановимо 7 дней, SPEC §8.21)
      await db.update(tasks).set({ deletedAt: new Date(), deletedById: actorUserId }).where(eq(tasks.id, t.id))
      void logActivity({ projectId, actorId: actorUserId, action: 'delete', entityType: 'task', entityId: t.id, entityLabel: `${t.number}: ${t.title}` })
      broadcast(projectId, 'tasks_changed', {})
      return `Deleted ${t.number} (recoverable for 7 days).`
    },

    // --- Пакетные операции ---------------------------------------------------
    // Одна задача за вызов быстро упирается в лимит шагов инструментов, и
    // цепочка обрывается на середине с частично применёнными изменениями.

    create_tasks: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'tasks.create')))
        return 'PERMISSION DENIED: the author does not have the tasks.create permission. Politely refuse.'
      const items = Array.isArray(args.tasks) ? (args.tasks as Record<string, unknown>[]) : []
      if (!items.length) return 'No tasks provided.'
      if (items.length > BATCH_LIMIT)
        return `Too many tasks: ${items.length}. Maximum per call is ${BATCH_LIMIT} — split into several calls.`

      const done: string[] = []
      const failed: string[] = []
      for (const item of items) {
        const title = typeof item.title === 'string' ? item.title.trim() : ''
        if (!title) {
          failed.push('(item without a title)')
          continue
        }
        try {
          const created = await createOneTask(item)
          done.push(created)
        } catch (e) {
          failed.push(`${title}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      broadcast(projectId, 'tasks_changed', {})
      // Отчитываемся и об успехах, и о провалах: ИИ должен знать, что именно не прошло
      return [
        done.length ? `Created ${done.length}: ${done.join(', ')}.` : 'Created nothing.',
        failed.length ? `FAILED ${failed.length}: ${failed.join('; ')}` : '',
      ]
        .filter(Boolean)
        .join(' ')
    },

    update_tasks: async (args) => {
      const changes = (args.changes ?? {}) as Record<string, unknown>
      const onlyStatus = Object.keys(changes).length === 1 && changes.status !== undefined
      const allowed = onlyStatus
        ? (await hasPermission(projectId, actorUserId, 'tasks.changeStatus')) ||
          (await hasPermission(projectId, actorUserId, 'tasks.edit'))
        : await hasPermission(projectId, actorUserId, 'tasks.edit')
      if (!allowed) return 'PERMISSION DENIED: the author cannot edit tasks. Politely refuse.'

      const selected = await selectTasks(args)
      if ('error' in selected) return selected.error
      if (!selected.rows.length) return 'No tasks matched — nothing was changed.'

      const patch: Record<string, unknown> = {}
      if (['low', 'normal', 'high', 'urgent'].includes(String(changes.priority))) patch.priority = changes.priority
      if (['todo', 'in_progress', 'review', 'done'].includes(String(changes.status))) patch.status = changes.status
      const assigneeId = await resolveAssignee(changes.assignee)
      if (assigneeId !== undefined) patch.assigneeId = assigneeId
      const groupId = await resolveSprint(changes.sprint)
      if (groupId !== undefined) patch.groupId = groupId
      const due = parseDue(changes.dueDate)
      if (due !== undefined) patch.dueDate = due
      if (typeof changes.estimateMinutes === 'number')
        patch.estimateMinutes = String(Math.max(0, Math.round(changes.estimateMinutes)))
      if (!Object.keys(patch).length) return 'Nothing to update: "changes" had no recognised fields.'

      const updated: string[] = []
      for (const t of selected.rows) {
        const [row] = await db.update(tasks).set(patch).where(eq(tasks.id, t.id)).returning()
        await notifyTaskChange(projectId, actorUserId, row!, {
          assigned: assigneeId !== undefined && assigneeId !== t.assigneeId && Boolean(assigneeId),
          statusChanged: patch.status !== undefined && patch.status !== t.status,
          mentions: false,
        })
        updated.push(t.number)
      }
      broadcast(projectId, 'tasks_changed', {})
      return `Updated ${updated.length} task(s): ${updated.join(', ')}.`
    },

    delete_tasks: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'tasks.delete')))
        return 'PERMISSION DENIED: the author does not have the tasks.delete permission. Politely refuse.'
      const selected = await selectTasks(args)
      if ('error' in selected) return selected.error
      if (!selected.rows.length) return 'No tasks matched — nothing was deleted.'

      const deleted: string[] = []
      for (const t of selected.rows) {
        await db.update(tasks).set({ deletedAt: new Date(), deletedById: actorUserId }).where(eq(tasks.id, t.id))
        void logActivity({
          projectId,
          actorId: actorUserId,
          action: 'delete',
          entityType: 'task',
          entityId: t.id,
          entityLabel: `${t.number}: ${t.title}`,
        })
        deleted.push(t.number)
      }
      broadcast(projectId, 'tasks_changed', {})
      return `Deleted ${deleted.length} task(s): ${deleted.join(', ')} (recoverable for 7 days).`
    },

    // --- Ресурсы ---
    list_resources: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'resources.read')))
        return 'PERMISSION DENIED: the author cannot read resources. Politely refuse.'
      const q = typeof args.query === 'string' ? args.query.trim() : ''
      const rows = await db.query.credentials.findMany({
        where: q
          ? and(eq(credentials.projectId, projectId), ilike(credentials.name, `%${q}%`), sql`${credentials.deletedAt} is null`)
          : and(eq(credentials.projectId, projectId), sql`${credentials.deletedAt} is null`),
      })
      if (!rows.length) return 'No resources.'
      const withCounts = await Promise.all(
        rows.map(async (r) => {
          const [{ n }] = (await db
            .select({ n: sql<number>`count(*)::int` })
            .from(resourceSecrets)
            .where(eq(resourceSecrets.resourceId, r.id))) as [{ n: number }]
          return `"${r.name}" (id=${r.id})${r.url ? ` ${r.url}` : ''}${r.description ? ` — ${r.description}` : ''} [${n} secret(s)]`
        }),
      )
      return withCounts.join('\n')
    },
    create_resource: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'resources.manage')))
        return 'PERMISSION DENIED: the author cannot manage resources. Politely refuse.'
      const name = String(args.name ?? '').slice(0, 200)
      if (!name) return 'Resource name is required.'
      const fromMessageId = typeof args.fromMessageId === 'string' && args.fromMessageId ? args.fromMessageId : null
      const [res] = await db
        .insert(credentials)
        .values({
          projectId,
          name,
          url: typeof args.url === 'string' && args.url ? args.url.slice(0, 2000) : null,
          description: String(args.description ?? '').slice(0, 5000),
          source: fromMessageId ? 'chat' : 'manual',
          messageId: fromMessageId,
          createdById: actorUserId,
        })
        .returning()
      let secretCount = 0
      if (Array.isArray(args.secrets)) {
        for (const s of args.secrets as { label?: string; value?: string }[]) {
          if (!s || typeof s.value !== 'string' || !s.value) continue
          await db.insert(resourceSecrets).values({ resourceId: res!.id, label: String(s.label ?? '').slice(0, 120), valueEncrypted: encrypt(s.value) })
          secretCount++
        }
      }
      return `Saved resource "${res!.name}"${secretCount ? ` with ${secretCount} secret(s) (stored encrypted)` : ''}.`
    },
    update_resource: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'resources.manage')))
        return 'PERMISSION DENIED: the author cannot manage resources.'
      const res = await db.query.credentials.findFirst({ where: and(eq(credentials.id, String(args.id ?? '')), eq(credentials.projectId, projectId)) })
      if (!res) return 'Resource not found.'
      const patch: Record<string, unknown> = {}
      if (typeof args.name === 'string') patch.name = args.name.slice(0, 200)
      if (typeof args.url === 'string') patch.url = args.url.slice(0, 2000) || null
      if (typeof args.description === 'string') patch.description = args.description.slice(0, 5000)
      if (!Object.keys(patch).length) return 'Nothing to update.'
      await db.update(credentials).set(patch).where(eq(credentials.id, res.id))
      return `Updated resource "${res.name}".`
    },
    add_resource_secret: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'resources.manage')))
        return 'PERMISSION DENIED: the author cannot manage resources.'
      const res = await db.query.credentials.findFirst({ where: and(eq(credentials.id, String(args.id ?? '')), eq(credentials.projectId, projectId)) })
      if (!res) return 'Resource not found.'
      const value = String(args.value ?? '')
      if (!value) return 'Secret value is required.'
      await db.insert(resourceSecrets).values({ resourceId: res.id, label: String(args.label ?? '').slice(0, 120), valueEncrypted: encrypt(value) })
      return `Added a secret to "${res.name}" (stored encrypted).`
    },
    delete_resource: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'resources.manage')))
        return 'PERMISSION DENIED: the author cannot manage resources.'
      const res = await db.query.credentials.findFirst({ where: and(eq(credentials.id, String(args.id ?? '')), eq(credentials.projectId, projectId)) })
      if (!res) return 'Resource not found.'
      await db.update(credentials).set({ deletedAt: new Date(), deletedById: actorUserId }).where(eq(credentials.id, res.id))
      void logActivity({ projectId, actorId: actorUserId, action: 'delete', entityType: 'resource', entityId: res.id, entityLabel: res.name })
      return `Deleted resource "${res.name}" (recoverable for 7 days).`
    },
    create_sprint: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'tasks.edit'))) return 'PERMISSION DENIED: creating sprints requires tasks.edit.'
      const name = String(args.name ?? '').slice(0, 120)
      if (!name) return 'Sprint name is required.'
      const color = /^#[0-9a-fA-F]{6}$/.test(String(args.color)) ? String(args.color) : '#64748b'
      const [{ minSort }] = (await db.select({ minSort: sql<number>`coalesce(min(${taskGroups.sortOrder}), 0)` }).from(taskGroups).where(eq(taskGroups.projectId, projectId))) as [{ minSort: number }]
      await db.insert(taskGroups).values({ projectId, name, color, sortOrder: minSort - 1, createdById: actorUserId })
      broadcast(projectId, 'tasks_changed', {})
      return `Created sprint "${name}".`
    },
    review_task: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'tasks.read'))) return 'PERMISSION DENIED: the author cannot read tasks.'
      const t = await findTask(String(args.number ?? ''))
      if (!t) return 'Task not found.'
      const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
      const language = (JSON.parse(project?.aiConfig || '{}') as { language?: string }).language ?? 'en'
      const r = await validateTask(projectId, { title: t.title, description: t.description, language })
      if (!r) return 'AI review unavailable.'
      return `Review of ${t.number}:\n${r.advice}`
    },
    delete_file: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'files.delete'))) return 'PERMISSION DENIED: deleting files requires files.delete.'
      const file = await db.query.files.findFirst({ where: and(eq(files.id, String(args.fileId ?? '')), eq(files.projectId, projectId)) })
      if (!file) return 'File not found.'
      // как в UI: файлы из чата/задачи — soft-delete (ссылка «файл удалён»), прочие — физически
      if (file.messageId || file.taskId) await db.update(files).set({ deletedAt: new Date() }).where(eq(files.id, file.id))
      else await db.delete(files).where(eq(files.id, file.id))
      return `Deleted "${file.name}".`
    },

    // --- Комментарии задач (от лица пользователя) ---
    add_task_comment: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'tasks.read')))
        return 'PERMISSION DENIED: the author cannot access tasks. Politely refuse.'
      const t = await findTask(String(args.number ?? ''))
      if (!t) return 'Task not found.'
      const body = String(args.body ?? '').slice(0, 10_000)
      if (!body) return 'Comment body is required.'
      const [row] = await db.insert(taskComments).values({ taskId: t.id, projectId, authorId: actorUserId, body }).returning()
      // уведомления о упоминаниях/комментарии
      const actor = await db.query.users.findFirst({ where: eq(users.id, actorUserId) })
      const link = `/p/${projectId}/tasks/${t.id}`
      const mentioned = extractMentions(body)
      if (mentioned.length)
        void notify({ projectId, event: 'comment_mention', recipientIds: mentioned, actorId: actorUserId, actorName: actor?.name || 'Someone', dedupeKey: `comment_mention:${row!.id}`, link, preview: body, entityType: 'task', entityId: t.id })
      const watchers = [t.assigneeId, t.createdById].filter((x): x is string => Boolean(x) && x !== actorUserId && !mentioned.includes(x!))
      if (watchers.length)
        void notify({ projectId, event: 'task_comment', recipientIds: watchers, actorId: actorUserId, actorName: actor?.name || 'Someone', dedupeKey: `task_comment:${row!.id}`, link, preview: body, vars: { ref: t.number }, entityType: 'task', entityId: t.id })
      broadcast(projectId, 'task_comments_changed', { taskId: t.id })
      return `Added a comment to ${t.number}.`
    },
    attach_file_to_task: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'files.upload')) || !(await hasPermission(projectId, actorUserId, 'tasks.edit')))
        return 'PERMISSION DENIED: attaching a file to a task requires files.upload and tasks.edit. Politely refuse.'
      const fileId = String(args.fileId ?? '')
      const t = await findTask(String(args.number ?? ''))
      if (!t) return 'Task not found.'
      const file = await db.query.files.findFirst({ where: and(eq(files.id, fileId), eq(files.projectId, projectId)) })
      if (!file) return 'File not found.'
      await db.update(files).set({ taskId: t.id, pendingUntil: null }).where(eq(files.id, fileId))
      return `Attached "${file.name}" to ${t.number}.`
    },
    list_task_comments: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'tasks.read')))
        return 'PERMISSION DENIED: the author cannot read tasks. Politely refuse.'
      const t = await findTask(String(args.number ?? ''))
      if (!t) return 'Task not found.'
      const rows = await db
        .select({ c: taskComments, author: users })
        .from(taskComments)
        .leftJoin(users, eq(users.id, taskComments.authorId))
        .where(and(eq(taskComments.taskId, t.id), eq(taskComments.projectId, projectId)))
        .orderBy(asc(taskComments.createdAt))
        .limit(50)
      if (!rows.length) return `${t.number} has no comments.`
      return rows
        .map((r) => `[${r.c.createdAt.toISOString().slice(0, 16)}] ${r.author?.name ?? 'AI'}: ${r.c.body.replace(/@\[([^\]]*)\]\([^)]+\)/g, '@$1').slice(0, 400)}`)
        .join('\n')
    },
    // --- Документы (SPEC §8.24) ---
    list_documents: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'documents.read'))) return 'PERMISSION DENIED: the author cannot read documents.'
      const q = typeof args.query === 'string' ? args.query.trim() : ''
      const base = and(eq(documents.projectId, projectId), sql`${documents.deletedAt} is null`)
      const rows = await db
        .select()
        .from(documents)
        .where(q ? and(base, ilike(documents.title, `%${q}%`)) : base)
        .orderBy(desc(documents.updatedAt))
        .limit(50)
      if (!rows.length) return 'No documents.'
      return rows
        .map((d) => {
          const text = htmlToText(d.content)
          const preview = text.slice(0, 120)
          return `"${d.title || '—'}" (id=${d.id}, ${text.length} chars, updated ${d.updatedAt.toISOString().slice(0, 10)})${preview ? ` — ${preview}${text.length > 120 ? '…' : ''}` : ''}`
        })
        .join('\n')
    },
    read_document: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'documents.read'))) return 'PERMISSION DENIED: the author cannot read documents.'
      const d = await db.query.documents.findFirst({
        where: and(eq(documents.id, String(args.id ?? '')), eq(documents.projectId, projectId), sql`${documents.deletedAt} is null`),
      })
      if (!d) return 'Document not found.'
      // По умолчанию отдаём простой текст: резать HTML по символам нельзя —
      // чанк оборвётся посреди тега. HTML нужен только для точечного редактирования.
      const asHtml = args.format === 'html'
      const body = asHtml ? d.content : htmlToText(d.content)
      const total = body.length
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0))
      const limit = Math.min(8000, Math.max(200, Math.floor(Number(args.limit) || 4000)))
      const chunk = body.slice(offset, offset + limit)
      const end = offset + chunk.length
      const more = end < total
      return [
        `"${d.title || '—'}" [${asHtml ? 'HTML' : 'text'}] — characters ${offset}..${end} of ${total}${more ? ` (MORE REMAINS: call read_document again with offset=${end})` : ' (end of document)'}`,
        '',
        chunk,
      ].join('\n')
    },
    create_document: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'documents.write'))) return 'PERMISSION DENIED: the author cannot write documents.'
      const title = String(args.title ?? '').slice(0, 300)
      if (!title) return 'Title is required.'
      const [row] = await db
        .insert(documents)
        .values({ projectId, title, content: String(args.content ?? '').slice(0, 500_000), createdById: actorUserId, updatedById: actorUserId })
        .returning()
      void logActivity({ projectId, actorId: actorUserId, action: 'create', entityType: 'document', entityId: row!.id, entityLabel: title })
      broadcast(projectId, 'documents_changed', {})
      return `Created document "${title}" (id=${row!.id}).`
    },
    update_document: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'documents.write'))) return 'PERMISSION DENIED: the author cannot write documents.'
      const d = await db.query.documents.findFirst({ where: and(eq(documents.id, String(args.id ?? '')), eq(documents.projectId, projectId)) })
      if (!d) return 'Document not found.'
      const patch: Record<string, unknown> = { updatedById: actorUserId }
      if (typeof args.title === 'string') patch.title = args.title.slice(0, 300)
      if (typeof args.content === 'string') patch.content = args.content.slice(0, 500_000)
      if (Object.keys(patch).length === 1) return 'Nothing to update.'
      // правку ИИ обязательно версионируем: перезапись всего документа должна быть обратима
      await snapshot(d.id, d.title, d.content, actorUserId, 'before AI edit').catch(() => {})
      await db.update(documents).set(patch).where(eq(documents.id, d.id))
      void logActivity({ projectId, actorId: actorUserId, action: 'update', entityType: 'document', entityId: d.id, entityLabel: d.title || '—' })
      broadcast(projectId, 'documents_changed', { id: d.id })
      return `Updated document "${d.title || '—'}".`
    },
    append_to_document: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'documents.write'))) return 'PERMISSION DENIED: the author cannot write documents.'
      const d = await db.query.documents.findFirst({ where: and(eq(documents.id, String(args.id ?? '')), eq(documents.projectId, projectId)) })
      if (!d) return 'Document not found.'
      const add = String(args.content ?? '')
      if (!add) return 'Nothing to append.'
      const next = `${d.content}${add}`.slice(0, 500_000)
      await snapshot(d.id, d.title, d.content, actorUserId, 'before AI append').catch(() => {})
      await db.update(documents).set({ content: next, updatedById: actorUserId }).where(eq(documents.id, d.id))
      void logActivity({ projectId, actorId: actorUserId, action: 'update', entityType: 'document', entityId: d.id, entityLabel: d.title || '—' })
      broadcast(projectId, 'documents_changed', { id: d.id })
      return `Appended ${add.length} chars to "${d.title || '—'}".`
    },
    delete_document: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'documents.delete'))) return 'PERMISSION DENIED: the author cannot delete documents.'
      const d = await db.query.documents.findFirst({ where: and(eq(documents.id, String(args.id ?? '')), eq(documents.projectId, projectId)) })
      if (!d) return 'Document not found.'
      await db.update(documents).set({ deletedAt: new Date(), deletedById: actorUserId }).where(eq(documents.id, d.id))
      void logActivity({ projectId, actorId: actorUserId, action: 'delete', entityType: 'document', entityId: d.id, entityLabel: d.title || '—' })
      broadcast(projectId, 'documents_changed', {})
      return `Deleted document "${d.title || '—'}" (recoverable for 7 days).`
    },
    list_sprints: async () => {
      if (!(await hasPermission(projectId, actorUserId, 'tasks.read')))
        return 'PERMISSION DENIED: the author cannot read tasks. Politely refuse.'
      const rows = await db
        .select({
          name: taskGroups.name,
          count: sql<number>`(select count(*)::int from ${tasks} where ${tasks.groupId} = ${taskGroups.id})`,
        })
        .from(taskGroups)
        .where(eq(taskGroups.projectId, projectId))
        .orderBy(asc(taskGroups.sortOrder))
      if (!rows.length) return 'No sprints.'
      return rows.map((r) => `"${r.name}" (${r.count} tasks)`).join('\n')
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
    const cfg = await projectLlm(projectId, 'summary')
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
