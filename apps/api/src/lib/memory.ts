import { and, asc, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { companyOf, projectPath } from './links.js'
import { shortUrlFor } from './short-links.js'
import { profilesForProject } from './job-title.js'
import { db } from '../db/client.js'
import { chatSummaries, credentials, documents, files, messages, notes, projectMembers, projects, resourceSecrets, taskComments, taskGroups, taskBlockers, taskResources, dbConnections, dbTablePolicies, tasks, timeEntries, users, companies } from '../db/schema.js'
import { dependentsOf } from '../routes/tasks.js'
import { readFromConnection } from '../routes/db-connections.js'
import { hasPermission, companyRoleOf } from '../routes/projects.js'
import { snapshot } from '../routes/documents.js'
import { htmlToText, sanitizeHtml } from './sanitize-html.js'
import { searchInDocument, searchInText } from './doc-search.js'
import { submitAssistantReport, REPORT_KINDS, type ReportKind } from './assistant-report.js'
import { createNote, noteToTask, NOTE_TYPES } from '../routes/notes.js'
import { enqueue as enqueueEmbedding, searchNoteIds, searchTaskIds } from './embeddings.js'
import { announce } from './announce.js'
import { canUseKnowledge } from '../routes/notes.js'
import { richText } from './markdown.js'
import { timeConfigForProject } from '../routes/time.js'
import { encrypt } from './crypto.js'
import { notify, extractMentions, commentWatchers } from './notify.js'
import { setDue } from './notify-config.js'
import { projectLlm, complete, validateTask, type ToolDef, type ToolHandler } from './llm.js'
import { broadcast, tasksChanged } from '../ws.js'
import { visionEnabled, SUPPORTED, MAX_BYTES } from './vision.js'
import { getObjectStream, resolveStorage } from './s3.js'
import { env } from '../env.js'
import { logActivity } from './audit.js'
import { CHATICK_HELP } from './chatick-help.js'
import { sendToUser } from '../ws.js'

// Память ИИ (SPEC §5.6): саммари-цепочка + инструменты + фоновое сжатие.

const TAIL_SIZE = 30 // живой хвост в промпте

// --- Промпт-контекст: оглавление + последнее саммари + живой хвост ----------

/**
 * Ростер команды с должностями и зонами ответственности (SPEC §8.12).
 * Опрокидывается в контекст ИИ, чтобы он знал, кто за что отвечает.
 */
export async function buildTeamContext(projectId: string): Promise<string> {
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, locale: users.locale, jobTitle: projectMembers.jobTitle, responsibility: projectMembers.responsibility, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
  if (!rows.length) return ''
  // Должность может быть задана у компании: проект наследует её, пока не
  // написал своё. Ассистенту нужен ответ «кто этот человек», а не то,
  // откуда значение взялось.
  const profiles = await profilesForProject(projectId)
  const lines = rows.map((r) => {
    const who = r.name || r.email
    const p = profiles.get(r.id) ?? { jobTitle: r.jobTitle, responsibility: r.responsibility }
    const bits = [p.jobTitle, p.responsibility && `responsible for: ${p.responsibility}`].filter(Boolean).join('; ')
    // id и язык — чтобы ИИ мог собрать упоминание @[Имя](id) и понять, на каком
    // языке человек читает. Без id упоминание не станет ссылкой и не создаст
    // уведомление: адресат просто не узнает, что обращались к нему.
    return `- ${who} (${r.role}, id=${r.id}, reads ${LANG_NAMES[r.locale] ?? r.locale})${bits ? ` — ${bits}` : ''}`
  })
  return [
    'TEAM (who does what — use to route tasks/questions to the right person):',
    ...lines,
    'To address someone in chat write @[Name](id) with their id from this list — that is what notifies them.',
  ].join('\n')
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
  // Оглавление документов и журнала.
  //
  // Про историю чата ассистент видит оглавление и знает, что за ним можно
  // сходить. Про документы и заметки он не знал НИЧЕГО, пока не спросит, — а
  // наугад модель не спрашивает. Выходило так: на «как мы решили делать
  // авторизацию» он искал по чату, где оглавление перед глазами, и отвечал по
  // нему, не открыв документ, где ответ записан. Молча — ошибки не возникает,
  // просто ответ хуже, чем мог быть.
  //
  // Только заголовки и размеры, без содержимого: спецификация на 32 тысячи
  // символов в каждом запросе — это и дорого, и бесполезно. Дальше он сам
  // решит, стоит ли открывать.
  const index = await buildIndexContext(projectId)
  if (index) parts.push('', index)

  parts.push(
    '',
    'RECENT MESSAGES:',
    ...tail.reverse().map((r) => `${r.author?.name ?? 'AI'}: ${r.msg.text}`),
  )
  return parts.join('\n')
}

/** Сколько строк показываем: в проекте на сто документов оглавление само стало бы стеной текста. */
const INDEX_LIMIT = 12

async function buildIndexContext(projectId: string): Promise<string> {
  const [docs, journal] = await Promise.all([
    db
      // Длину считаем в SQL, а не тянем содержимое ради length: оглавление
      // собирается на КАЖДОЕ сообщение, и возить двенадцать документов по
      // тридцать тысяч символов за раз — дорого и незачем. Число получается
      // по HTML, а не по тексту, — для «большой или маленький» разницы нет.
      .select({ id: documents.id, title: documents.title, chars: sql<number>`length(${documents.content})`, updatedAt: documents.updatedAt })
      .from(documents)
      .where(and(eq(documents.projectId, projectId), isNull(documents.deletedAt)))
      .orderBy(desc(documents.updatedAt))
      .limit(INDEX_LIMIT + 1),
    db
      .select({ id: notes.id, title: notes.title, type: notes.type, createdAt: notes.createdAt })
      .from(notes)
      .where(and(eq(notes.projectId, projectId), isNull(notes.deletedAt)))
      .orderBy(desc(notes.createdAt))
      .limit(INDEX_LIMIT + 1),
  ])

  const parts: string[] = []

  if (docs.length) {
    const shown = docs.slice(0, INDEX_LIMIT)
    parts.push(
      'DOCUMENTS in this project (read_document to open; read_document query="…" finds a passage without reading it through):',
      ...shown.map(
        (d) => `- [${d.id}] "${d.title || '—'}" (~${d.chars} chars, updated ${d.updatedAt.toISOString().slice(0, 10)})`,
      ),
      // Обрезали — говорим вслух: молча показанные двенадцать из тридцати
      // читаются как «это всё, что есть».
      ...(docs.length > INDEX_LIMIT ? [`  …and older ones — list_documents query="…" searches titles AND text.`] : []),
    )
  }

  if (journal.length) {
    const shown = journal.slice(0, INDEX_LIMIT)
    if (parts.length) parts.push('')
    parts.push(
      'KNOWLEDGE BASE — solutions, requirements, traps the team already learned (read_note to open; list_notes searches the whole company, including other projects):',
      ...shown.map((n) => `- [${n.id}] ${n.type} "${n.title || '—'}" (${n.createdAt.toISOString().slice(0, 10)})`),
      ...(journal.length > INDEX_LIMIT ? ['  …and older ones — list_notes query="…" searches all of them.'] : []),
    )
  }

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
      description: 'Full-text search across the ENTIRE raw GROUP chat history. Use for facts not in summaries.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    {
      name: 'search_my_dialog',
      description:
        'Search THIS user\'s own past conversation with you (not the group chat). Only recent turns are included in the prompt, so use this when they refer to something discussed earlier — a decision, a name, a number — instead of guessing or saying you do not remember.',
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
      parameters: { type: 'object', properties: { status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'verified', 'done'] } } },
    },
    {
      name: 'announce',
      description:
        'Tell the company something that is NOT about a task: "we are off tomorrow", "the policy changed", "the server moves on Saturday". Reaches everyone in the company by default; pass project to narrow it to this project team, or users to name people. ASK THE HUMAN BEFORE SENDING — it interrupts everybody and cannot be turned off by those receiving it. email: true also sends mail, for things that cannot wait until they open the app. Company admin only.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'One line saying what happened' },
          body: { type: 'string', description: 'Details, if a line is not enough' },
          project: { type: 'boolean', description: 'true = only this project team, not the whole company' },
          users: { type: 'array', items: { type: 'string' }, description: 'Named people instead of everyone' },
          email: { type: 'boolean', description: 'Also send mail' },
        },
        required: ['title'],
      },
    },
    {
      name: 'search_tasks',
      description:
        'Find a task ACROSS EVERY PROJECT this person is in, by MEANING rather than words: "payment fails" finds a Hebrew task about a broken payment iframe with no shared word. Comments are indexed together with their task, so "where did we discuss X", "which task was that in", "I wrote about it somewhere" land on the task holding the discussion — that is what this is for. Use list_tasks for the current project; use this when the project is exactly what they are trying to remember.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Ask in plain words — do not guess the exact wording' },
          allProjects: { type: 'boolean', description: 'Default true; false narrows to the current project' },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_task',
      description:
        'Get one task with full description by its number (e.g. TASK-5). The reply includes a short link ' +
        '(chatick.com/t-AbC12) — give the human that one when they ask where the task is, never a link you built yourself.',
      parameters: { type: 'object', properties: { number: { type: 'string' } }, required: ['number'] },
    },
    {
      name: 'about_chatick',
      description:
        'What Chatick itself can do — tabs, roles, permissions, the two chats, connecting an assistant. ' +
        'Call it when someone asks how to do something IN the product ("where do I set a due date", "how ' +
        'do I invite a person", "what are resources for") instead of guessing or saying you do not know. ' +
        'Not needed for questions about their work — only about the tool.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'open_in_ui',
      description:
        'Switch the working area on the screen of the person you are talking to: open a task, a document, a ' +
        'file, a note, or a whole tab. Their chat stays where it is — only the panel next to it changes. ' +
        'Use it when they are about to look at the thing anyway ("here is the task" — open it), not to steer ' +
        'them around. One place at a time: a screen that keeps jumping is worse than no help at all. ' +
        'Nothing happens if the app is closed, and that is fine — the reply says so.',
      parameters: {
        type: 'object',
        properties: {
          what: {
            type: 'string',
            enum: ['task', 'document', 'note', 'file', 'resource', 'tab'],
            description: 'What kind of thing to open',
          },
          id: {
            type: 'string',
            description:
              'Id or number of the thing (TASK-5 works for tasks). Omit for "tab" — pass tab instead.',
          },
          tab: {
            type: 'string',
            enum: ['tasks', 'files', 'documents', 'notes', 'resources', 'releases', 'time', 'team', 'history'],
            description: 'Which tab to switch to when what="tab"',
          },
        },
        required: ['what'],
      },
    },
    {
      name: 'create_task',
      description:
        "Create a task. You can set assignee (by member name or email), due date, time estimate, priority, status and sprint. " +
        'To pull someone into the description, write @[Their Name](<userId>) — plain "@Name" is text and notifies nobody. ' +
        "The assignee is notified by being assigned; mention others only when they specifically need to see it. " +
        'When the task is about something the user just showed you — a screenshot, a log — pass its id in attachmentIds (get it from list_chat_images): the file lands in the task AND survives, otherwise chat attachments are deleted within a day. ' +
        'The reply carries a short link to the new task — pass it on as is. Requires the author\'s tasks.create permission.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
          status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'verified', 'done'] },
          assignee: { type: 'string', description: 'member name or email to assign; omit for unassigned' },
          dueDate: { type: 'string', description: 'due date, ISO or YYYY-MM-DD' },
          estimateMinutes: { type: 'number', description: 'REQUIRED: time estimate in minutes assuming the person works WITH an AI assistant (realistic, usually shorter)' },
          sprint: { type: 'string', description: 'sprint/group name (created if missing is NOT done — use an existing one)' },
          attachmentIds: {
            type: 'array',
            items: { type: 'string' },
            description:
              'File ids to attach — take them from list_chat_images. Use this when the user shows you something and asks for a task about it: attaching also SAVES the file, which is otherwise deleted within a day.',
          },
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
          status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'verified', 'done'] },
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
        properties: { number: { type: 'string' }, status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'verified', 'done'] } },
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
                status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'verified', 'done'] },
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
              status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'verified', 'done'] },
              assignee: { type: 'string', description: 'member name/email, or "me" for the author' },
              sprint: { type: 'string', description: 'sprint name' },
            },
          },
          changes: {
            type: 'object',
            description: 'What to set on every selected task',
            properties: {
              status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'verified', 'done'] },
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
              status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'verified', 'done'] },
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
        'Add a comment to a task (by number) ON BEHALF OF THE USER. Use when the user wants to record a note/update on a task rather than post to chat. ' +
        'TO ADDRESS SOMEONE, write @[Their Name](<userId>) — take the id from the team context. Plain "@Name" is just text and notifies nobody, so the person never learns you wrote to them. ' +
        'The task author and assignee are notified about any new comment anyway — mention them only when you actually need that specific person to act. Requires tasks.read.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'string' },
          body: { type: 'string', description: 'Comment text. Mentions must be @[Name](userId) to notify.' },
        },
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
    // --- Ресурсы задачи ---
    //
    // Ассистент умел создавать ресурсы, но не мог привязать их к задаче — и
    // на просьбу «дай задаче доступ к стенду» вставлял адрес и пароль прямо
    // в описание. Оттуда их читают все, кто видит задачу, и отозвать это
    // нельзя. Ссылка на ресурс решает, кому раскрыться, сама.
    {
      name: 'link_resource_to_task',
      description:
        'Link an existing project resource (staging URL, SSH key, database — id from list_resources) to a task, by task number. ADDS the link without touching resources already linked. Use this instead of pasting an address or a password into the task description: text in a description is readable by everyone who can see the task and cannot be taken back, while a linked resource keeps deciding for itself who may open it. Requires tasks.edit.',
      parameters: {
        type: 'object',
        properties: { resourceId: { type: 'string' }, number: { type: 'string' } },
        required: ['resourceId', 'number'],
      },
    },
    {
      name: 'unlink_resource_from_task',
      description:
        'Remove one resource link from a task, by task number. Other links stay. The resource itself is not deleted — it keeps existing in the project. Requires tasks.edit.',
      parameters: {
        type: 'object',
        properties: { resourceId: { type: 'string' }, number: { type: 'string' } },
        required: ['resourceId', 'number'],
      },
    },
    {
      name: 'list_task_resources',
      description:
        'What a task needs access to: linked resources with their name and address. Secret VALUES are never returned here — only that the access exists. Use it to answer "what do I need to work on this".',
      parameters: { type: 'object', properties: { number: { type: 'string' } }, required: ['number'] },
    },
    // --- Зависимости задач ---
    //
    // Связи видны в интерфейсе всем, а ассистент про них не знал: на вопрос
    // «что держит проект» он отвечал, что таких данных у него нет. Для ПМ,
    // который сидит в этом же чате, это выглядит как «ИИ поглупел».
    {
      name: 'get_blockers',
      description:
        'What is holding the WHOLE project: tasks that block others, who owns them, and what waits for each. Use for "why is this stuck", "what should we do first", "who is holding us up". Report chains ("TASK-82 blocks five screens, all waiting on Elisha"), not totals.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'get_task_blockers',
      description:
        'For ONE task: what it waits for and what waits for it. openBlockers > 0 means the work cannot start yet.',
      parameters: { type: 'object', properties: { number: { type: 'string' } }, required: ['number'] },
    },
    {
      name: 'link_tasks',
      description:
        'Record that a task waits for others: "payment cannot be built before authentication". blockedBy = the listed tasks must finish first. Loops are rejected — if A already depends on B, you cannot make B wait for A, because neither could ever be finished.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'string', description: 'the task, e.g. TASK-10' },
          blockedBy: { type: 'array', items: { type: 'string' }, description: 'task numbers it must wait for' },
        },
        required: ['number', 'blockedBy'],
      },
    },
    // --- База данных проекта ---
    //
    // Читать можно только таблицы, которые человек открыл галочкой, и только
    // на чтение: запрос идёт в read-only транзакции, СУБД сама отвергает любое
    // изменение. Это чужая боевая база.
    {
      name: 'list_databases',
      description:
        'Databases connected to this project, and which tables you may read. Call this BEFORE querying: anything not listed will be refused.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'query_database',
      description:
        'Run a SELECT against a connected database. Read-only — the database itself rejects any change, do not try to work around it. Only tables from list_databases are allowed. This is production data belonging to a customer: read what the question needs, and do not paste personal data (names, emails, phones) into tasks or messages where it outlives the conversation.',
      parameters: {
        type: 'object',
        properties: {
          databaseId: { type: 'string' },
          sql: { type: 'string', description: 'a SELECT statement' },
          limit: { type: 'number' },
        },
        required: ['databaseId', 'sql'],
      },
    },
    // Файлы, показанные ассистенту, — временные (см. routes/messages.ts).
    // Через сутки их уберёт уборщик. Сохранить в проект — отдельное решение
    // человека, и спросить о нём должен ассистент.
    // Окно «последние полчаса» решает частый случай, но не любой: человек
    // может вернуться к вчерашнему скриншоту. Пусть ассистент сам скажет,
    // какую картинку открыть, — это надёжнее любой эвристики.
    {
      name: 'list_chat_images',
      description:
        'Everything the user has attached in this private chat, newest first — id, file name, type, when it was sent and the message it came with. Not only pictures: logs, PDFs and archives show up here too. Call this when they refer to something they sent ("look at the one I sent earlier"), and ALSO when they ask you to turn an attachment into a task — the id from here is what create_task attachmentIds and attach_file_to_task need.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'how many to list, default 10' } },
      },
    },
    {
      name: 'view_image',
      description:
        'Open a specific image from this chat and LOOK at it. Take the exact file name from list_chat_images. The picture comes back with this call — describe what you actually see, and say plainly if something is unreadable rather than guessing.',
      parameters: {
        type: 'object',
        properties: { fileName: { type: 'string' } },
        required: ['fileName'],
      },
    },
    {
      name: 'keep_attached_file',
      description:
        'Save a file the user showed you into the project permanently. Files attached in this private chat are TEMPORARY — they are deleted within a day unless saved. When the user shows you something worth keeping (a design, a document, a screenshot of a bug), ASK whether to save it; call this only if they say yes. Do not save on your own: most screenshots are shown once and never needed again.',
      parameters: {
        type: 'object',
        properties: { fileName: { type: 'string', description: 'name of the attached file' } },
        required: ['fileName'],
      },
    },
    {
      name: 'discard_attached_file',
      description:
        'Delete a temporary file the user showed you, right now instead of waiting a day. Use when they say "delete it", "I sent the wrong one".',
      parameters: {
        type: 'object',
        properties: { fileName: { type: 'string' } },
        required: ['fileName'],
      },
    },
    {
      name: 'list_sprints',
      description: 'List the project sprints/groups (name + how many tasks). Use to know valid sprint names before assigning a task to one.',
      parameters: { type: 'object', properties: {} },
    },
    // --- Документы (SPEC §8.24) ---
    {
      name: 'start_timer',
      description:
        'Start a time tracker for the user (SPEC §8.32). Use when they say "I am starting on X", "log my time", "note that I began at 9". taskNumber links the entry to a task (ONE task per entry — parallel work means parallel timers). startedAt lets you backdate the start when they only remembered later.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'what they are working on; optional' },
          taskNumber: { type: 'string', description: 'e.g. TASK-12; optional' },
          startedAt: { type: 'string', description: 'ISO timestamp; defaults to now' },
        },
      },
    },
    {
      name: 'stop_timer',
      description: 'Stop the user\'s running timer. If several are running, pass the id from list_timers.',
      parameters: { type: 'object', properties: { id: { type: 'string' } } },
    },
    {
      name: 'list_timers',
      description: 'What is running right now for this user, with elapsed minutes and the project limit on parallel timers.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'log_time',
      description:
        'Record time AFTER the fact — they worked but never started a timer. Both ends required. If the end is earlier than the start it is treated as the next day (a shift past midnight).',
      parameters: {
        type: 'object',
        properties: {
          startedAt: { type: 'string', description: 'ISO timestamp' },
          endedAt: { type: 'string', description: 'ISO timestamp' },
          description: { type: 'string' },
          taskNumber: { type: 'string' },
        },
        required: ['startedAt', 'endedAt'],
      },
    },
    {
      name: 'time_report',
      description:
        'Hours for a period, grouped by person, by task and by day. Answers "how much did I work this week", "how much went into TASK-7". A member sees only their own; owner/admin see everyone.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'YYYY-MM-DD' },
          to: { type: 'string', description: 'YYYY-MM-DD' },
        },
      },
    },
    /**
     * Обратная связь о самом Chatick.
     *
     * Ассистент в чате ближе всех к человеку: жалобы и просьбы звучат именно
     * здесь, между делом — «а можно, чтобы…», «неудобно вот это». Инструмента
     * не было вовсе, и всё это оставалось в переписке.
     *
     * Формулировка нарочно приглашающая. У моста и MCP она была
     * оборонительной («не список желаний», «только когда упёрся»), и модель
     * читала её как запрет: просьбу человека под это не подводила и отвечала
     * «такого нет» вместо отправки.
     */
    {
      name: 'send_report',
      description:
        'Send the Chatick team a request, an idea, a complaint or a bug — about CHATICK ITSELF. ' +
        'USE IT WHENEVER SOMEONE WANTS SOMETHING THE PRODUCT DOES NOT DO, or finds something awkward, confusing or broken. ' +
        'A person asking "can it also…" IS a report — do not answer "there is no such thing" and drop it; say you will pass it on, and pass it on. ' +
        'Help them phrase it: ask what exactly is missing and what they were trying to do, then send that. ' +
        'A human reads these — nothing is implemented automatically, so never promise a fix or a date. ' +
        'Send what the PERSON said, not ideas of your own, and never anything about their own project or team — that belongs in tasks and notes.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['request', 'bug', 'missing', 'docs'],
            description:
              'request — someone asked for something Chatick does not have (the most common); bug — it behaves wrong; missing — you needed a tool that does not exist; docs — the instructions are wrong',
          },
          body: {
            type: 'string',
            description: 'What they want or what went wrong, in their words. A sentence or two minimum.',
          },
          context: {
            type: 'string',
            description: 'What they were doing when it came up — without it half the reports cannot be acted on',
          },
        },
        required: ['kind', 'body'],
      },
    },
    {
      name: 'list_notes',
      description:
        'Search the project journal (SPEC §8.31): solutions, problems, decisions, contradictions, mismatches, gaps, reminders, business rules. The query understands MEANING, not just words: "payment fails" finds "Cardcom rejects foreign cards" with no shared word, and it works the same in Hebrew — ask in your own words instead of guessing the exact wording. Filter by type or tag. Searches the WHOLE COMPANY by default — look here BEFORE debugging something that may already have been solved, possibly in another project. scope="project" narrows to the current one.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          type: { type: 'string', description: 'comma separated: solution,problem,decision,contradiction,mismatch,gap,reminder,business,note' },
          tag: { type: 'string', description: 'comma separated tags, AND condition' },
          scope: { type: 'string', enum: ['project', 'company'] },
        },
      },
    },
    {
      name: 'read_note',
      description: 'Read one note in full by id: body, tags, quoted chat messages and who it concerns.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'create_note',
      description:
        'Write something into the project journal, ON BEHALF OF the user. Use when asked to "save this", "remember how we fixed it", "log that this contradicts what was said". Types: solution (a problem AND its fix — the reusable kind, the most valuable), bug (broken, not yet fixed), requirement (a rule to follow), attention (a trap the next person will step into), decision (we chose this over that, and why), business (a company rule), note. Body is HTML like documents, not markdown. Entries belong to the company and are findable from every project — no scope to set. sourceMessageIds quotes chat messages IN THE ORDER THEY WERE SENT — the chain is the evidence; their text is copied, so it survives the messages being deleted. assigneeIds marks who the note concerns; they get notified.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string', description: 'HTML' },
          tags: { type: 'array', items: { type: 'string' } },
          scope: { type: 'string', enum: ['project', 'company'] },
          sourceMessageIds: { type: 'array', items: { type: 'string' } },
          assigneeIds: { type: 'array', items: { type: 'string' }, description: 'user ids the note concerns' },
          remindAt: { type: 'string', description: 'ISO date to resurface the note' },
        },
        required: ['title'],
      },
    },
    {
      name: 'update_note',
      description: 'Update a note by id: any of type, title, body (HTML), tags, scope, remindAt. Requires notes.write.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          scope: { type: 'string', enum: ['project', 'company'] },
          remindAt: { type: 'string' },
        },
        required: ['id'],
      },
    },
    {
      name: 'note_to_task',
      description:
        'Turn a note into a task once the action is clear. The note SURVIVES and keeps a link to the task — it explains why the task exists and its quotes are copied into the task description. Calling it twice returns the same task.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, title: { type: 'string' }, assignee: { type: 'string' } },
        required: ['id'],
      },
    },
    {
      name: 'list_documents',
      description:
        'List project documents (id, title, size in characters, updated). Pass query to search BOTH titles and their text — use it to find which document covers something before reading any of them; the preview then shows the matching passage.',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
    {
      name: 'read_document',
      description:
        'Read a document by id. SEARCH FIRST when you are after something specific: pass query="word" and get back only the matching places with their offsets — a 30k-character spec is 8 sequential reads otherwise. Then read around a hit with offset=<its offset>. Without query it returns the text in CHUNKS: offset (default 0) and limit (default 4000, max 8000); the response says whether more remains. Use format="html" only when you need the exact markup to edit it.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          query: { type: 'string', description: 'find this text inside the document instead of reading it through' },
          context: { type: 'number', description: 'characters of context around each match (default 300)' },
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
    if (typeof filter.status === 'string' && ['todo', 'in_progress', 'review', 'verified', 'done'].includes(filter.status)) {
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

  /**
   * Приложить файлы к задаче — то же, что делает attach_file_to_task, но
   * пачкой и молча пропуская чужое.
   *
   * pendingUntil снимаем обязательно: файл из чата временный и удаляется
   * уборщиком в течение суток (SPEC §8.17). Приложенный к задаче и не
   * сохранённый исчез бы из неё сам, а задача осталась бы со ссылкой в никуда.
   *
   * Берём только СВОИ файлы этого проекта: чат с ассистентом личный, и
   * подставленный чужой id не должен вытащить файл в задачу. Возвращаем имена
   * приложенного, чтобы вызывающий мог сказать, что именно приложилось, —
   * и промолчать о том, чего не нашлось, нельзя.
   */
  async function attachFilesToTask(ids: string[], taskId: string): Promise<string[]> {
    if (!ids.length) return []
    const rows = await db.query.files.findMany({
      where: and(
        inArray(files.id, ids),
        eq(files.projectId, projectId),
        eq(files.uploadedById, actorUserId),
        isNull(files.deletedAt),
      ),
    })
    if (!rows.length) return []
    await db
      .update(files)
      .set({ taskId, pendingUntil: null })
      .where(inArray(files.id, rows.map((r) => r.id)))
    return rows.map((r) => r.name)
  }

  /**
   * Создание одной задачи — общий код для create_task и create_tasks.
   *
   * Возвращает и номер, и id: номер человек читает, а по id собирается ссылка.
   */
  async function createOneTask(args: Record<string, unknown>): Promise<{ number: string; id: string }> {
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
        status: (['todo', 'in_progress', 'review', 'verified', 'done'].includes(String(args.status)) ? args.status : 'todo') as 'todo',
        assigneeId: assigneeId ?? null,
        groupId: groupId ?? null,
        dueDate: due ?? null,
        estimateMinutes: typeof args.estimateMinutes === 'number' ? String(Math.max(0, Math.round(args.estimateMinutes))) : null,
        createdById: actorUserId,
      })
      .returning()
    await notifyTaskChange(projectId, actorUserId, row!, { assigned: Boolean(assigneeId), mentions: true })
    return { number: row!.number, id: row!.id }
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
    const link = projectPath((await companyOf(pid)) ?? '', pid, `/tasks/${task.id}`)
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
        // Только групповой чат. Без фильтра по mode поиск доставал и личные
        // диалоги людей с ассистентом — включая ЧУЖИЕ: инструмент описан как
        // «вся история чата», и подразумевался общий чат, а mode='ai' туда
        // попадал молча. Свою переписку с ассистентом ищет search_my_dialog.
        .where(
          and(
            eq(messages.projectId, projectId),
            eq(messages.mode, 'group'),
            eq(messages.status, 'delivered'),
            ilike(messages.text, `%${q}%`),
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(20)
      if (!rows.length) return 'Nothing found.'
      return rows.map((r) => `[${r.msg.createdAt.toISOString().slice(0, 16)}] ${r.author?.name ?? 'AI'}: ${r.msg.text.slice(0, 300)}`).join('\n')
    },
    /**
     * Поиск по собственному диалогу с ассистентом.
     *
     * В промпт уходит только недавняя часть переписки — остальное человек
     * дотягивает через этот инструмент, вместо того чтобы платить за всю
     * историю в каждом запросе.
     *
     * Строго свой диалог: те же две стороны, что и при его сборке (автор —
     * я, либо ответ адресован мне). Чужие переписки с ассистентом сюда не
     * попадают, даже внутри одного проекта.
     */
    search_my_dialog: async (args) => {
      const q = String(args.query ?? '').trim()
      if (!q) return 'Empty query.'
      if (!actorUserId) return 'Not available.'
      const rows = await db
        .select({ msg: messages })
        .from(messages)
        .where(
          and(
            eq(messages.projectId, projectId),
            eq(messages.mode, 'ai'),
            sql`(${messages.authorId} = ${actorUserId} or ${messages.recipientId} = ${actorUserId})`,
            ilike(messages.text, `%${q}%`),
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(20)
      if (!rows.length) return 'Nothing found in your earlier conversation.'
      return rows
        .map(
          (r) =>
            `[${r.msg.createdAt.toISOString().slice(0, 16)}] ${r.msg.authorId === actorUserId ? 'User' : 'You'}: ${r.msg.text.slice(0, 300)}`,
        )
        .join('\n')
    },
    /**
     * Переключить рабочую зону на экране человека.
     *
     * Ассистент заканчивал словами «вот задача TASK-5», и человек шёл искать её
     * руками — хотя ассистент уже знает, где она. Здесь он открывает её сам.
     *
     * Событие адресное: только тому, с кем идёт разговор, и только в этом
     * проекте. Чужой экран переключать нельзя ни при каких обстоятельствах —
     * это не подсказка, а вмешательство.
     *
     * Открытых вкладок может не быть вовсе: человек говорит с ассистентом из
     * трея или ушёл с сайта. Это не ошибка, и врать «открыл» нельзя — отвечаем
     * честно, чтобы модель не строила следующий шаг на несбывшемся.
     */
    /**
     * Справка о самом продукте.
     *
     * Отдельным инструментом, а не в системном промпте: промпт уходит с каждым
     * сообщением, а спрашивают «как в Chatick сделать X» несколько раз в день.
     * Платить за описание продукта в каждом разговоре о задачах незачем.
     */
    about_chatick: async () => CHATICK_HELP,

    open_in_ui: async (args) => {
      const what = typeof args.what === 'string' ? args.what : ''
      const rawId = typeof args.id === 'string' ? args.id.trim() : ''
      const tab = typeof args.tab === 'string' ? args.tab : ''

      // Путь собираем ЗДЕСЬ, а не доверяем модели: она предложила бы строку,
      // а интерфейс перешёл бы куда угодно внутри приложения.
      let path = ''
      if (what === 'tab') {
        const allowed = ['tasks', 'files', 'documents', 'notes', 'resources', 'releases', 'time', 'team', 'history']
        if (!allowed.includes(tab)) return `Unknown tab: ${tab || '(none)'}. One of: ${allowed.join(', ')}`
        path = tab
      } else if (what === 'task') {
        if (!rawId) return 'Pass the task number or id'
        // Номер вида TASK-5 переводим в id: интерфейс адресует задачи по id,
        // а человек и модель говорят номерами.
        const byNumber = /^[A-Za-z]+-\d+$/.test(rawId)
        const row = byNumber
          ? await db.query.tasks.findFirst({ where: and(eq(tasks.projectId, projectId), eq(tasks.number, rawId.toUpperCase())) })
          : await db.query.tasks.findFirst({ where: and(eq(tasks.projectId, projectId), eq(tasks.id, rawId)) })
        if (!row) return `No task ${rawId} in this project`
        path = `tasks/${row.id}`
      } else {
        const map: Record<string, string> = {
          document: 'documents',
          note: 'notes',
          file: 'files',
          resource: 'resources',
        }
        const seg = map[what]
        if (!seg) return `Unknown target: ${what}`
        if (!rawId) return `Pass the ${what} id`
        path = `${seg}/${rawId}`
      }

      const delivered = sendToUser(projectId, actorUserId, 'open_in_ui', { path })
      return delivered
        ? `Opened ${path} on their screen`
        : 'Nobody is looking at this project right now — nothing was opened. Tell them where to find it instead.'
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
      const link = await shortUrlFor('task', t.id, projectId, actorUserId)
      return `${t.number} [${t.status}/${t.priority}] "${t.title}"${link ? `\n${link}` : ''}\n${t.description || '(no description)'}`
    },
    create_task: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'tasks.create')))
        return 'PERMISSION DENIED: the author does not have the tasks.create permission. Politely refuse.'
      if (!String(args.title ?? '').trim()) return 'A title is required.'
      // Права на вложения проверяем ДО создания задачи: иначе человек получил
      // бы задачу без файла и отказ одной строкой — и не понял, что задача
      // всё-таки завелась.
      const wanted = Array.isArray(args.attachmentIds) ? (args.attachmentIds as unknown[]).map(String) : []
      if (wanted.length && !(await hasPermission(projectId, actorUserId, 'files.upload'))) {
        return 'PERMISSION DENIED: attaching files requires files.upload. Politely refuse — the task was NOT created.'
      }
      const created = await createOneTask(args)
      const attached = await attachFilesToTask(wanted, created.id)
      broadcast(projectId, 'tasks_changed', {})
      if (attached.length) broadcast(projectId, 'files_changed', {})
      // Ссылку отдаём сразу: без неё ассистент на просьбу «дай ссылку»
      // собирает адрес сам и промахивается — такого маршрута нет.
      const link = await shortUrlFor('task', created.id, projectId, actorUserId)
      // Про неприложенное говорим вслух: молчаливая потеря файла выглядит
      // как «приложил», а в задаче его нет.
      const missed = wanted.length - attached.length
      const files_ = attached.length ? ` Attached: ${attached.join(', ')}.` : ''
      const lost = missed > 0 ? ` ${missed} file(s) could not be attached — wrong id, or not yours.` : ''
      return `Created ${created.number}: "${String(args.title).slice(0, 80)}".${files_}${lost}${link ? ` Link: ${link}` : ''}`
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
      if (['todo', 'in_progress', 'review', 'verified', 'done'].includes(String(args.status))) patch.status = args.status
      const assigneeId = await resolveAssignee(args.assignee)
      if (assigneeId !== undefined) patch.assigneeId = assigneeId
      const groupId = await resolveSprint(args.sprint)
      if (groupId !== undefined) patch.groupId = groupId
      const due = parseDue(args.dueDate)
      if (due !== undefined) setDue(patch, due)
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
      if (!['todo', 'in_progress', 'review', 'verified', 'done'].includes(status)) return 'Invalid status.'
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
          // Только номер: ссылка на каждую из полусотни задач — полсотни
          // записей в базе ради того, что никто не просил.
          done.push(created.number)
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
      if (['todo', 'in_progress', 'review', 'verified', 'done'].includes(String(changes.status))) patch.status = changes.status
      const assigneeId = await resolveAssignee(changes.assignee)
      if (assigneeId !== undefined) patch.assigneeId = assigneeId
      const groupId = await resolveSprint(changes.sprint)
      if (groupId !== undefined) patch.groupId = groupId
      const due = parseDue(changes.dueDate)
      if (due !== undefined) setDue(patch, due)
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
      const link = projectPath((await companyOf(projectId)) ?? '', projectId, `/tasks/${t.id}`)
      const mentioned = extractMentions(body)
      if (mentioned.length)
        void notify({ projectId, event: 'comment_mention', recipientIds: mentioned, actorId: actorUserId, actorName: actor?.name || 'Someone', dedupeKey: `comment_mention:${row!.id}`, link, preview: body, entityType: 'task', entityId: t.id })
      // Правило одно на все три пути — см. commentWatchers в notify.ts.
      const watchers = commentWatchers({
        assigneeId: t.assigneeId,
        createdById: t.createdById,
        mentioned,
        actorId: actorUserId,
      })
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
    link_resource_to_task: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'tasks.edit')))
        return 'PERMISSION DENIED: linking a resource to a task requires tasks.edit. Politely refuse.'
      const t = await findTask(String(args.number ?? ''))
      if (!t) return 'Task not found.'
      const resourceId = String(args.resourceId ?? '')
      // Только ресурс этого проекта: чужой показал бы в карточке доступ,
      // которого у человека нет и открыть который он не сможет.
      const res = await db.query.credentials.findFirst({
        where: and(eq(credentials.id, resourceId), eq(credentials.projectId, projectId), isNull(credentials.deletedAt)),
      })
      if (!res) return 'Resource not found in this project.'
      await db.insert(taskResources).values({ taskId: t.id, resourceId }).onConflictDoNothing()
      tasksChanged(projectId, [t.assigneeId, t.createdById])
      return `Linked "${res.name || res.url || resourceId}" to ${t.number}.`
    },
    unlink_resource_from_task: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'tasks.edit')))
        return 'PERMISSION DENIED: unlinking a resource requires tasks.edit. Politely refuse.'
      const t = await findTask(String(args.number ?? ''))
      if (!t) return 'Task not found.'
      const resourceId = String(args.resourceId ?? '')
      const [gone] = await db
        .delete(taskResources)
        .where(and(eq(taskResources.taskId, t.id), eq(taskResources.resourceId, resourceId)))
        .returning()
      if (!gone) return `That resource is not linked to ${t.number}.`
      tasksChanged(projectId, [t.assigneeId, t.createdById])
      return `Unlinked the resource from ${t.number}. The resource itself still exists.`
    },
    list_task_resources: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'tasks.read')))
        return 'PERMISSION DENIED: the author cannot read tasks. Politely refuse.'
      const t = await findTask(String(args.number ?? ''))
      if (!t) return 'Task not found.'
      // Значения секретов НЕ выбираем: попав сюда, пароль осел бы в контексте
      // модели и в истории чата, где переживёт разговор и не отзывается.
      const rows = await db
        .select({ id: credentials.id, name: credentials.name, url: credentials.url })
        .from(taskResources)
        .innerJoin(credentials, eq(credentials.id, taskResources.resourceId))
        .where(and(eq(taskResources.taskId, t.id), isNull(credentials.deletedAt)))
      if (!rows.length) return `${t.number} has no linked resources.`
      return rows.map((r) => `${r.id} — ${r.name || '(no name)'}${r.url ? ` — ${r.url}` : ''}`).join('\n')
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
        // И по содержимому, а не только по заголовку: «в каком документе про
        // это написано» — вопрос, на который заголовок отвечает редко.
        .where(q ? and(base, or(ilike(documents.title, `%${q}%`), ilike(documents.content, `%${q}%`))) : base)
        .orderBy(desc(documents.updatedAt))
        .limit(50)
      if (!rows.length) return 'No documents.'
      return rows
        .map((d) => {
          const text = htmlToText(d.content)
          // При поиске показываем НАЙДЕННОЕ место: начало документа у всех
          // одинаковое и не объясняет, почему он попал в выдачу.
          const hit = q ? searchInText(text, q, 100).matches[0] : null
          const preview = hit ? hit.text : text.slice(0, 120)
          return `"${d.title || '—'}" (id=${d.id}, ${text.length} chars, updated ${d.updatedAt.toISOString().slice(0, 10)})${preview ? ` — ${preview}${!hit && text.length > 120 ? '…' : ''}` : ''}`
        })
        .join('\n')
    },
    read_document: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'documents.read'))) return 'PERMISSION DENIED: the author cannot read documents.'
      const d = await db.query.documents.findFirst({
        where: and(eq(documents.id, String(args.id ?? '')), eq(documents.projectId, projectId), sql`${documents.deletedAt} is null`),
      })
      if (!d) return 'Document not found.'
      // Поиск ВНУТРИ документа. offset отвечает на «дай кусок номер N», но не
      // на «где здесь про авторизацию»: спецификация в 32 тысячи символов —
      // это восемь чтений подряд ради одного абзаца.
      const q = typeof args.query === 'string' ? args.query.trim() : ''
      if (q) {
        const found = searchInDocument(d.content, q, Number(args.context) || undefined)
        if (!found.matches.length) {
          return `"${d.title || '—'}" (${found.total} chars): nothing found for "${q}". The search is literal — try a shorter word.`
        }
        return [
          `"${d.title || '—'}" — ${found.matches.length} place(s) matching "${q}" (document is ${found.total} chars)${found.truncated ? '; MORE MATCHES EXIST — narrow the query' : ''}`,
          'Read around any of them with read_document offset=<offset>.',
          '',
          ...found.matches.map((m) => `[offset ${m.offset}] ${m.text}`),
        ].join('\n')
      }
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
    start_timer: async (args) => {
      const cfg = await timeConfigForProject(projectId)
      const running = await db
        .select()
        .from(timeEntries)
        .where(and(eq(timeEntries.projectId, projectId), eq(timeEntries.userId, actorUserId), isNull(timeEntries.endedAt)))
      if (running.length >= cfg.maxTimers) {
        return `Cannot start: ${running.length} timer(s) already running and the project allows ${cfg.maxTimers} at once. Stop one first (stop_timer) or raise the limit in project settings.`
      }

      let taskId: string | null = null
      if (args.taskNumber) {
        const t = await db.query.tasks.findFirst({
          where: and(eq(tasks.projectId, projectId), eq(tasks.number, String(args.taskNumber).toUpperCase())),
        })
        if (!t) return `Task ${String(args.taskNumber)} not found.`
        taskId = t.id
      }

      const [row] = await db
        .insert(timeEntries)
        .values({
          projectId,
          userId: actorUserId,
          taskId,
          description: String(args.description ?? '').slice(0, 500),
          startedAt: typeof args.startedAt === 'string' ? new Date(args.startedAt) : new Date(),
          createdVia: 'ai',
        })
        .returning()
      broadcast(projectId, 'time', { action: 'start', id: row!.id, userId: actorUserId })
      return `Timer started at ${row!.startedAt.toISOString().slice(11, 16)} UTC${taskId ? ` on ${String(args.taskNumber)}` : ''}.`
    },
    stop_timer: async (args) => {
      const running = await db
        .select()
        .from(timeEntries)
        .where(and(eq(timeEntries.projectId, projectId), eq(timeEntries.userId, actorUserId), isNull(timeEntries.endedAt)))
      if (!running.length) return 'No timer is running.'
      const entry = args.id ? running.find((r) => r.id === String(args.id)) : running[0]
      if (!entry) return 'That timer is not running.'
      if (running.length > 1 && !args.id) {
        return `${running.length} timers are running — say which one: ${running.map((r) => `${r.id} (${r.description || 'no description'})`).join(', ')}.`
      }
      const endedAt = new Date()
      if (endedAt.getTime() - entry.startedAt.getTime() < 1_000) {
        await db.delete(timeEntries).where(eq(timeEntries.id, entry.id))
        broadcast(projectId, 'time', { action: 'delete', id: entry.id, userId: actorUserId })
        return 'The timer ran under a second — nothing was recorded.'
      }
      await db.update(timeEntries).set({ endedAt, updatedAt: endedAt }).where(eq(timeEntries.id, entry.id))
      broadcast(projectId, 'time', { action: 'stop', id: entry.id, userId: actorUserId })
      const minutes = Math.round((endedAt.getTime() - entry.startedAt.getTime()) / 60_000)
      return `Timer stopped: ${Math.floor(minutes / 60)}h ${minutes % 60}m recorded.`
    },
    list_timers: async () => {
      const cfg = await timeConfigForProject(projectId)
      const running = await db
        .select()
        .from(timeEntries)
        .where(and(eq(timeEntries.projectId, projectId), eq(timeEntries.userId, actorUserId), isNull(timeEntries.endedAt)))
      if (!running.length) return `Nothing running. The project allows ${cfg.maxTimers} parallel timer(s).`
      const now = Date.now()
      return running
        .map((r) => `${r.id} — started ${r.startedAt.toISOString().slice(11, 16)} UTC, ${Math.round((now - r.startedAt.getTime()) / 60_000)} min so far${r.description ? `: ${r.description}` : ''}`)
        .join('\n')
    },
    log_time: async (args) => {
      const started = new Date(String(args.startedAt))
      let ended = new Date(String(args.endedAt))
      if (Number.isNaN(started.getTime()) || Number.isNaN(ended.getTime())) return 'Could not read the timestamps.'
      // конец раньше начала — работа перешла через полночь
      if (ended.getTime() <= started.getTime()) ended = new Date(ended.getTime() + 86_400_000)

      let taskId: string | null = null
      if (args.taskNumber) {
        const t = await db.query.tasks.findFirst({
          where: and(eq(tasks.projectId, projectId), eq(tasks.number, String(args.taskNumber).toUpperCase())),
        })
        if (!t) return `Task ${String(args.taskNumber)} not found.`
        taskId = t.id
      }

      const [row] = await db
        .insert(timeEntries)
        .values({
          projectId,
          userId: actorUserId,
          taskId,
          description: String(args.description ?? '').slice(0, 500),
          startedAt: started,
          endedAt: ended,
          createdVia: 'ai',
        })
        .returning()
      broadcast(projectId, 'time', { action: 'create', id: row!.id, userId: actorUserId })
      const minutes = Math.round((ended.getTime() - started.getTime()) / 60_000)
      return `Logged ${Math.floor(minutes / 60)}h ${minutes % 60}m${taskId ? ` on ${String(args.taskNumber)}` : ''}.`
    },
    send_report: async (args) => {
      const kind = String(args.kind ?? 'request')
      if (!(REPORT_KINDS as readonly string[]).includes(kind)) {
        return `Unknown kind "${kind}". Use one of: ${REPORT_KINDS.join(', ')}.`
      }
      // Имя и почту берём из базы, а не из разговора: репорт подписывается
      // человеком, и отвечать будут ему.
      const me = await db.query.users.findFirst({ where: eq(users.id, actorUserId) })
      if (!me) return 'Cannot send the report: this user no longer exists.'
      const res = await submitAssistantReport({
        kind: kind as ReportKind,
        body: String(args.body ?? ''),
        context: typeof args.context === 'string' ? args.context : undefined,
        user: { id: me.id, name: me.name, email: me.email },
        projectId,
        clientName: 'Chatick assistant',
      })
      if (!res.ok) {
        // Причину отдаём как есть: «слишком коротко» и «слишком часто» —
        // разные вещи, и во втором случае переписывать текст бессмысленно.
        return `Not sent: ${res.error}`
      }
      // Никаких «починим» и сроков: читает человек, автоматически ничего не
      // происходит. Обещание за нас — это обещание, которое некому исполнить.
      return 'Sent to the Chatick team. Tell them it has been passed on, and that a person will read it — without promising a fix or a date.'
    },
    time_report: async (args) => {
      const privileged = await hasPermission(projectId, actorUserId, 'tasks.edit')
      const conds = [eq(timeEntries.projectId, projectId), sql`${timeEntries.endedAt} is not null`]
      // без права видеть чужое — только свои часы
      if (!privileged) conds.push(eq(timeEntries.userId, actorUserId))
      if (typeof args.from === 'string') conds.push(gte(timeEntries.startedAt, new Date(args.from)))
      if (typeof args.to === 'string') {
        const to = new Date(args.to)
        to.setHours(23, 59, 59, 999)
        conds.push(lte(timeEntries.startedAt, to))
      }

      const minutes = sql<number>`coalesce(sum(extract(epoch from (${timeEntries.endedAt} - ${timeEntries.startedAt})) / 60), 0)::int`
      const [byUser, byTask] = await Promise.all([
        db
          .select({ name: users.name, minutes })
          .from(timeEntries)
          .innerJoin(users, eq(users.id, timeEntries.userId))
          .where(and(...conds))
          .groupBy(users.name),
        db
          .select({ number: tasks.number, title: tasks.title, minutes })
          .from(timeEntries)
          .leftJoin(tasks, eq(tasks.id, timeEntries.taskId))
          .where(and(...conds))
          .groupBy(tasks.number, tasks.title),
      ])
      if (!byUser.length) return 'No tracked time for that period.'
      const fmt = (m: number) => `${Math.floor(m / 60)}h ${m % 60}m`
      return [
        'By person:',
        ...byUser.sort((a, b) => b.minutes - a.minutes).map((r) => `  ${r.name}: ${fmt(r.minutes)}`),
        'By task:',
        ...byTask
          .sort((a, b) => b.minutes - a.minutes)
          .map((r) => `  ${r.number ? `${r.number} ${r.title}` : '(no task)'}: ${fmt(r.minutes)}`),
      ].join('\n')
    },
    announce: async (args) => {
      const title = String(args.title ?? '').trim()
      if (!title) return 'Pass title — one line saying what happened.'
      const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
      if (!project?.companyId) return 'No company context.'
      // Только админ компании: от объявления нельзя отписаться, и право
      // рассылать неотключаемое сообщение — это право, а не удобство.
      if ((await companyRoleOf(project.companyId, actorUserId)) !== 'admin') {
        return 'PERMISSION DENIED: only a company admin can send an announcement. Say so plainly — it reaches everyone and cannot be turned off.'
      }
      const company = await db.query.companies.findFirst({ where: eq(companies.id, project.companyId) })
      const actor = await db.query.users.findFirst({ where: eq(users.id, actorUserId) })
      const users_ = Array.isArray(args.users) ? args.users.map(String) : []
      const res = await announce({
        companyId: project.companyId,
        companyName: company?.name ?? '',
        actorId: actorUserId,
        actorName: actor?.name || 'Someone',
        title,
        body: typeof args.body === 'string' ? richText(args.body) : undefined,
        target: args.project === true
          ? { kind: 'project', projectId }
          : users_.length
            ? { kind: 'users', userIds: users_ }
            : { kind: 'company' },
        email: args.email === true,
      })
      if (!res.sent) return 'Nobody matched — nothing was sent. Check who you meant.'
      return `Announced to ${res.sent} people${res.emailed ? `, ${res.emailed} by email as well` : ''}.`
    },
    search_tasks: async (args) => {
      const q = String(args.query ?? '').trim()
      if (!q) return 'Pass query — ask in plain words.'
      const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
      if (!project?.companyId) return 'No company context.'
      const found = await searchTaskIds({
        query: q,
        userId: actorUserId,
        companyId: project.companyId,
        // По умолчанию ищем везде: «где та таска» — вопрос как раз о том, что
        // проект забыт. Сузить можно явно.
        projectId: args.allProjects === false ? projectId : null,
        limit: 15,
      })
      if (!found.ids.length) return 'Nothing matched. The search goes by meaning, so rephrasing rarely helps — more likely it is simply not there.'
      const rows = await db
        .select({ t: tasks, p: projects })
        .from(tasks)
        .leftJoin(projects, eq(projects.id, tasks.projectId))
        .where(inArray(tasks.id, found.ids))
      const ordered = [...rows].sort((a, b) => found.ids.indexOf(a.t.id) - found.ids.indexOf(b.t.id))
      return ordered
        .map(
          (r) =>
            `${r.t.number} [${r.t.status}] ${r.t.title}` +
            `${r.t.projectId !== projectId ? ` — project: ${r.p?.name ?? '?'}` : ''}` +
            `${found.semanticIds.has(r.t.id) ? ' (matched by meaning)' : ''}`,
        )
        .join('\n')
    },
    list_notes: async (args) => {
      // База знаний принадлежит КОМПАНИИ: доступ даёт членство в ней. Проверка
      // по правам проекта отказала бы в доступе к записи, у которой проекта
      // нет вовсе.
      const kbProject = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
      if (!kbProject?.companyId || !(await canUseKnowledge(kbProject.companyId, actorUserId))) {
        return 'PERMISSION DENIED: you are not a member of this company.'
      }
      const conds = [sql`${notes.deletedAt} is null`]
      if (String(args.scope ?? '') === 'company') {
        const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
        conds.push(
          project?.companyId
            ? or(eq(notes.projectId, projectId), and(eq(notes.companyId, project.companyId), eq(notes.scope, 'company')))!
            : eq(notes.projectId, projectId),
        )
      } else {
        conds.push(eq(notes.projectId, projectId))
      }
      const types = String(args.type ?? '').split(',').map((x) => x.trim()).filter(Boolean)
      if (types.length) conds.push(inArray(notes.type, types))
      for (const tag of String(args.tag ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
        conds.push(sql`${notes.tags}::jsonb ? ${tag}`)
      }
      // Поиск по СМЫСЛУ, тот же, что и у моста: одна функция на оба пути,
      // иначе ассистент внутри и ассистент снаружи начнут отвечать по-разному
      // на один вопрос.
      const q = String(args.query ?? '').trim()
      let order: string[] | null = null
      const byMeaning = new Set<string>()
      if (q) {
        const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
        const hybrid = await searchNoteIds({
          query: q,
          projectId,
          companyId: project?.companyId ?? null,
          // По умолчанию вся компания: решение из соседнего проекта — это
          // ровно то, ради чего база знаний и заводилась.
          companyWide: String(args.scope ?? '') !== 'project',
        })
        // Пусто — так и говорим. Прежний ilike в этом случае условия не
        // добавлял, и «поиск» возвращал ВЕСЬ журнал: модель принимала его за
        // найденное и отвечала по случайной заметке.
        if (!hybrid.ids.length) return 'No notes found.'
        order = hybrid.ids
        for (const noteId of hybrid.semanticIds) byMeaning.add(noteId)
        conds.push(inArray(notes.id, hybrid.ids))
      }
      const rows = await db.select().from(notes).where(and(...conds)).orderBy(desc(notes.createdAt)).limit(40)
      if (!rows.length) return 'No notes found.'
      // Порядок гибридного поиска сильнее даты: точные совпадения первыми.
      const sorted = order ? [...rows].sort((a, b) => order!.indexOf(a.id) - order!.indexOf(b.id)) : rows
      return sorted
        .map(
          (n) =>
            `[${n.type}] ${n.id} — "${n.title || htmlToText(n.body).slice(0, 60)}" tags=${n.tags}` +
            `${n.scope === 'company' ? ' (company-wide)' : ''}${byMeaning.has(n.id) ? ' (matched by meaning)' : ''}`,
        )
        .join('\n')
    },
    read_note: async (args) => {
      // База знаний принадлежит КОМПАНИИ: доступ даёт членство в ней. Проверка
      // по правам проекта отказала бы в доступе к записи, у которой проекта
      // нет вовсе.
      const kbProject = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
      if (!kbProject?.companyId || !(await canUseKnowledge(kbProject.companyId, actorUserId))) {
        return 'PERMISSION DENIED: you are not a member of this company.'
      }
      const n = await db.query.notes.findFirst({
        where: and(eq(notes.id, String(args.id ?? '')), sql`${notes.deletedAt} is null`),
      })
      if (!n) return 'Note not found.'
      // чужой проект — только company-видимые
      if (n.projectId !== projectId) {
        const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
        if (!(n.scope === 'company' && n.companyId && n.companyId === project?.companyId)) return 'Note not found.'
      }
      const sources = JSON.parse(n.sources) as { authorName?: string; text: string }[]
      return [
        `[${n.type}] "${n.title}" tags=${n.tags} scope=${n.scope}`,
        htmlToText(n.body),
        sources.length ? `\nQuoted from chat (in order):\n${sources.map((q, i) => `${i + 1}. ${q.authorName ?? '—'}: ${q.text.slice(0, 400)}`).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    },
    create_note: async (args) => {
      // База знаний принадлежит КОМПАНИИ: доступ даёт членство в ней. Проверка
      // по правам проекта отказала бы в доступе к записи, у которой проекта
      // нет вовсе.
      const kbProject = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
      if (!kbProject?.companyId || !(await canUseKnowledge(kbProject.companyId, actorUserId))) {
        return 'PERMISSION DENIED: you are not a member of this company.'
      }
      const type = String(args.type ?? 'note')
      if (!(NOTE_TYPES as readonly string[]).includes(type)) return `Unknown type. Use one of: ${NOTE_TYPES.join(', ')}.`
      const title = String(args.title ?? '').slice(0, 300)
      if (!title && !String(args.body ?? '').trim()) return 'Provide at least a title or a body.'
      const row = await createNote(
        projectId,
        actorUserId,
        {
          type: type as never,
          title,
          body: String(args.body ?? ''),
          tags: Array.isArray(args.tags) ? (args.tags as unknown[]).map(String).slice(0, 20) : [],
          scope: args.scope === 'company' ? 'company' : 'project',
          sources: [],
          mentionedIds: Array.isArray(args.assigneeIds) ? (args.assigneeIds as unknown[]).map(String) : [],
          remindAt: typeof args.remindAt === 'string' ? args.remindAt : null,
          sourceMessageIds: Array.isArray(args.sourceMessageIds) ? (args.sourceMessageIds as unknown[]).map(String).slice(0, 50) : [],
        },
        'ai',
      )
      return `Saved a ${type} note "${row.title}" (id=${row.id})${row.scope === 'company' ? ', visible across the company' : ''}.`
    },
    update_note: async (args) => {
      // База знаний принадлежит КОМПАНИИ: доступ даёт членство в ней. Проверка
      // по правам проекта отказала бы в доступе к записи, у которой проекта
      // нет вовсе.
      const kbProject = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
      if (!kbProject?.companyId || !(await canUseKnowledge(kbProject.companyId, actorUserId))) {
        return 'PERMISSION DENIED: you are not a member of this company.'
      }
      const n = await db.query.notes.findFirst({
        where: and(eq(notes.id, String(args.id ?? '')), eq(notes.projectId, projectId), sql`${notes.deletedAt} is null`),
      })
      if (!n) return 'Note not found.'
      const patch: Record<string, unknown> = { updatedAt: new Date() }
      if (typeof args.type === 'string') {
        if (!(NOTE_TYPES as readonly string[]).includes(args.type)) return `Unknown type. Use one of: ${NOTE_TYPES.join(', ')}.`
        patch.type = args.type
      }
      if (typeof args.title === 'string') patch.title = args.title.slice(0, 300)
      if (typeof args.body === 'string') patch.body = sanitizeHtml(args.body)
      if (Array.isArray(args.tags)) patch.tags = JSON.stringify((args.tags as unknown[]).map((x) => String(x).toLowerCase()))
      if (args.scope === 'company' || args.scope === 'project') patch.scope = args.scope
      if (typeof args.remindAt === 'string') {
        patch.remindAt = new Date(args.remindAt)
        patch.remindedAt = null
      }
      await db.update(notes).set(patch).where(eq(notes.id, n.id))
      // Поиск по смыслу: пересчёт фоном, как и на двух других путях правки.
      void enqueueEmbedding('note', n.id, projectId)
      broadcast(projectId, 'notes', { action: 'update', id: n.id })
      return `Updated note "${n.title}".`
    },
    note_to_task: async (args) => {
      if (!(await hasPermission(projectId, actorUserId, 'tasks.create'))) return 'PERMISSION DENIED: the author cannot create tasks.'
      const assigneeId = args.assignee ? await resolveAssignee(args.assignee) : null
      const res = await noteToTask(projectId, actorUserId, String(args.id ?? ''), {
        title: typeof args.title === 'string' ? args.title : undefined,
        assigneeId: assigneeId ?? null,
      })
      if ('error' in res) return String(res.error)
      return res.already
        ? `That note already has task ${res.task.number} — not creating a duplicate.`
        : `Created ${res.task.number} "${res.task.title}" from the note.`
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
    get_blockers: async () => {
      if (!(await hasPermission(projectId, actorUserId, 'tasks.read')))
        return 'PERMISSION DENIED: the author cannot read tasks. Politely refuse.'
      const rows = await db
        .select({
          blockerNumber: tasks.number,
          blockerTitle: tasks.title,
          owner: users.name,
          blockedNumber: sql<string>`blocked.number`,
        })
        .from(taskBlockers)
        .innerJoin(tasks, eq(tasks.id, taskBlockers.blockerTaskId))
        .innerJoin(sql`${tasks} blocked`, sql`blocked.id = ${taskBlockers.blockedTaskId}`)
        .leftJoin(users, eq(users.id, tasks.assigneeId))
        .where(
          and(
            eq(taskBlockers.projectId, projectId),
            isNull(tasks.deletedAt),
            sql`blocked.deleted_at is null`,
            // Закрытая задача никого не держит: связь остаётся историей.
            sql`${tasks.status} <> 'done'`,
            sql`blocked.status <> 'done'`,
          ),
        )
      if (!rows.length) return 'Nothing is blocking anything right now.'
      const byBlocker = new Map<string, { title: string; owner: string; blocks: string[] }>()
      for (const r of rows) {
        const cur = byBlocker.get(r.blockerNumber) ?? { title: r.blockerTitle, owner: r.owner ?? '', blocks: [] }
        cur.blocks.push(r.blockedNumber)
        byBlocker.set(r.blockerNumber, cur)
      }
      const items = [...byBlocker.entries()].sort((a, b) => b[1].blocks.length - a[1].blocks.length)
      return items
        .map(
          ([num, v]) =>
            `${num} "${v.title}" — blocks ${v.blocks.length} (${v.blocks.join(', ')}); owner: ${v.owner || 'NOBODY — nobody to ask'}`,
        )
        .join('\n')
    },
    get_task_blockers: async (args: Record<string, unknown>) => {
      const a = args as { number: string }
      if (!(await hasPermission(projectId, actorUserId, 'tasks.read')))
        return 'PERMISSION DENIED: the author cannot read tasks. Politely refuse.'
      const task = await db.query.tasks.findFirst({
        where: and(eq(tasks.projectId, projectId), eq(tasks.number, String(a.number).toUpperCase()), isNull(tasks.deletedAt)),
      })
      if (!task) return `Task ${a.number} not found.`
      const waits = await db
        .select({ n: tasks.number, t: tasks.title, st: tasks.status })
        .from(taskBlockers)
        .innerJoin(tasks, eq(tasks.id, taskBlockers.blockerTaskId))
        .where(and(eq(taskBlockers.blockedTaskId, task.id), isNull(tasks.deletedAt)))
      const holds = await db
        .select({ n: tasks.number, t: tasks.title, st: tasks.status })
        .from(taskBlockers)
        .innerJoin(tasks, eq(tasks.id, taskBlockers.blockedTaskId))
        .where(and(eq(taskBlockers.blockerTaskId, task.id), isNull(tasks.deletedAt)))
      const open = waits.filter((w) => w.st !== 'done').length
      const fmt = (list: typeof waits) => list.map((x) => `${x.n} "${x.t}" [${x.st}]`).join(', ') || 'none'
      return [
        `${task.number} "${task.title}"`,
        `waits for: ${fmt(waits)}`,
        `blocks: ${fmt(holds)}`,
        open ? `CANNOT START: ${open} unfinished blocker(s).` : 'Ready to work on — nothing unfinished in the way.',
      ].join('\n')
    },
    link_tasks: async (args: Record<string, unknown>) => {
      const a = args as { number: string; blockedBy: string[] }
      if (!(await hasPermission(projectId, actorUserId, 'tasks.edit')))
        return 'PERMISSION DENIED: the author cannot edit tasks. Politely refuse.'
      const task = await db.query.tasks.findFirst({
        where: and(eq(tasks.projectId, projectId), eq(tasks.number, String(a.number).toUpperCase()), isNull(tasks.deletedAt)),
      })
      if (!task) return `Task ${a.number} not found.`
      const wanted = (Array.isArray(a.blockedBy) ? a.blockedBy : []).map((x) => String(x).toUpperCase())
      if (!wanted.length) return 'blockedBy is empty.'
      const found = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.projectId, projectId), inArray(tasks.number, wanted), isNull(tasks.deletedAt)))
      if (found.length !== wanted.length) return `Some tasks were not found in this project: ${wanted.join(', ')}`
      if (found.some((f) => f.id === task.id)) return 'A task cannot block itself.'
      // Кольцо — тупик: обе задачи невозможно закрыть никогда. Проверяем ТОЙ ЖЕ
      // функцией, что и веб с мостом, а не своей копией.
      const forbidden = await dependentsOf(projectId, task.id)
      const looped = found.filter((f) => forbidden.has(f.id))
      if (looped.length)
        return `Cannot link: ${looped.map((l) => l.number).join(', ')} already depends on ${task.number}. That would close a loop and neither could ever be finished.`
      await db
        .insert(taskBlockers)
        .values(found.map((f) => ({ projectId, blockedTaskId: task.id, blockerTaskId: f.id, createdById: actorUserId })))
        .onConflictDoNothing()
      broadcast(projectId, 'tasks_changed', {})
      return `${task.number} now waits for: ${found.map((f) => f.number).join(', ')}.`
    },
    list_databases: async () => {
      if (env.DB_CONNECTIONS_ENABLED !== 'true') return 'No databases are connected to this project.'
      if (!(await hasPermission(projectId, actorUserId, 'resources.read')))
        return 'PERMISSION DENIED: the author cannot read resources. Politely refuse.'
      const conns = await db
        .select()
        .from(dbConnections)
        .where(and(eq(dbConnections.projectId, projectId), isNull(dbConnections.deletedAt)))
      if (!conns.length) return 'No databases are connected to this project.'
      const out: string[] = []
      for (const c of conns) {
        const pol = await db.select().from(dbTablePolicies).where(eq(dbTablePolicies.connectionId, c.id))
        const readable = pol.filter((p) => p.canRead)
        out.push(
          `${c.name} (id: ${c.id}, ${c.kind}, ${c.host}/${c.database}) — readable tables: ${
            readable.length ? readable.map((p) => p.tableName).join(', ') : 'NONE yet; a project admin must open them first'
          }`,
        )
      }
      return out.join('\n')
    },
    query_database: async (args: Record<string, unknown>) => {
      const a = args as { databaseId: string; sql: string; limit?: number }
      if (env.DB_CONNECTIONS_ENABLED !== 'true') return 'No databases are connected to this project.'
      if (!(await hasPermission(projectId, actorUserId, 'resources.read')))
        return 'PERMISSION DENIED: the author cannot read resources. Politely refuse.'
      const r = await readFromConnection({
        projectId,
        userId: actorUserId,
        connectionId: String(a.databaseId),
        sql: String(a.sql),
        limit: typeof a.limit === 'number' ? a.limit : undefined,
        viaBridge: false,
      })
      if ('error' in r) return `Query failed: ${r.error}`
      if (!r.result.rows.length) return 'No rows.'
      // Компактно: модель читает текст, а не таблицу.
      const head = r.result.columns.join(' | ')
      const body = r.result.rows.map((row) => r.result.columns.map((c) => String(row[c] ?? '')).join(' | ')).join('\n')
      return `${head}\n${body}${r.result.truncated ? '\n(truncated — this is only part of the result)' : ''}`
    },
    list_chat_images: async (args: Record<string, unknown>) => {
      const limit = Math.min(Math.max(1, Number((args as { limit?: number }).limit) || 10), 30)
      const rows = await db
        // id — чтобы приложенное к задаче можно было приложить. Без него
        // attach_file_to_task и create_task требовали fileId, которого человек
        // не знает, а взять его было НЕГДЕ: list_files временные файлы не
        // показывает (там pendingUntil is null), а здесь отдавалось одно имя.
        .select({ id: files.id, name: files.name, mime: files.mime, at: files.createdAt, text: messages.text })
        .from(files)
        .innerJoin(messages, eq(messages.id, files.messageId))
        .where(
          and(
            eq(files.projectId, projectId),
            // Только свои: чат с ассистентом личный.
            eq(files.uploadedById, actorUserId),
            eq(messages.mode, 'ai'),
            isNull(files.deletedAt),
          ),
        )
        .orderBy(desc(files.createdAt))
        .limit(limit)
      // Не только картинки: PDF, лог и архив бросают в чат не реже, а раньше
      // они не показывались нигде — ассистент отвечал, что вложений нет.
      if (!rows.length) return 'Nothing attached in this chat yet.'
      return rows
        .map((r) => {
          const isImage = r.mime.startsWith('image/')
          return `${r.name} (id=${r.id}, ${isImage ? 'image — view_image can open it' : r.mime})${
            ` — ${r.at.toISOString().slice(0, 16).replace('T', ' ')}`
          }, sent with: "${(r.text || '').slice(0, 60)}"`
        })
        .join('\n')
    },
    view_image: async (args: Record<string, unknown>) => {
      const a = args as { fileName: string }
      if (!(await visionEnabled(projectId)))
        return 'Image recognition is turned off for this company. An owner or admin can enable it in Company settings → AI → "Image recognition".'

      // Только СВОЯ картинка из ЭТОГО диалога: чужие вложения и файлы общего
      // чата сюда не попадают — диалог с ассистентом приватный.
      const [f] = await db
        .select({ name: files.name, mime: files.mime, size: files.size, key: files.key })
        .from(files)
        .innerJoin(messages, eq(messages.id, files.messageId))
        .where(
          and(
            eq(files.projectId, projectId),
            eq(files.uploadedById, actorUserId),
            eq(files.name, String(a.fileName)),
            eq(messages.mode, 'ai'),
            isNull(files.deletedAt),
          ),
        )
        .limit(1)
      if (!f) return `No image named "${a.fileName}" in this chat. Call list_chat_images to see what is there.`
      if (!SUPPORTED.has(f.mime)) return `"${f.name}" is ${f.mime} — not an image format I can look at.`
      if (Number(f.size) > MAX_BYTES) return `"${f.name}" is too large to open (over 4 MB).`

      try {
        const storage = await resolveStorage(projectId)
        const { body } = await getObjectStream(storage, f.key)
        const chunks: Buffer[] = []
        for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer))
        return {
          text: `Image "${f.name}":`,
          images: [{ mediaType: f.mime, base64: Buffer.concat(chunks).toString('base64') }],
        }
      } catch {
        return `Could not open "${f.name}" — the file may have been removed.`
      }
    },
    keep_attached_file: async (args: Record<string, unknown>) => {
      const a = args as { fileName: string }
      if (!(await hasPermission(projectId, actorUserId, 'files.upload')))
        return 'PERMISSION DENIED: the author cannot upload files. Politely refuse.'
      // Только СВОЙ временный файл этого проекта: чужие и уже сохранённые не
      // трогаем.
      const f = await db.query.files.findFirst({
        where: and(
          eq(files.projectId, projectId),
          eq(files.uploadedById, actorUserId),
          eq(files.name, String(a.fileName)),
          isNotNull(files.pendingUntil),
          isNull(files.deletedAt),
        ),
      })
      if (!f) return `No temporary file named "${a.fileName}" found — it may have been saved already or removed.`
      await db.update(files).set({ pendingUntil: null }).where(eq(files.id, f.id))
      broadcast(projectId, 'files_changed', {})
      return `Saved "${f.name}" to the project files.`
    },
    discard_attached_file: async (args: Record<string, unknown>) => {
      const a = args as { fileName: string }
      const f = await db.query.files.findFirst({
        where: and(
          eq(files.projectId, projectId),
          eq(files.uploadedById, actorUserId),
          eq(files.name, String(a.fileName)),
          isNotNull(files.pendingUntil),
          isNull(files.deletedAt),
        ),
      })
      if (!f) return `No temporary file named "${a.fileName}" found.`
      await db.update(files).set({ deletedAt: new Date(), deletedById: actorUserId }).where(eq(files.id, f.id))
      return `Removed "${f.name}".`
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
    // саммари дня уходит в долговременную память: обрезанное останется таким
    // навсегда, поэтому запас щедрый
    maxTokens: 3000,
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
 * Догнать сжатие: обрабатывает завершённые дни подряд, пока они не кончатся.
 *
 * Раньше за вызов сжимался ровно один день, а вызов происходит только при
 * новом сообщении. В проекте с месячным перерывом это значило, что тридцать
 * дней истории ждут тридцати новых сообщений, и очередь не рассасывалась
 * никогда: сообщения копились, а выжимки для них не появлялись.
 *
 * Потолок на проход — чтобы отправка одного сообщения не превращалась в сотню
 * запросов к модели. Остаток догонит следующий вызов.
 */
const MAX_DAYS_PER_RUN = 10

export async function maybeCompress(projectId: string): Promise<void> {
  for (let day = 0; day < MAX_DAYS_PER_RUN; day++) {
    const did = await compressOneDay(projectId)
    if (!did) return
  }
  console.log(`[memory] ${projectId}: hit the ${MAX_DAYS_PER_RUN}-day cap, more will follow`)
}

/**
 * Сжать сообщения в саммари ПО ДНЯМ. За вызов обрабатывает один самый старый
 * ПОЛНОСТЬЮ ЗАВЕРШЁННЫЙ день (сегодняшний не трогаем — он ещё дописывается).
 * Крупный день дробится на несколько саммари по токен-бюджету. Fail-safe.
 *
 * @returns true, если день сжат и, возможно, есть ещё
 */
async function compressOneDay(projectId: string): Promise<boolean> {
  try {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
    if (!project) return false
    const cfg = await projectLlm(projectId, 'summary')
    if (!cfg) return false
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

    if (rows.length === 0) return false

    const today = UTC_DAY(new Date())
    const oldestDay = UTC_DAY(rows[0]!.msg.createdAt)
    // если весь несжатый остаток — это сегодня, ждём (день не завершён)
    if (oldestDay === today) return false

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
    return true
  } catch (e) {
    // Курсор не двигаем: день пересжимается при следующей попытке. Но и цикл
    // останавливаем — иначе сбой модели прокрутит все дни впустую.
    console.error('[memory] compress failed:', e)
    return false
  }
}
