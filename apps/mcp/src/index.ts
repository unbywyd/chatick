#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { call, upload, BridgeError, type Scope } from './bridge.js'
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
 * комментарии, чек-листы, время, ресурсы; для редкого есть chatick_request.
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

/**
 * Область доступа словами — для ответа человеку.
 *
 * Раньше здесь было «есть проект или нет», и мастер-туннель назывался
 * «company-wide»: модель считала, что открыта одна компания, и не искала
 * проекты в остальных. Разница между «вся компания» и «все компании» для
 * работы существенная, поэтому она названа прямо.
 */
function scopeWords(s: Scope): string {
  if (s.kind === 'all') return '(master access: every company and project you are in)'
  if (s.projectId) return '(one project)'
  return '(one whole company)'
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
      return text(`Already connected ${scopeWords(existing)}. Nothing to do — go ahead with the work.`)
    }

    const viaApp = await connectViaDesktop()
    if (viaApp) {
      return text(`Connected through the Chatick desktop app ${scopeWords(viaApp)}. No code was needed.`)
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
      `Connected as ${granted.user?.name ?? 'the human'} ${scopeWords(scope)}. ` +
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
  'chatick_mentions',
  {
    title: 'Where I was asked personally',
    description:
      'Only the things addressed to this person directly — mentions in comments, chat and notes, plus tasks assigned ' +
      'to them. CHECK THIS FIRST, before chatick_inbox: "someone closed their own task" and "a person asked me a ' +
      'question and is waiting" carry different weight, and in one shared list the second drowns in the first. ' +
      'Every item carries a ready url. Once you have handled one, clear it with chatick_inbox_read — anything you ' +
      'leave here stays on the person as an unread counter for work you already did.',
    inputSchema: {
      unread: z.boolean().optional().describe('Only unanswered ones (default true)'),
      since: z.string().optional().describe('ISO timestamp — only what came after it'),
    },
  },
  async ({ unread, since }) => {
    try {
      return json(await call(await need(), 'GET', '/mentions', undefined, { unread: unread === false ? '0' : undefined, since }))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_inbox',
  {
    title: 'What concerns me right now',
    description:
      'Everything waiting for this person, across every project. Each item carries whatIsAsked — one sentence written ' +
      'for you, and a ready url. Start here for "what is on my plate" rather than listing tasks project by project — ' +
      'but for "did anyone ask ME something" use chatick_mentions, which is a much shorter list. ' +
      'Pass since to ask only for what arrived after a moment you already saw. ' +
      'Clear whatever you handle with chatick_inbox_read, or the person is left with a counter for finished work.',
    inputSchema: { since: z.string().optional().describe('ISO timestamp — only what came after it') },
  },
  async ({ since }) => {
    try {
      return json(await call(await need(), 'GET', '/inbox', undefined, { since }))
    } catch (e) {
      return fail(e)
    }
  },
)

/**
 * Вторая половина двух ручек выше.
 *
 * Их и добавляли ради «проверь, что там»: агент читает адресованное человеку и
 * отвечает. Но разобрать и не погасить — значит оставить человеку счётчик за
 * работу, которая уже сделана. Он видит цифру, которая не убирается ничем, и
 * идёт спрашивать, не сломалось ли приложение.
 *
 * Правило записано и в hint ответа, и в гайде — и всё равно не выполнялось:
 * поведение задают описания инструментов, а не поле JSON с адресом ручки.
 * Поэтому здесь отдельный инструмент, вопреки общему правилу файла (см. шапку):
 * это не восемьдесят пятая редкая ручка, а обязательное продолжение уже
 * существующей.
 *
 * `task` — главный параметр: id задачи у агента уже есть, а id уведомлений о
 * ней ему пришлось бы добывать отдельным запросом.
 */
server.registerTool(
  'chatick_inbox_read',
  {
    title: 'Clear what I have handled',
    description:
      'Mark notifications read. ALWAYS call this after handling what chatick_mentions or chatick_inbox returned — ' +
      'otherwise the person keeps seeing a counter for work that is already done, and cannot tell it apart from ' +
      'what still needs them. Pass task=<id> to clear everything about one task at once: assigned, mentioned and ' +
      'commented are separate notifications, and clearing them one by one is work nobody does. ids clears specific ' +
      'ones, all=true clears everything waiting.',
    inputSchema: {
      task: z.string().optional().describe('Task id — clears every notification about that task'),
      ids: z.array(z.string()).optional().describe('Notification ids from chatick_mentions / chatick_inbox'),
      all: z.boolean().optional().describe('Clear everything unread'),
      project: z.string().optional().describe('Required on a company-wide connection'),
    },
  },
  async ({ task, ids, all, project }) => {
    if (!task && !ids?.length && !all) {
      return text('Nothing to clear: pass task=<id>, ids=[...] or all=true.')
    }
    try {
      const scope = await need()
      const body = task ? { entityType: 'task', entityId: task } : all ? { all: true } : { ids }
      await call({ ...scope, projectId: project ?? scope.projectId }, 'POST', '/inbox/read', body)
      return text(task ? `Cleared every notification about task ${task}.` : all ? 'Cleared everything.' : `Cleared ${ids!.length}.`)
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_releases',
  {
    title: 'What shipped and where',
    description:
      'Versions of a project with their current stage. The reply carries "live" — what reached people, per build type: ' +
      'that is the answer to "which version is in production", and you do not have to work it out from the list. ' +
      'It also carries "buildTypes" with every stage ladder, because each platform has its own (iOS has an Apple ' +
      'review step, Android does not). Returns 404 when the project has not enabled releases — that is a setting, ' +
      'not a bug.',
    inputSchema: { project: z.string() },
  },
  async ({ project }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'GET', '/releases'))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_release_create',
  {
    title: 'Register a version',
    description:
      'Record a build: version string, buildType (ios | android | web | backend | desktop | other) and optionally the ' +
      'stage it starts at. Without a status it starts at the first stage of that ladder. referenceUrl is where the ' +
      'build actually lives — Expo, GitHub, the store listing. Requires releases.manage.',
    inputSchema: {
      project: z.string(),
      version: z.string().min(1).describe('"1.4.0" — as the team calls it'),
      appName: z
        .string()
        .optional()
        .describe('WHICH app: "Client", "Provider". A project often ships several; buildType does not tell them apart'),
      buildType: z.enum(['ios', 'android', 'web', 'backend', 'desktop', 'other']),
      status: z.string().optional().describe('Stage key; omit to start at the first one'),
      buildProfile: z
        .enum(['development', 'preview', 'production'])
        .optional()
        .describe('What it is built WITH (eas build --profile) — not the same as the stage, which is where it got to'),
      referenceUrl: z.string().optional().describe('Where the build lives: Expo, GitHub, store'),
      notes: z.string().optional().describe("What's new — for the team"),
      comment: z.string().optional().describe('First line of the history'),
    },
  },
  async ({ project, ...body }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'POST', '/releases', body))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_release_request',
  {
    title: 'Ask someone for a build',
    description:
      'The usual case: a manager does not "create a version", they ASK a person to build one. This makes the task, ' +
      'the version and the link between them in ONE call — three separate calls can break in the middle and leave a ' +
      'task with no version. The assignee is notified like for any other task. Use chatick_release_create instead ' +
      'only to register something that is ALREADY built, when there is nobody to ask.',
    inputSchema: {
      project: z.string(),
      version: z.string().min(1).describe('"1.4.0" — as the team calls it'),
      appName: z.string().optional().describe('WHICH app: "Client", "Provider"'),
      buildType: z.enum(['ios', 'android', 'web', 'backend', 'desktop', 'other']),
      assignee: z.string().optional().describe('"me" or a user id from chatick_members'),
      comment: z.string().optional().describe('What exactly is needed — goes into the task and the history'),
      buildProfile: z.enum(['development', 'preview', 'production']).optional().describe('What it is built WITH'),
      estimateMinutes: z.number().int().positive().optional(),
    },
  },
  async ({ project, ...body }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'POST', '/releases/request', body))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_expo_connect',
  {
    title: 'Connect Expo (EAS) to a project',
    description:
      'Makes EAS report every build to Chatick by itself: the version appears with links to the artifact and the ' +
      'build logs, and moves off "building" on its own. Returns a ready `command` — give it to the human to run IN ' +
      'THE APP FOLDER. Several apps (client, provider) each need it in their own folder; one secret covers all, they ' +
      'are told apart by build name. Calling it twice is safe: same secret, so it cannot break a configured webhook. ' +
      'Only the BUILD arrives automatically — TestFlight, review and release are still marked by a human.',
    inputSchema: { project: z.string() },
  },
  async ({ project }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'POST', '/integrations/expo'))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_release_stage',
  {
    title: 'Move a version to another stage',
    description:
      'Advance or roll back a version, e.g. testflight -> in_review -> released. The comment is REQUIRED and is the ' +
      'point of the whole thing: "why has 1.4 been in Apple review for a week" has no answer if each transition ' +
      'overwrites the last silently. Read chatick_releases first for the valid stage keys of this build type.',
    inputSchema: {
      project: z.string(),
      release: z.string().describe('Release id from chatick_releases'),
      status: z.string().describe('Stage key from that build type ladder'),
      comment: z.string().min(1).describe('What actually happened — required'),
    },
  },
  async ({ project, release, ...body }) => {
    try {
      return json(
        await call({ ...(await need()), projectId: project }, 'POST', `/releases/${encodeURIComponent(release)}/stage`, body),
      )
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
    description:
      'A task with its description, attachments and dependency counts. Accepts the number ("TASK-81") or the id. ' +
      'Includes "shortUrl" — the link to give a person when they ask where the task is.',
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
      'To pull someone into the description write @[Name](userId) — a plain @name is text and notifies nobody. ' +
      'The assignee already learns of the assignment; mention others only when they specifically need to see it. ' +
      'The reply carries ready links — never assemble one yourself. Prefer "shortUrl" (chatick.com/t-AbC12) when sending ' +
      'the task to a person: the long "url" is 90 characters, wraps badly in chat and breaks card layouts.',
    inputSchema: {
      project: z.string(),
      title: z.string().min(1),
      description: z.string().optional(),
      assignee: z.string().describe('"me" or a user id from chatick_members'),
      estimateMinutes: z.number().int().positive().describe('Rough is fine; a guess beats nothing'),
      dueDate: z
        .string()
        .optional()
        .describe('Due date "2026-09-14". Only when the person named one — never invent a deadline'),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      resourceIds: z.array(z.string()).optional().describe('Resources this task needs — link them, never paste secrets'),
      releaseIds: z.array(z.string()).optional().describe('Versions this task ships in — ids from chatick_releases'),
      links: z
        .array(z.union([z.string(), z.object({ task: z.string(), kind: z.enum(['derived', 'related']) })]))
        .optional()
        .describe(
          'Tasks this one grew out of: ["TASK-3"], or [{"task":"TASK-9","kind":"related"}] for a sibling. ' +
            'Use it whenever you split one task into several — link each new task back to the original in the ' +
            'same call, because a second call is the one you forget. NOT blockers: links hold nothing back.',
        ),
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
      'Status, assignee, estimate, linked resources, related tasks. Moving to in_progress belongs BEFORE the work, ' +
      'not after. Every status change deserves a comment: the board says that something moved, only the comment ' +
      'says what.',
    inputSchema: {
      project: z.string(),
      task: z.string(),
      status: z.enum(['todo', 'in_progress', 'review', 'done']).optional(),
      assignee: z.string().optional(),
      estimateMinutes: z.number().int().positive().optional(),
      dueDate: z
        .string()
        .optional()
        .describe('Due date "2026-09-14". Only when the person named one — never invent a deadline'),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      resourceIds: z.array(z.string()).optional(),
      releaseIds: z.array(z.string()).optional().describe('Versions this task ships in — ids from chatick_releases'),
      links: z
        .array(z.union([z.string(), z.object({ task: z.string(), kind: z.enum(['derived', 'related']) })]))
        .optional()
        .describe(
          'Tasks this one grew out of: ["TASK-3"], or [{"task":"TASK-9","kind":"related"}] for a sibling. ' +
            'ADDS links, never replaces them — removing one is a separate call (DELETE /tasks/<id>/links/<linkId> ' +
            'via chatick_request). NOT blockers: links hold nothing back.',
        ),
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
  'chatick_resource_update',
  {
    title: 'Change a resource',
    description:
      'Edits an existing resource: name, address, description, or who may see its secrets. Use it instead of ' +
      'creating a second resource with the fix — a duplicate means the secrets get re-entered by hand, every task ' +
      'linked to the old one keeps pointing at it, and somebody has to delete the leftover. Only the fields you ' +
      'pass are changed. Descriptions render as markdown.',
    inputSchema: {
      project: z.string(),
      resourceId: z.string(),
      name: z.string().optional(),
      url: z.string().optional(),
      description: z.string().optional(),
      viewers: z
        .array(z.string())
        .optional()
        .describe('User ids who may reveal the secrets. Replaces the list; only the author may change it'),
    },
  },
  async ({ project, resourceId, ...body }) => {
    try {
      return json(
        await call(
          { ...(await need()), projectId: project },
          'PATCH',
          `/resources/${encodeURIComponent(resourceId)}`,
          body,
        ),
      )
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_timer_stop',
  {
    title: 'Stop the running timer',
    description:
      'Stops whatever timer is running for this person — including one left running in a different project, which ' +
      'is the usual reason hours look wrong at the end of a day. Returns what was stopped and how long it ran.',
    inputSchema: { project: z.string(), description: z.string().optional().describe('What the time went on') },
  },
  async ({ project, ...body }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'POST', '/time/stop', body))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_time_log',
  {
    title: 'Log time after the fact',
    description:
      'Records work that already happened — the timer was never started, or was started an hour late. Both ends are ' +
      'ISO timestamps. Log ONLY what the person told you: invented hours are worse than missing ones, because ' +
      'somebody bills by them.',
    inputSchema: {
      project: z.string(),
      startedAt: z.string().describe('ISO timestamp, e.g. 2026-08-19T09:00:00Z'),
      endedAt: z.string().describe('ISO timestamp'),
      description: z.string().optional(),
      task: z.string().optional().describe('Task number, e.g. TASK-81'),
    },
  },
  async ({ project, ...body }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'POST', '/time', body))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_time_list',
  {
    title: 'Time entries',
    description:
      'Entries of this project for a period. Yours by default; project leads see everyone unless mine=true. Use it ' +
      'to find the id of an entry that needs fixing.',
    inputSchema: {
      project: z.string(),
      from: z.string().optional().describe('ISO date, e.g. 2026-08-01'),
      to: z.string().optional(),
      task: z.string().optional().describe('Only entries on this task number'),
      mine: z.boolean().optional().describe('Only your own entries'),
    },
  },
  async ({ project, mine, ...q }) => {
    try {
      return json(
        await call({ ...(await need()), projectId: project }, 'GET', '/time', undefined, {
          ...q,
          ...(mine ? { mine: '1' } : {}),
        }),
      )
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_time_update',
  {
    title: 'Fix a time entry',
    description:
      'Corrects an entry: its description, when it started or ended, the task it belongs to, or THE PROJECT. ' +
      'Moving between projects is the case this exists for — "I worked on one thing but the timer was running on ' +
      'another" happens to everyone, and without this the tracker stops matching reality. Moving an entry drops ' +
      'its task link, because that task lives in the project you are leaving. Only the fields you pass change. ' +
      'Someone else\'s entry needs tasks.edit.',
    inputSchema: {
      project: z.string().describe('Project the entry is in NOW'),
      entryId: z.string(),
      description: z.string().optional(),
      startedAt: z.string().optional().describe('ISO timestamp'),
      endedAt: z.string().optional().describe('ISO timestamp'),
      task: z.string().optional().describe('Task number in the target project'),
      moveToProject: z.string().optional().describe('Project id to move this entry to'),
    },
  },
  async ({ project, entryId, moveToProject, ...body }) => {
    try {
      return json(
        await call(
          { ...(await need()), projectId: project },
          'PATCH',
          `/time/${encodeURIComponent(entryId)}`,
          { ...body, ...(moveToProject ? { project: moveToProject } : {}) },
        ),
      )
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_time_report',
  {
    title: 'Time report',
    description:
      'Hours for a period, grouped by person and by task. Answers "how much went into this" without adding entries ' +
      'up by hand.',
    inputSchema: {
      project: z.string(),
      from: z.string().optional().describe('ISO date'),
      to: z.string().optional(),
    },
  },
  async ({ project, ...q }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'GET', '/time/report', undefined, q))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_upload',
  {
    title: 'Upload a file',
    description:
      'Uploads a file from this machine to Chatick. Give it the path — reading the file, the multipart body and ' +
      'the token are handled for you; there is no curl to assemble and no token to fetch. ' +
      'With "resourceId" the file is stored UNDER THAT RESOURCE: encrypted at rest, visible only to people who ' +
      'may see its secrets, and never listed among project files. That is where a keystore, a certificate or a ' +
      'private key belongs — an Android signing key cannot be reissued for an app already published, so a ' +
      'resource holding only the password protects nothing. ' +
      'Without "resourceId" it goes to project files, where the whole team sees it: right for a build, a ' +
      'screenshot or a log, wrong for anything that unlocks something.',
    inputSchema: {
      project: z.string(),
      path: z.string().describe('Absolute path to the file on this machine'),
      resourceId: z
        .string()
        .optional()
        .describe('Store under this resource, encrypted. Omit for ordinary project files'),
      taskId: z.string().optional().describe('Attach to a task — project files only, ignored with resourceId'),
    },
  },
  async ({ project, path: filePath, resourceId, taskId }) => {
    try {
      const { readFile } = await import('node:fs/promises')
      const { basename } = await import('node:path')
      let bytes: Buffer
      try {
        bytes = await readFile(filePath)
      } catch {
        // Отдельная ветка: «файла нет» — ошибка человека, и она должна
        // читаться как таковая, а не как отказ сервера.
        return fail(new Error(`Cannot read file: ${filePath}`))
      }
      const scope = { ...(await need()), projectId: project }
      const file = { name: basename(filePath), bytes: new Uint8Array(bytes) }
      return json(
        resourceId
          ? await upload(scope, `/resources/${encodeURIComponent(resourceId)}/files`, file)
          : await upload(scope, '/files', file, taskId ? { taskId } : undefined),
      )
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_resource_file_remove',
  {
    title: 'Remove a file from a resource',
    description:
      'Deletes one file kept under a resource — the encrypted object leaves storage too. Use it to undo your own ' +
      'mistake: attaching the wrong file and leaving it there means somebody else has to clean up, and a stray ' +
      'keystore is exactly the kind of leftover nobody wants to inherit.',
    inputSchema: { project: z.string(), resourceId: z.string(), fileId: z.string() },
  },
  async ({ project, resourceId, fileId }) => {
    try {
      return json(
        await call(
          { ...(await need()), projectId: project },
          'DELETE',
          `/resources/${encodeURIComponent(resourceId)}/files/${encodeURIComponent(fileId)}`,
        ),
      )
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_resource_files',
  {
    title: 'Files kept under a resource',
    description:
      'Lists files attached to a resource: keystore, certificate, private key. Name and size only — never the ' +
      'contents. These files are encrypted at rest and never appear in project files, which is the point: a ' +
      'signing key cannot be reissued for an app that is already published, so "password saved, file not saved" ' +
      'is a false sense of safety.',
    inputSchema: { project: z.string(), resourceId: z.string() },
  },
  async ({ project, resourceId }) => {
    try {
      return json(
        await call(
          { ...(await need()), projectId: project },
          'GET',
          `/resources/${encodeURIComponent(resourceId)}/files`,
        ),
      )
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_task_resources',
  {
    title: 'Access a task needs',
    description:
      'Resources linked to a task: staging URLs, keys, databases — name and address only. Secret VALUES are never ' +
      'returned: reading one is a separate, deliberate call, and it stays that way because a password that passed ' +
      'through here would end up in your context and in the chat history, where it outlives the conversation and ' +
      'cannot be revoked.',
    inputSchema: { project: z.string(), task: z.string() },
  },
  async ({ project, task }) => {
    try {
      return json(
        await call({ ...(await need()), projectId: project }, 'GET', `/tasks/${encodeURIComponent(task)}/resources`),
      )
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_task_resource_link',
  {
    title: 'Give a task the access it needs',
    description:
      'Links existing resources (ids from chatick_resources) to a task. ADDS them without touching what is already ' +
      'linked — unlike the "resourceIds" field, which replaces the whole list and silently wipes links somebody ' +
      'else made. Link the resource instead of pasting an address or a password into the task description: text in ' +
      'a description is readable by everyone who can see the task and cannot be taken back.',
    inputSchema: {
      project: z.string(),
      task: z.string(),
      resources: z.array(z.string()).min(1).describe('Resource ids from chatick_resources'),
    },
  },
  async ({ project, task, resources }) => {
    try {
      return json(
        await call({ ...(await need()), projectId: project }, 'POST', `/tasks/${encodeURIComponent(task)}/resources`, {
          resources,
        }),
      )
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_task_resource_unlink',
  {
    title: 'Remove one access from a task',
    description:
      'Unlinks one resource from a task. Other links stay, and the resource itself keeps existing in the project.',
    inputSchema: { project: z.string(), task: z.string(), resourceId: z.string() },
  },
  async ({ project, task, resourceId }) => {
    try {
      return json(
        await call(
          { ...(await need()), projectId: project },
          'DELETE',
          `/tasks/${encodeURIComponent(task)}/resources/${encodeURIComponent(resourceId)}`,
        ),
      )
    } catch (e) {
      return fail(e)
    }
  },
)

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
      'task links (GET/POST /tasks/<id>/links, DELETE /tasks/<id>/links/<linkId> — links say where a task came from, ' +
      'they never block anything), ' +
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

server.registerTool(
  'chatick_report',
  {
    title: 'Send the Chatick team a request, an idea or a bug',
    description:
      'Send the Chatick team a request, an idea, a complaint or a bug — about CHATICK ITSELF. ' +
      'USE IT WHENEVER SOMEONE WANTS SOMETHING THE PRODUCT DOES NOT DO, or finds something awkward, confusing or broken. ' +
      'A person asking "can it also…" IS a report: do not answer "there is no such thing" and move on — say you will pass ' +
      'it on, and pass it on. Help them phrase it: ask what exactly is missing and what they were trying to do, then send that. ' +
      'A human reads these and nothing is implemented automatically, so never promise a fix or a date. Send what the PERSON ' +
      'said, not ideas of your own, and never anything about their own project or team — that belongs in tasks and notes.',
    inputSchema: {
      kind: z
        .enum(['missing', 'bug', 'request', 'docs'])
        .describe('request — someone wants something Chatick does not do (the most common); bug — behaved unlike the guide; missing — no endpoint for it; docs — guide is wrong'),
      body: z.string().describe('What they want or what went wrong, in their words. At least a sentence or two.'),
      context: z
        .string()
        .optional()
        .describe('What was being attempted when it came up. Without it half the reports cannot be acted on.'),
    },
  },
  async ({ kind, body, context }) => {
    try {
      const scope = await need()
      // Проект не передаём: репорт к нему не привязан, и на туннеле без
      // выбранного проекта это была бы единственная причина отказа.
      const res = await call<{ id: string; note?: string }>({ token: scope.token }, 'POST', '/report', {
        kind,
        body,
        context,
        client: 'Claude Code (MCP)',
      })
      return text(
        `Sent to the Chatick team (${res.id}). It is read by a human, not implemented automatically — ` +
          'tell the person it was passed on, and do not promise a fix or a date.',
      )
    } catch (e) {
      return fail(e)
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
