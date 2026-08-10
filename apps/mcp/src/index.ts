#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { call, BridgeError, type Scope } from './bridge.js'
import { currentScope, connectViaDesktop, startDeviceFlow, waitForApproval, acceptToken, forget } from './auth.js'

/**
 * MCP-сервер Chatick.
 *
 * Зачем он поверх моста, у которого и так есть скил с curl:
 *
 *  — подключение. Токен живёт в сервере, а не набирается кодом каждую сессию:
 *    у кого установлено приложение — доступ выдаётся кнопкой в нём, у
 *    остальных код вводится один раз и переживает перезапуск.
 *
 *  — правила становятся кодом. «Не забудь оценку», «доступ по умолчанию
 *    никому», «?project= обязателен» — в скиле это текст, который можно не
 *    прочитать. Здесь инструмент просто откажет и скажет почему.
 *
 * Чего здесь НЕТ намеренно: ручки на каждую из 85 ручек моста. Их описания
 * забили бы контекст раньше, чем началась бы работа. Ядро — задачи,
 * комментарии, чек-листы, время, ресурсы; для редкого есть bridge_request.
 */

const server = new McpServer({ name: 'chatick', version: '0.1.0' })

/** Ответ инструмента: текст, который читает модель. */
const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const json = (v: unknown) => text(JSON.stringify(v, null, 2))

/**
 * Токен для вызова. Если его нет — не молчим и не падаем, а объясняем, что
 * делать: инструмент, ответивший «Unauthorized», отправляет модель гадать.
 */
async function need(): Promise<Scope> {
  const scope = await currentScope()
  if (!scope) {
    throw new Error('Not connected to Chatick. Call chatick_connect first — it takes a few seconds.')
  }
  return scope
}

/** Ошибку моста показываем как есть: там уже есть и причина, и подсказка. */
function fail(e: unknown): ReturnType<typeof text> {
  if (e instanceof BridgeError) {
    return text(`Chatick refused (${e.status}): ${e.message}${e.hint ? `\nHint: ${e.hint}` : ''}`)
  }
  return text(`Failed: ${e instanceof Error ? e.message : String(e)}`)
}

// --- Подключение -------------------------------------------------------------

server.registerTool(
  'chatick_connect',
  {
    title: 'Connect to Chatick',
    description:
      'Get access to Chatick. Tries the running desktop app first (the human approves in a window, no code to type); ' +
      'falls back to the device flow, where you show them a short code. The token is remembered between sessions, ' +
      'so this is usually a no-op after the first time.',
    inputSchema: {},
  },
  async () => {
    const existing = await currentScope()
    if (existing) {
      return text(
        `Already connected${existing.projectId ? ' (project scope)' : ' (company-wide)'}. ` +
          'Nothing to do — go ahead with the work.',
      )
    }

    const viaApp = await connectViaDesktop()
    if (viaApp) {
      return text(
        `Connected through the Chatick desktop app${viaApp.projectId ? ' (project scope)' : ' (company-wide)'}. ` +
          'No code was needed.',
      )
    }

    // Приложение не отозвалось — обычный случай, а не поломка.
    const started = await startDeviceFlow()
    return text(
      [
        'The desktop app is not running, so this needs one code.',
        '',
        `Tell the human, verbatim: open ${started.verifyUrl} and enter the code ${started.userCode}`,
        '',
        `Then call chatick_finish_connect with deviceCode="${started.deviceCode}".`,
        'It waits for the approval, so call it right away.',
      ].join('\n'),
    )
  },
)

server.registerTool(
  'chatick_finish_connect',
  {
    title: 'Wait for the human to approve access',
    description:
      'Second half of the device flow: waits until the human enters the code. Call it immediately after chatick_connect ' +
      'returned a code. Blocks for up to five minutes.',
    inputSchema: { deviceCode: z.string().describe('The deviceCode from chatick_connect — never show it to the human') },
  },
  async ({ deviceCode }) => {
    const granted = await waitForApproval(deviceCode)
    if (!granted) return text('Not approved: the human declined, or the code expired. Start again with chatick_connect.')
    const scope = acceptToken(granted)
    return text(
      `Connected as ${granted.user?.name ?? 'the human'}${scope.projectId ? ' (project scope)' : ' (company-wide)'}. ` +
        'The token is saved, so next time no code will be needed.',
    )
  },
)

server.registerTool(
  'chatick_disconnect',
  { title: 'Forget the stored access', description: 'Drops the token from memory. Use when handing the machine over.', inputSchema: {} },
  async () => {
    forget()
    return text('Forgotten. The next call will ask for access again.')
  },
)

// --- Что на мне --------------------------------------------------------------

server.registerTool(
  'chatick_inbox',
  {
    title: 'What concerns me right now',
    description:
      'Everything waiting for this person, across every project. Each item carries whatIsAsked — one sentence written ' +
      'for you. Start here for "what is on my plate" rather than listing tasks project by project.',
    inputSchema: {},
  },
  async () => {
    try {
      return json(await call(await need(), 'GET', '/inbox'))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_projects',
  { title: 'Projects I can reach', description: 'Id, name and my permission level per project.', inputSchema: {} },
  async () => {
    try {
      return json(await call(await need(), 'GET', '/projects'))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_members',
  {
    title: 'Who is in the project',
    description:
      'Team of a project with roles and permission levels. Take user ids from here — never invent one. ' +
      'The "resources" level matters before sharing a secret: with "none" a person never even sees the card.',
    inputSchema: { project: z.string().describe('Project id') },
  },
  async ({ project }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'GET', '/members'))
    } catch (e) {
      return fail(e)
    }
  },
)

// --- Задачи ------------------------------------------------------------------

server.registerTool(
  'chatick_tasks',
  {
    title: 'List tasks',
    description:
      'Tasks of a project. Use fields="brief" when you are picking tasks rather than reading them — descriptions are ' +
      'the bulk of the payload. Check "truncated" in the reply before acting on "all of them".',
    inputSchema: {
      project: z.string(),
      assignee: z.string().optional().describe('"me" or a user id'),
      status: z.enum(['todo', 'in_progress', 'review', 'done']).optional(),
      q: z.string().optional().describe('Search in title'),
      fields: z.enum(['brief']).optional(),
      limit: z.number().max(200).optional(),
    },
  },
  async ({ project, ...q }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'GET', '/tasks', undefined, q as never))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_task',
  {
    title: 'Read one task',
    description: 'A task with its description, attachments and dependency counts. Accepts the number ("TASK-81") or the id.',
    inputSchema: { project: z.string(), task: z.string().describe('TASK-81 or the id') },
  },
  async ({ project, task }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'GET', `/tasks/${encodeURIComponent(task)}`))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_task_create',
  {
    title: 'Create a task',
    description:
      'Creates a task. estimateMinutes is required here even though the API allows omitting it: without an estimate ' +
      'nobody can plan a sprint, and the number never gets added later. Write in the language the project speaks. ' +
      'The reply carries a ready "url" — give the human that one, never a link you assembled.',
    inputSchema: {
      project: z.string(),
      title: z.string().min(1),
      description: z.string().optional(),
      assignee: z.string().describe('"me" or a user id from chatick_members'),
      estimateMinutes: z.number().int().positive().describe('Rough is fine; a guess beats nothing'),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      resourceIds: z.array(z.string()).optional().describe('Resources this task needs — link them, never paste secrets'),
    },
  },
  async ({ project, ...body }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'POST', '/tasks', body))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_task_update',
  {
    title: 'Change a task',
    description:
      'Status, assignee, estimate, linked resources. Moving to in_progress belongs BEFORE the work, not after. ' +
      'Every status change deserves a comment: the board says that something moved, only the comment says what.',
    inputSchema: {
      project: z.string(),
      task: z.string(),
      status: z.enum(['todo', 'in_progress', 'review', 'done']).optional(),
      assignee: z.string().optional(),
      estimateMinutes: z.number().int().positive().optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      resourceIds: z.array(z.string()).optional(),
    },
  },
  async ({ project, task, ...body }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'PATCH', `/tasks/${encodeURIComponent(task)}`, body))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_comment',
  {
    title: 'Report on a task',
    description:
      'Adds a comment. This is where results go — what you did, what you verified it with, what is still open. ' +
      'A task finished without a closing comment reads to everyone else as one silently marked done. ' +
      'Mention someone with @[Name](userId); a plain @name is just text.',
    inputSchema: {
      project: z.string(),
      task: z.string(),
      text: z.string().min(1),
      replyTo: z.string().optional().describe('Comment id, when answering a specific one'),
    },
  },
  async ({ project, task, ...body }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'POST', `/tasks/${encodeURIComponent(task)}/comments`, body))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_comments',
  {
    title: 'Read the discussion',
    description:
      'Comments on a task. Read them before acting: the description says what was asked, the comments say what was ' +
      'decided since.',
    inputSchema: { project: z.string(), task: z.string() },
  },
  async ({ project, task }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'GET', `/tasks/${encodeURIComponent(task)}/comments`))
    } catch (e) {
      return fail(e)
    }
  },
)

// --- Чек-лист ----------------------------------------------------------------

server.registerTool(
  'chatick_checklist_add',
  {
    title: 'Break a task into steps',
    description:
      'Adds checklist items. A checklist is a sub-resource: the task must exist first. Tick each item as it is ' +
      'genuinely done, not in a batch at the end — the point is that anyone looking mid-way sees where the work stands.',
    inputSchema: { project: z.string(), task: z.string(), items: z.array(z.string()).min(1) },
  },
  async ({ project, task, items }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'POST', `/tasks/${encodeURIComponent(task)}/checklist`, { items }))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_checklist_tick',
  {
    title: 'Tick a checklist item',
    description: 'Marks one item done or undone. Ticking is reversible — untick if it turns out not to be finished.',
    inputSchema: {
      project: z.string(),
      task: z.string(),
      itemId: z.string(),
      done: z.boolean().default(true),
      note: z.string().optional().describe('When the outcome needs a word'),
    },
  },
  async ({ project, task, itemId, ...body }) => {
    try {
      return json(
        await call({ ...(await need()), projectId: project }, 'PATCH', `/tasks/${encodeURIComponent(task)}/checklist/${itemId}`, body),
      )
    } catch (e) {
      return fail(e)
    }
  },
)

// --- Время -------------------------------------------------------------------

server.registerTool(
  'chatick_timer',
  {
    title: 'Is a timer running',
    description:
      'What is running right now, across every project of this person. Nothing running — offer to start one. ' +
      'Something running — leave it alone: stopping is the human decision and theirs alone.',
    inputSchema: { project: z.string() },
  },
  async ({ project }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'GET', '/time/running'))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_timer_start',
  {
    title: 'Start a timer',
    description:
      'Starts tracking. Only after the human agreed — their hours are how the work gets counted, but starting one ' +
      'behind their back puts wrong numbers in a report.',
    inputSchema: {
      project: z.string(),
      task: z.string().optional().describe('TASK-81, when the work belongs to one'),
      description: z.string().optional(),
    },
  },
  async ({ project, ...body }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'POST', '/time/start', body))
    } catch (e) {
      return fail(e)
    }
  },
)

// --- Ресурсы -----------------------------------------------------------------

server.registerTool(
  'chatick_resource_create',
  {
    title: 'Store a link or credentials',
    description:
      'Creates a resource: a link plus optional secrets under it. Link it to the task instead of pasting a password ' +
      'into a description — a pasted one is readable by everyone who sees the task and cannot be taken back. ' +
      'IMPORTANT: created this way, it is shared with NOBODY but the author. Name the people in "viewers" or the ' +
      'human you made it for cannot open it — and say out loud who you gave it to. ' +
      'Do not go hunting for secrets to save: store what the human handed you for that purpose, never values you ' +
      'happened to read in a .env or a log.',
    inputSchema: {
      project: z.string(),
      name: z.string().optional(),
      url: z.string().optional(),
      description: z.string().optional(),
      secrets: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
      viewers: z.array(z.string()).optional().describe('User ids who may reveal the secrets; check their "resources" level first'),
    },
  },
  async ({ project, ...body }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'POST', '/resources', body))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_resources',
  {
    title: 'List resources',
    description: 'Links and credentials of a project. "canSeeSecrets" says whether the secrets under each are open to you.',
    inputSchema: { project: z.string() },
  },
  async ({ project }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'GET', '/resources'))
    } catch (e) {
      return fail(e)
    }
  },
)

// --- Всё остальное -----------------------------------------------------------

server.registerTool(
  'chatick_request',
  {
    title: 'Any other bridge endpoint',
    description:
      'Raw call to the Chatick bridge, for the endpoints without a dedicated tool here: sprints, documents, blockers, ' +
      'files, chat, notes. Read GET /x/guide first — it lists every path and the exact permissions of this person. ' +
      'Paths start with a slash and omit the /x prefix: "/sprints", "/documents/<id>/append".',
    inputSchema: {
      method: z.enum(['GET', 'POST', 'PATCH', 'DELETE']),
      path: z.string().describe('e.g. /sprints or /documents/abc/append'),
      project: z.string().optional().describe('Required on a company-wide connection'),
      body: z.record(z.unknown()).optional(),
    },
  },
  async ({ method, path, project, body }) => {
    try {
      const scope = await need()
      return json(await call({ ...scope, projectId: project ?? scope.projectId }, method, path, body))
    } catch (e) {
      return fail(e)
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
