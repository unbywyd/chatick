import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  assistantMessages,
  companies,
  files,
  HANDOFF_ACTIONS,
  notifications,
  projectMembers,
  tasks,
  timeEntries,
  users,
  type HandoffAction,
} from '../db/schema.js'
import { companyAssistantLlm, completeWithTools, type ToolDef, type ToolHandler } from './llm.js'
import { memoryTools } from './memory.js'
import { handoff, setOnTable, TABLE_LIMIT } from './ball.js'
import { notifyHandoff } from './handoff-notify.js'
import { matchPerson, matchProject } from './quick-task.js'
import { imagesForFiles } from './vision.js'
import { fromMeList, mineList, myProjects, quickTask, type ProjectList } from '../routes/ball.js'
import { ownsOrManages } from '../routes/projects.js'
import { signSessionToken } from '../auth.js'
import { timeMineRoute } from '../routes/time.js'
import { tasksChanged } from '../ws.js'

/**
 * Ассистент компании (v2): один разговор на человека и компанию.
 *
 * Раньше ИИ жил вкладкой в каждом проекте, со своей памятью в каждом: спросить
 * «что на мне по всем проектам» было некого, а начатое в одном проекте другой
 * не помнил. Теперь ассистент один и сам выбирает проект для каждого действия —
 * из тех, где человек состоит, и с теми же правами, что у него в этом проекте.
 *
 * Инструменты — те же, что у ИИ проекта (lib/memory.ts), с параметром
 * «project», плюс инструменты компании: мяч, стол, быстрое создание, время на
 * компанию, входящие. Удаляющих инструментов нет вовсе: стереть чужую работу
 * ассистенту не даём (решение пользователя).
 */

/**
 * Что открыто на экране, когда человек спросил, и что он приложил.
 *
 * fileIds — его файлы, загруженные «временно» в проект (живут сутки, если их
 * не прикрепить к задаче): скриншот, который он хочет показать или превратить
 * в задачу. Маршрут проверяет, что они его и из проекта этой компании.
 */
export type ScreenContext = { projectId?: string; taskId?: string; screen?: string; fileIds?: string[] }

/**
 * Инструменты ИИ проекта, которых у ассистента компании нет.
 *
 *   delete_*            — удалять ассистенту нельзя;
 *   search_my_dialog,   — привязаны к ИИ-вкладке проекта и её вложениям;
 *   *_attached_file,      у ассистента компании своя история
 *   list_chat_images,
 *   view_image,
 *   open_in_ui          — шлёт событие в комнату проекта; ассистенту экран
 *                         открывает клиент v2.
 */
export const EXCLUDED_TOOLS = new Set([
  'delete_task',
  'delete_tasks',
  'delete_resource',
  'delete_file',
  'delete_document',
  'search_my_dialog',
  'keep_attached_file',
  'discard_attached_file',
  'list_chat_images',
  'view_image',
  'open_in_ui',
])

const PROJECT_PARAM = {
  type: 'string',
  description: 'Project id or name. Omit to use the project open on the screen.',
}

export type Ctx = { companyId: string; userId: string; screen: ScreenContext; projects: ProjectList; used: string[] }

/** Проект для действия: названный, открытый на экране или единственный. */
export function pickProject(ctx: Ctx, arg: unknown): { id: string; name: string } | string {
  const list = ctx.projects
  if (typeof arg === 'string' && arg.trim()) {
    const byId = list.find((p) => p.id === arg.trim())
    if (byId) return byId
    const m = matchProject(arg, list)
    if (m.ok) return m.value
    if (m.reason === 'ambiguous') return `Project "${arg}" is ambiguous: ${m.candidates.map((p) => `${p.name} (${p.id})`).join(', ')}. Pass one of these ids.`
    return `No project "${arg}" among the person's projects: ${list.map((p) => p.name).join(', ')}.`
  }
  const open = ctx.screen.projectId ? list.find((p) => p.id === ctx.screen.projectId) : undefined
  if (open) return open
  if (list.length === 1) return list[0]!
  return `Which project? Pass "project" — one of: ${list.map((p) => `${p.name} (${p.id})`).join(', ')}.`
}

/**
 * Проектные инструменты с параметром project.
 *
 * Определения берём у memoryTools как есть — описание и схема одни на оба
 * ассистента, расходиться им нечему. Обработчик собирается на каждый вызов
 * уже под выбранный проект: права и все проверки остаются внутри memoryTools.
 */
export function projectTools(ctx: Ctx): { tools: ToolDef[]; handlers: Record<string, ToolHandler> } {
  const defs = memoryTools('', ctx.userId).tools.filter((t) => !EXCLUDED_TOOLS.has(t.name))
  // У инструмента бывает свой параметр project (announce: «только в проект»)
  // — тогда наш называется target_project, чтобы не перетереть его.
  const keyOf = (t: ToolDef) =>
    ((t.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}).project ? 'target_project' : 'project'
  const tools = defs.map((t) => {
    const params = (t.parameters ?? { type: 'object', properties: {} }) as { properties?: Record<string, unknown> }
    return {
      ...t,
      parameters: { ...params, type: 'object', properties: { ...(params.properties ?? {}), [keyOf(t)]: PROJECT_PARAM } },
    }
  })
  const handlers: Record<string, ToolHandler> = {}
  for (const t of defs) {
    const key = keyOf(t)
    handlers[t.name] = async (args) => {
      const p = pickProject(ctx, args[key])
      if (typeof p === 'string') return p
      ctx.used.push(t.name)
      const { [key]: _p, ...rest } = args
      const h = memoryTools(p.id, ctx.userId).handlers[t.name]
      return h ? h(rest) : `Unknown tool ${t.name}`
    }
  }
  return { tools, handlers }
}

async function taskIn(projectId: string, key: string) {
  const raw = key.trim()
  return db.query.tasks.findFirst({
    where: and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt), or(eq(tasks.id, raw), eq(tasks.number, raw.toUpperCase()))!),
  })
}

async function personIn(projectId: string, who: string, meId: string): Promise<string | null | { error: string }> {
  if (who === 'none' || who === 'backlog') return null
  const team = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
  const direct = team.find((u) => u.id === who)
  if (direct) return direct.id
  const m = matchPerson(who, team, meId)
  if (m.ok) return m.value.id
  return {
    error:
      m.reason === 'ambiguous'
        ? `"${who}" matches several people: ${m.candidates.map((c) => c.name).join(', ')}. Ask which one.`
        : `Nobody called "${who}" in this project. Team: ${team.map((u) => u.name).join(', ')}.`,
  }
}

const brief = (items: Awaited<ReturnType<typeof mineList>>['items']) =>
  items.slice(0, 40).map((i) => ({
    task: i.number,
    title: i.title,
    project: i.project?.name,
    move: i.ball.move,
    round: i.ball.round,
    since: i.ball.heldSince,
    waitingClient: Boolean(i.ball.waitingClientSince),
    holder: i.holder?.name,
    owner: i.owner?.name,
    isNew: i.isNew,
    due: i.dueDate,
    why: i.last ? `${i.last.action}${i.last.actor ? ` by ${i.last.actor.name}` : ''}${i.last.note ? `: ${i.last.note}` : ''}` : null,
  }))

/** Инструменты компании: то, чего у ИИ проекта не было. */
export function companyTools(ctx: Ctx): { tools: ToolDef[]; handlers: Record<string, ToolHandler> } {
  const tools: ToolDef[] = [
    {
      name: 'list_my_projects',
      description: 'The projects this person is in, in this company — ids and names.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'my_ball',
      description:
        'THE answer to "what is on me", "what should I do next" (view=mine) and "what am I waiting for, from whom" (view=from_me), across all projects. ' +
        'Each task says its move (do / review / answer), how long it has been held, the round and WHY it is here (the last hand-off and its note). ' +
        'view=mine also returns the table: the urgent few, at most 3.',
      parameters: {
        type: 'object',
        properties: {
          view: { type: 'string', enum: ['mine', 'from_me'] },
          move: { type: 'string', enum: ['do', 'review', 'answer'] },
          project: PROJECT_PARAM,
        },
        required: ['view'],
      },
    },
    {
      name: 'move_ball',
      description:
        'Hand a task over: review (done, please check — goes to the owner), accept (owner closes it), return (back to whoever sent it, round +1), ' +
        'ask (a question to "to"), answer (the ball goes back to whoever asked), pass (same move, to "to"), take (owner takes it back), ' +
        'wait_client / client_replied, cancel (only when the person said to drop it), reopen. ' +
        'A note is REQUIRED for review, return, ask, answer and cancel — write it in the project language; it is the first thing the next person reads. ' +
        'Confirm with the person before moving someone else\'s ball.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'TASK-81 or the id' },
          action: { type: 'string', enum: HANDOFF_ACTIONS.filter((a) => a !== 'create') },
          to: { type: 'string', description: 'A name, "me", or a user id' },
          note: { type: 'string' },
          project: PROJECT_PARAM,
        },
        required: ['task', 'action'],
      },
    },
    {
      name: 'set_on_table',
      description: `Put a task on the holder's table (urgent) or take it off. At most ${TABLE_LIMIT}: when full, ask the person which one to take off — never choose for them.`,
      parameters: {
        type: 'object',
        properties: { task: { type: 'string' }, on: { type: 'boolean' }, project: PROJECT_PARAM },
        required: ['task', 'on'],
      },
    },
    {
      name: 'quick_task',
      description:
        'Create a task from one line: "what to do @who #project". No # — the company main project; no @ — the person themselves. ' +
        'Call with preview=true first and tell the person whom and where; create when that is right. Ambiguous names come back with candidates — ask.',
      parameters: { type: 'object', properties: { text: { type: 'string' }, preview: { type: 'boolean' } }, required: ['text'] },
    },
    {
      name: 'company_time',
      description:
        'Time on the COMPANY itself, no project: a call, planning, reading mail. action=start runs a timer, stop stops the running company timer, ' +
        'log records past work (startedAt and endedAt, ISO). Only on the person\'s request. Project work goes through start_timer / log_time with a project.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'log'] },
          description: { type: 'string' },
          startedAt: { type: 'string' },
          endedAt: { type: 'string' },
        },
        required: ['action'],
      },
    },
    {
      name: 'my_inbox',
      description:
        'Unread notifications of this person in this company — what reached them and what is asked. Use for "anything new", "did anyone answer me".',
      parameters: { type: 'object', properties: { limit: { type: 'number' } } },
    },
  ]

  const used = (name: string) => ctx.used.push(name)
  const json = (x: unknown) => JSON.stringify(x)

  const handlers: Record<string, ToolHandler> = {
    list_my_projects: async () => {
      used('list_my_projects')
      return json(ctx.projects.map((p) => ({ id: p.id, name: p.name })))
    },

    my_ball: async (args) => {
      used('my_ball')
      let only: string | undefined
      if (args.project) {
        const p = pickProject(ctx, args.project)
        if (typeof p === 'string') return p
        only = p.id
      }
      const q = { project: only, move: args.move as 'do' | 'review' | 'answer' | undefined }
      if (args.view === 'from_me') {
        const r = await fromMeList(ctx.userId, ctx.projects, q)
        return json({ total: r.items.length, items: brief(r.items) })
      }
      const r = await mineList(ctx.userId, ctx.projects, q)
      return json({ table: brief(r.table), total: r.items.length, items: brief(r.items) })
    },

    move_ball: async (args) => {
      used('move_ball')
      const p = pickProject(ctx, args.project)
      if (typeof p === 'string') return p
      const task = await taskIn(p.id, String(args.task ?? ''))
      if (!task) return `Task ${String(args.task)} not found in ${p.name}.`
      const action = String(args.action) as HandoffAction
      if (!(HANDOFF_ACTIONS as readonly string[]).includes(action) || action === 'create') return `Unknown action ${action}.`
      let to: string | null | undefined
      if (typeof args.to === 'string' && args.to.trim()) {
        const r = await personIn(p.id, args.to.trim(), ctx.userId)
        if (r && typeof r === 'object') return r.error
        to = r
      }
      const r = await handoff(task, action, {
        actorId: ctx.userId,
        to,
        note: typeof args.note === 'string' ? args.note : undefined,
        via: 'ai',
        isManager: await ownsOrManages(p.id, ctx.userId, []),
      })
      if (!r.ok) return `REFUSED: ${r.error}. ${HANDOFF_HINT[r.error] ?? ''}`
      if (r.handoff) void notifyHandoff(r.task, r.handoff)
      tasksChanged(p.id, [r.task.assigneeId, task.assigneeId, r.task.ownerId ?? r.task.createdById])
      const holder = r.task.assigneeId ? await db.query.users.findFirst({ where: eq(users.id, r.task.assigneeId) }) : null
      return `${task.number}: ${action} done. Ball is with ${holder?.name ?? 'nobody (backlog)'}, move=${r.task.move}, status=${r.task.status}, round ${r.task.round}.`
    },

    set_on_table: async (args) => {
      used('set_on_table')
      const p = pickProject(ctx, args.project)
      if (typeof p === 'string') return p
      const task = await taskIn(p.id, String(args.task ?? ''))
      if (!task) return `Task ${String(args.task)} not found in ${p.name}.`
      const r = await setOnTable(task, args.on === true, ctx.userId, await ownsOrManages(p.id, ctx.userId, []))
      if (!r.ok) return r.error === 'table_full' ? `REFUSED: the table already holds ${TABLE_LIMIT}. Ask which one to take off.` : `REFUSED: ${r.error}.`
      tasksChanged(p.id, [task.assigneeId])
      return `${task.number} ${r.task.onTable ? 'is on the table' : 'is off the table'}.`
    },

    quick_task: async (args) => {
      used('quick_task')
      const r = await quickTask({
        userId: ctx.userId,
        companyId: ctx.companyId,
        projects: ctx.projects,
        text: String(args.text ?? ''),
        preview: args.preview === true,
        via: 'ai',
      })
      return json(r.body)
    },

    company_time: async (args) => {
      used('company_time')
      const me = await db.query.users.findFirst({ where: eq(users.id, ctx.userId) })
      const token = await signSessionToken({ sub: ctx.userId, email: me?.email ?? '' })
      const call = async (path: string, body?: unknown) => {
        const res = await timeMineRoute.request(path, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        return { status: res.status, body: (await res.json()) as Record<string, unknown> }
      }
      if (args.action === 'start') {
        const r = await call('/start', { companyId: ctx.companyId, description: String(args.description ?? '').slice(0, 500) })
        return r.status === 201 ? `Timer started on the company (no project).` : `REFUSED: ${String(r.body.error ?? r.status)}`
      }
      if (args.action === 'stop') {
        const running = await db.query.timeEntries.findFirst({
          where: and(eq(timeEntries.userId, ctx.userId), isNull(timeEntries.endedAt), isNull(timeEntries.projectId), eq(timeEntries.companyId, ctx.companyId)),
        })
        if (!running) return 'No company timer is running. Project timers stop with stop_timer.'
        const r = await call(`/${running.id}/stop`)
        return r.status === 200 ? `Stopped.` : `REFUSED: ${String(r.body.error ?? r.status)}`
      }
      // log — запись задним числом с теми же правилами, что у экрана часов
      const started = new Date(String(args.startedAt ?? ''))
      const ended = new Date(String(args.endedAt ?? ''))
      if (Number.isNaN(started.getTime()) || Number.isNaN(ended.getTime())) return 'startedAt and endedAt are required ISO timestamps.'
      if (ended.getTime() <= started.getTime()) return 'endedAt must be later than startedAt.'
      if (ended.getTime() - started.getTime() > 24 * 3600_000) return 'Longer than a day — check the dates.'
      if (started.getTime() > Date.now() + 60_000) return 'That is in the future.'
      await db.insert(timeEntries).values({
        projectId: null,
        companyId: ctx.companyId,
        userId: ctx.userId,
        description: String(args.description ?? '').slice(0, 500),
        startedAt: started,
        endedAt: ended,
        createdVia: 'ai',
      })
      return `Logged ${Math.round((ended.getTime() - started.getTime()) / 60000)} min on the company.`
    },

    my_inbox: async (args) => {
      used('my_inbox')
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 20))
      const rows = await db
        .select({ n: notifications, actor: users.name })
        .from(notifications)
        .leftJoin(users, eq(users.id, notifications.actorId))
        .where(and(eq(notifications.userId, ctx.userId), eq(notifications.companyId, ctx.companyId), isNull(notifications.readAt)))
        .orderBy(desc(notifications.createdAt))
        .limit(limit)
      return json(
        rows.map((r) => ({
          title: r.n.title,
          whatIsAsked: r.n.summary,
          text: r.n.body.slice(0, 300),
          from: r.actor,
          at: r.n.createdAt,
          about: r.n.entityType,
        })),
      )
    },
  }
  return { tools, handlers }
}

const HANDOFF_HINT: Partial<Record<string, string>> = {
  note_required: 'Ask the person what to write in the note (what to check / what is wrong / the question), then call again.',
  forbidden: 'Their role in this task does not allow that move.',
  wrong_move: 'Check the task: review is sent while doing the work; return is used on a task waiting for review.',
  not_member: 'That person is not in this project.',
  conflict: 'Someone moved the ball a moment ago — read the task again.',
}

const HISTORY_BUDGET = 6000
const MAX_ONE = 1500

/** Что открыто на экране — словами для модели. */
async function describeScreen(ctx: Ctx): Promise<string> {
  const parts: string[] = []
  const p = ctx.screen.projectId ? ctx.projects.find((x) => x.id === ctx.screen.projectId) : undefined
  if (p) parts.push(`project "${p.name}" (${p.id}) — the default for project tools`)
  if (ctx.screen.taskId && p) {
    const t = await db.query.tasks.findFirst({ where: and(eq(tasks.id, ctx.screen.taskId), eq(tasks.projectId, p.id)) })
    if (t) parts.push(`task ${t.number} «${t.title}» — "this task" means it`)
  }
  if (ctx.screen.screen) parts.push(`screen: ${ctx.screen.screen}`)
  return parts.length ? `ON THE SCREEN NOW: ${parts.join('; ')}.` : 'Nothing specific is open on the screen.'
}

/**
 * Ответ ассистента. Возвращает текст и какие инструменты понадобились; null —
 * ИИ недоступен (нет ключа, исчерпан пробный бюджет, провайдер упал).
 */
export async function assistantReply(input: {
  companyId: string
  userId: string
  text: string
  screen: ScreenContext
}): Promise<{ text: string; tools: string[] } | null> {
  const cfg = await companyAssistantLlm(input.companyId)
  if (!cfg) return null
  const [company, user, projectsList] = await Promise.all([
    db.query.companies.findFirst({ where: eq(companies.id, input.companyId) }),
    db.query.users.findFirst({ where: eq(users.id, input.userId) }),
    myProjects(input.companyId, input.userId),
  ])
  if (!company) return null
  const ctx: Ctx = { companyId: input.companyId, userId: input.userId, screen: input.screen, projects: projectsList, used: [] }

  // История: последние реплики этого человека в этой компании, по объёму, а не
  // по штукам — одна простыня не должна вытеснять остальное.
  const raw = await db
    .select()
    .from(assistantMessages)
    .where(and(eq(assistantMessages.userId, input.userId), eq(assistantMessages.companyId, input.companyId), eq(assistantMessages.failed, false)))
    .orderBy(desc(assistantMessages.createdAt))
    .limit(40)
  const history: { role: 'user' | 'assistant'; text: string }[] = []
  let usedChars = 0
  // Первая строка — только что сохранённое сообщение человека: оно уходит в user.
  for (const r of raw.slice(1)) {
    const text = r.text.length > MAX_ONE ? `${r.text.slice(0, MAX_ONE)}… [truncated]` : r.text
    if (usedChars + text.length > HISTORY_BUDGET) break
    usedChars += text.length
    history.unshift({ role: r.role === 'user' ? 'user' : 'assistant', text })
  }

  const p = projectTools(ctx)
  const c = companyTools(ctx)
  const screen = await describeScreen(ctx)

  // Вложения: что приложено и где лежит — чтобы модель могла прикрепить их к
  // задаче нужного проекта; картинки — если зрение включено и просят посмотреть.
  const attached = input.screen.fileIds?.length
    ? await db
        .select({ id: files.id, name: files.name, mime: files.mime, size: files.size, key: files.key, projectId: files.projectId })
        .from(files)
        .where(and(inArray(files.id, input.screen.fileIds), eq(files.uploadedById, input.userId), isNull(files.deletedAt)))
    : []
  const images = await imagesForFiles(
    attached.filter((f): f is typeof f & { projectId: string } => Boolean(f.projectId)),
    Boolean(company.llmVision),
    input.text,
  )
  const projectName = (id: string | null) => projectsList.find((x) => x.id === id)?.name ?? id
  const attachedNote = attached.length
    ? [
        `ATTACHED BY THE PERSON: ${attached.map((f) => `«${f.name}» (fileId ${f.id}, project ${projectName(f.projectId)})`).join('; ')}.`,
        'To turn it into a task: create the task in that project (create_task or quick_task), then attach_file_to_task with that project, fileId and the task number. Files not attached to a task disappear within a day.',
        images.length
          ? 'You can see the image(s). Describe only what is actually there.'
          : company.llmVision
            ? 'You were not given the image itself: the person did not ask you to look. If they want you to read it, they should say so ("look at it").'
            : 'Image recognition is turned off for this company, so you cannot see the picture — say so plainly if asked about its contents.',
      ].join('\n')
    : ''

  const reply = await completeWithTools(cfg, {
    system: [
      `You are the assistant of the company "${company.name}" in Chatick, talking privately with ${user?.name ?? 'a member'}.`,
      `You work across all projects this person is in: ${projectsList.map((x) => `${x.name} (${x.id})`).join('; ') || 'none yet'}.`,
      screen,
      attachedNote,
      'Project tools take "project" (id or name); omit it to use the project open on the screen. When nothing is open and the person has several projects, ask which one — or answer across all of them with company tools.',
      'ANSWER IN THE LANGUAGE THE PERSON WROTE IN. Do not switch to English because these instructions are in English.',
      'Everything you WRITE INTO a project — task titles and descriptions, notes, comments, hand-off notes — goes in that project\'s language.',
      'THE BALL. Each task is with exactly one person, who owes a move: do, review or answer. my_ball answers "what is on me" and "what am I waiting for". move_ball hands work over; review, return, ask, answer and cancel need a note — ask the person what to write rather than inventing it.',
      'You cannot delete anything — tasks, documents, files, resources. If asked, say so and point to where the person can do it themselves.',
      'CONFIRMATION RULE: never change or move anything that is not plainly what the person asked for. For updates to other people\'s work, state exactly what you will change and wait for a yes. A clear explicit request counts as the yes.',
      'All actions are permission-checked per person and project — on PERMISSION DENIED or REFUSED, explain plainly.',
      'about_chatick answers questions about the product itself — call it instead of guessing.',
      'FORMATTING: markdown renders. Lead with the answer; tables only to compare several items across the same fields; no "Sure!", no restating the question. Be concise.',
    ].join('\n'),
    user: input.text,
    images,
    history,
    tools: [...c.tools, ...p.tools],
    handlers: { ...c.handlers, ...p.handlers },
    maxTokens: 1500,
  })
  if (!reply) return null
  return { text: reply, tools: [...new Set(ctx.used)] }
}

