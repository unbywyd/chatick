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
      'The "mentions" branch of chatick_inbox, on its own: things addressed to this person directly — mentions in ' +
      'comments, chat and notes, plus tasks assigned to them. These are the ones with someone waiting on the other ' +
      'end, so they are worth reading in full. Start at chatick_inbox anyway — its branch counts tell you whether ' +
      'there is anything here before you ask. Every item carries a ready url. Once you have handled one, clear it ' +
      'with chatick_inbox_read — anything you leave here stays on the person as an unread counter for work you ' +
      'already did.',
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
      'THE entry point for "what is waiting for me", "did anyone answer me", "anything new" — one call, every ' +
      'project. Do not go looking anywhere else first. The answer opens with "branches": what kind of thing is ' +
      'waiting, how much of it, and the call that opens each kind — most urgent first, and only kinds that ' +
      'actually have something. Open a branch only when its count says there is something in it. ' +
      'branch "answers" means someone replied inside a task checklist — those replies surface nowhere else. ' +
      '"items" carries the newest in full: whatIsAsked is one sentence saying what the person is expected to do. ' +
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

server.registerTool(
  'chatick_member_add',
  {
    title: 'Add someone to the project',
    description:
      'Adds a person to the project. Pass userId for someone already in the company — take it from ' +
      'chatick_members on another project, never invent one. Pass email instead to invite someone from ' +
      'outside: they get one invitation that puts them in the company AND this project, so nobody has to ' +
      'be added twice. Inviting from outside needs a company admin.',
    inputSchema: {
      project: z.string().describe('Project id'),
      userId: z.string().optional().describe('Existing company member'),
      email: z.string().optional().describe('Invite someone who is not in the company yet'),
      role: z.enum(['admin', 'member']).optional().describe('Role in the project; defaults to member'),
      companyRole: z
        .enum(['admin', 'manager', 'member'])
        .optional()
        .describe('Role in the company for an invited person; defaults to member'),
    },
  },
  async ({ project, userId, email, role, companyRole }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'POST', '/members', { userId, email, role, companyRole }))
    } catch (e) {
      return fail(e)
    }
  },
)

/**
 * Домены прав. Дубль списка из PERMISSION_DOMAINS (apps/api/routes/projects.ts):
 * mcp — отдельный пакет и импортировать оттуда не может.
 *
 * За расхождением следит member-role-domains.test.ts: домен, добавленный на
 * сервере и забытый здесь, роняет тест. Без этого сторожа повторилась бы уже
 * случившаяся история с releases — поле молча выбрасывалось, ручка отвечала
 * ok, а уровень не менялся.
 */
const PERMISSION_DOMAINS = ['tasks', 'files', 'resources', 'documents', 'notes', 'releases'] as const
const levelEnum = z.enum(['none', 'read', 'write', 'crud'])

server.registerTool(
  'chatick_member_role',
  {
    title: 'Change what someone may do',
    description:
      'Changes a project role, per-area access levels, job title and area of responsibility. ' +
      'Pass only what changes — everything omitted stays as it was. ' +
      'Levels per area: none (does not even see the tab) < read < write (create and edit) < crud (also delete). ' +
      'CHANGING role RESETS every level to that role\'s defaults, so pass permissions in the SAME call to keep ' +
      'exceptions — a separate later call would be overwritten. Current values come from chatick_members. ' +
      'The project owner cannot be changed — every project has exactly one, and in many of them they are the ' +
      'only person who can hand rights back.',
    inputSchema: {
      project: z.string().describe('Project id'),
      userId: z.string().describe('Who to change — id from chatick_members'),
      role: z.enum(['admin', 'member']).optional().describe('New role in the project; resets levels to its defaults'),
      permissions: z
        .object(Object.fromEntries(PERMISSION_DOMAINS.map((d) => [d, levelEnum.optional()])) as Record<
          (typeof PERMISSION_DOMAINS)[number],
          z.ZodOptional<typeof levelEnum>
        >)
        .optional()
        .describe('Access level per area; omitted areas keep their level'),
      jobTitle: z.string().optional().describe('Job title in this project; empty string falls back to the company one'),
      responsibility: z
        .string()
        .optional()
        .describe('What this person answers for here; empty string falls back to the company one'),
    },
  },
  async ({ project, userId, role, permissions, jobTitle, responsibility }) => {
    // Пустой вызов сервер отвергает ошибкой «Nothing to change» — не тратим
    // на него поход по сети и говорим то же самое сразу.
    if (role === undefined && !permissions && jobTitle === undefined && responsibility === undefined) {
      return fail(new Error('Nothing to change: pass role, permissions, jobTitle or responsibility'))
    }
    try {
      return json(
        await call({ ...(await need()), projectId: project }, 'PATCH', `/members/${userId}`, {
          role,
          permissions,
          jobTitle,
          responsibility,
        }),
      )
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_member_remove',
  {
    title: 'Remove someone from the project',
    description:
      'Takes a person out of THIS project. They stay in the company — leaving it is a decision of another ' +
      'level and is not done from here. The owner cannot be removed. Ask the human first: losing access ' +
      'mid-work is disruptive, and putting someone back does not restore what they were doing.',
    inputSchema: {
      project: z.string().describe('Project id'),
      userId: z.string().describe('Who to remove — id from chatick_members'),
    },
  },
  async ({ project, userId }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'DELETE', `/members/${userId}`))
    } catch (e) {
      return fail(e)
    }
  },
)

/**
 * Роль и должность НА УРОВНЕ КОМПАНИИ.
 *
 * Инструментов было два — оба проектные. Просьба «расставь роли всем: Таль —
 * CEO, Ханан — QA» выполнялась по одному проекту за раз или не выполнялась
 * вовсе, хотя должность по природе общая: человек бэкендер и здесь, и там.
 */
server.registerTool(
  'chatick_company_members',
  {
    title: 'Who is in the company',
    description:
      'Everyone in the company with their COMPANY-wide role and job title. Different from chatick_members, which is ' +
      'the team of one project. Job titles live at company level and every project inherits them, so "who is our QA" ' +
      'is answered here.',
    inputSchema: {
      project: z.string().optional().describe('Any project of the company; needed on a project-scoped connection'),
    },
  },
  async ({ project }) => {
    try {
      const scope = await need()
      return json(await call({ ...scope, projectId: project ?? scope.projectId }, 'GET', '/company/members'))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_company_member_role',
  {
    title: 'Set a company-wide role or job title',
    description:
      'Changes what someone is IN THE COMPANY: job title, area of responsibility, and role. Pass only what changes. ' +
      'jobTitle set here is inherited by every project that has not set its own — this is the one to use when asked ' +
      'to give people titles like CEO, PM, QA or Developer. ' +
      'CAUTION with role: "manager" and "admin" can see EVERY project of the company, including ones the person was ' +
      'never added to. Job titles describe, roles grant — ask the human before raising one. Requires company admin.',
    inputSchema: {
      userId: z.string().describe('Who to change — id from chatick_company_members'),
      jobTitle: z.string().optional().describe('CEO, PM, QA, Backend developer — inherited by all projects'),
      responsibility: z.string().optional().describe('What this person answers for across the company'),
      role: z
        .enum(['admin', 'manager', 'member'])
        .optional()
        .describe('Company role. admin/manager see every project — confirm with the human first'),
      project: z.string().optional().describe('Any project of the company; needed on a project-scoped connection'),
    },
  },
  async ({ userId, jobTitle, responsibility, role, project }) => {
    if (jobTitle === undefined && responsibility === undefined && role === undefined) {
      return fail(new Error('Nothing to change: pass jobTitle, responsibility or role'))
    }
    try {
      const scope = await need()
      return json(
        await call({ ...scope, projectId: project ?? scope.projectId }, 'PATCH', `/company/members/${userId}`, {
          jobTitle,
          responsibility,
          role,
        }),
      )
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_members_available',
  { title: 'Who could be added', description: 'People in the company who are not in this project yet.', inputSchema: { project: z.string().describe('Project id') } },
  async ({ project }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'GET', '/members/available'))
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
      status: z.enum(['todo', 'in_progress', 'review', 'verified', 'done']).optional(),
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
  'chatick_task_by_link',
  {
    title: 'Open a task by link',
    description:
      'Read a task from whatever the person pasted: a short link (https://chatick.com/t-abc12), a full app URL ' +
      '(.../p/<project>/tasks/<id>) or a bare number (TASK-81). Use this the moment someone drops a link and asks ' +
      'about it — do NOT try to pull the project and id out of the URL yourself. A short link cannot be read from ' +
      'the outside at all: it carries only a code, and what stands behind it is known to the server. ' +
      'The reply names the project it landed in, so the next call has what it needs. ' +
      'A bare number needs the project: pass it, or use this inside a project tunnel.',
    inputSchema: {
      link: z.string().describe('A task link or TASK-81'),
      project: z.string().optional().describe('Only for a bare number — links carry the project themselves'),
    },
  },
  async ({ link, project }) => {
    try {
      const scope = await need()
      return json(
        await call(
          { ...scope, ...(project ? { projectId: project } : {}) },
          'GET',
          '/open',
          undefined,
          { link },
        ),
      )
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
      'Includes "shortUrl" — the link to give a person when they ask where the task is. ' +
      'When the task has a checklist you also get "checklist": {total, done, answered}. "answered" above "done" ' +
      'means questions in it were answered but the boxes are still open — read those answers with ' +
      'chatick_checklist; they appear nowhere else.',
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
      'not after. When the work is done move it to review, not to done: you are handing it over, and closing ' +
      'your own work skips the person who has to check it. verified belongs to whoever did the checking — never ' +
      'set it on your own work. Every status change deserves a comment: the board says that something moved, ' +
      'only the comment says what.',
    inputSchema: {
      project: z.string(),
      task: z.string(),
      status: z.enum(['todo', 'in_progress', 'review', 'verified', 'done']).optional(),
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

/**
 * «Где та таска, где я писал» — вопрос, на который до этого ответить было
 * нечем: chatick_tasks ищет внутри одного проекта, а люди состоят в 8-20.
 */
server.registerTool(
  'chatick_search_tasks',
  {
    title: 'Find a task by what it was about',
    description:
      'Finds a task ACROSS EVERY PROJECT this person is in, by MEANING rather than words: "payment fails" finds a ' +
      'Hebrew task about a broken payment iframe with no shared word. ' +
      'Comments are indexed together with their task, so "where did we discuss X", "which task was that in", ' +
      '"I wrote about it somewhere" land on the task holding the discussion — that is what this is for. ' +
      'Use chatick_tasks instead when you already know the project and want to list or filter its tasks; use this ' +
      'when the project is exactly what you are trying to remember. Items found by meaning carry ' +
      'matchedBy="meaning" — they may share no word with your query.',
    inputSchema: {
      query: z.string().describe('Ask in plain words — do not guess the exact wording someone used'),
      project: z.string().optional().describe('Narrow to one project; omit to search all of them'),
      limit: z.number().optional(),
    },
  },
  async ({ query, project, limit }) => {
    try {
      const scope = await need()
      return json(
        await call(scope, 'GET', '/search/tasks', undefined, {
          q: query,
          project,
          limit: limit ? String(limit) : undefined,
        }),
      )
    } catch (e) {
      return fail(e)
    }
  },
)

// --- Журнал проекта / база знаний ---------------------------------------------

/**
 * Заметок в мосту шесть ручек, а инструментов не было ни одного.
 *
 * Ровно та же история, что вчера с чек-листом: ручка есть, добраться до неё
 * можно только сырым curl, зная о ней заранее. База знаний, в которую нечем
 * писать и нечего читать, не наполняется — что и подтвердила живая база: на
 * весь Chatick одна заметка.
 */
server.registerTool(
  'chatick_notes',
  {
    title: 'Search the project journal',
    description:
      'Solutions, problems, decisions, requirements, gotchas — what the team already learned. ' +
      'SEARCH UNDERSTANDS MEANING, not just words: "payment fails" finds "Cardcom rejects foreign cards" with ' +
      'no shared word, and it works the same in Hebrew. Ask in your own words instead of guessing the exact ' +
      'wording someone used; items found that way are marked matchedBy="meaning". ' +
      'LOOK HERE BEFORE debugging something — it may already have been solved, in this project or another. ' +
      'scope="company" searches every project of the company: that is where reusable technical answers live.',
    inputSchema: {
      project: z.string().describe('Project id'),
      query: z.string().optional().describe('Ask in plain words — meaning is matched, not substrings'),
      type: z.string().optional().describe('Comma separated: bug, requirement, attention, solution, problem, decision, contradiction, mismatch, gap, reminder, business, note'),
      tag: z.string().optional().describe('Comma separated tags, AND condition'),
      scope: z.enum(['project', 'company']).optional().describe('company = across every project of the company'),
      limit: z.number().optional(),
    },
  },
  async ({ project, ...q }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'GET', '/notes', undefined, {
        q: q.query,
        type: q.type,
        tag: q.tag,
        scope: q.scope,
        limit: q.limit ? String(q.limit) : undefined,
      }))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_note',
  {
    title: 'Read one journal entry',
    description:
      'Full text of one entry, plus the chat messages quoted as evidence. The search list gives only a ' +
      '200-character preview — read the entry itself before acting on it.',
    inputSchema: { project: z.string().describe('Project id'), id: z.string().describe('Note id from chatick_notes') },
  },
  async ({ project, id }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'GET', `/notes/${encodeURIComponent(id)}`))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_note_save',
  {
    title: 'Write to the project journal',
    description:
      'Record what was learned, ON BEHALF OF the human. Write an entry when you solved something non-obvious, ' +
      'hit a requirement worth remembering, or found a trap the next person will step into. A fix that lives ' +
      'only in this conversation is lost the moment it ends. ' +
      'scope="company" for anything reusable beyond this project — technical answers, gotchas, rules. That is ' +
      'what makes the next project cheaper. ' +
      'Tags matter: they narrow a search that meaning alone cannot ("cardcom", "sms", "ios"). ' +
      'Body is HTML, like documents — not markdown.',
    inputSchema: {
      project: z.string().describe('Project id'),
      title: z.string().describe('Short — what this is about'),
      body: z.string().describe('HTML'),
      type: z
        .enum(['bug', 'requirement', 'attention', 'solution', 'problem', 'decision', 'contradiction', 'mismatch', 'gap', 'reminder', 'business', 'note'])
        .optional()
        .describe('solution = a problem AND its fix, the reusable kind; bug = broken and not yet fixed; requirement = a rule to follow; attention = a trap to avoid'),
      tags: z.array(z.string()).optional(),
      scope: z.enum(['project', 'company']).optional().describe('company = findable from every project'),
    },
  },
  async ({ project, ...body }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'POST', '/notes', body))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'chatick_note_update',
  {
    title: 'Correct a journal entry',
    description:
      'Fix or extend an entry that turned out incomplete or wrong. Pass only what changes. ' +
      'Prefer correcting an existing entry over writing a second one about the same thing: two entries with ' +
      'different answers to the same question are worse than one outdated.',
    inputSchema: {
      project: z.string().describe('Project id'),
      id: z.string().describe('Note id'),
      title: z.string().optional(),
      body: z.string().optional().describe('HTML'),
      type: z.string().optional(),
      tags: z.array(z.string()).optional(),
      scope: z.enum(['project', 'company']).optional(),
    },
  },
  async ({ project, id, ...body }) => {
    if (!Object.values(body).some((v) => v !== undefined)) {
      return fail(new Error('Nothing to change: pass title, body, type, tags or scope'))
    }
    try {
      return json(await call({ ...(await need()), projectId: project }, 'PATCH', `/notes/${encodeURIComponent(id)}`, body))
    } catch (e) {
      return fail(e)
    }
  },
)

// --- Чек-лист ----------------------------------------------------------------

/**
 * Читать чек-лист было НЕЧЕМ.
 *
 * Инструменты умели добавить пункт и отметить его, а прочитать — нет. Ручка
 * существовала, но добраться до неё можно было только сырым curl, зная о ней
 * заранее. Из-за этого ответы под пунктами оказались недостижимы: человек
 * ответил на десять вопросов, и достать их было не через что. Ему пришлось
 * отдельно писать комментарий «я ответил в пунктах».
 */
server.registerTool(
  'chatick_checklist',
  {
    title: 'Read a task checklist',
    description:
      'The items of a task checklist WITH the answers written under them. A checklist item is often a question — ' +
      '"which key do we sign with?" — and the answer lives in its note, not in the comments. chatick_task reports ' +
      'the counts (total, done, answered); when "answered" is above zero, the answers are here and nowhere else.',
    inputSchema: { project: z.string().describe('Project id'), task: z.string().describe('Task id or number') },
  },
  async ({ project, task }) => {
    try {
      return json(await call({ ...(await need()), projectId: project }, 'GET', `/tasks/${encodeURIComponent(task)}/checklist`))
    } catch (e) {
      return fail(e)
    }
  },
)

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

/**
 * Открыть страницу Chatick в браузере человека.
 *
 * Ассистент часто заканчивает работу словами «вот задача» и ссылкой, которую
 * человек копирует и вставляет руками. Здесь он открывает её сам.
 *
 * Браузер запускается НА ЭТОЙ машине — той, где работает MCP, то есть рядом с
 * человеком. Открывать сразу в приложении Chatick было бы приятнее, но своего
 * протокола у него пока нет: это отдельная сборка (см. DEFERRED.md).
 */
server.registerTool(
  'chatick_open',
  {
    title: 'Open a page in the browser',
    description:
      'Opens a Chatick page on the screen of the person you work with: a task, a document, a project, a ' +
      'company. Pass a link that came from another tool ("shortUrl", "link") — never one you assembled ' +
      'yourself, ids are not guessable. Use it when they are about to look at the thing anyway; saying what ' +
      'you opened is polite, opening five pages in a row is not.',
    inputSchema: {
      url: z.string().describe('A chatick.com link taken from another tool reply'),
    },
  },
  async ({ url }) => {
    try {
      /**
       * Только свои адреса.
       *
       * Инструмент запускает программу на машине человека по строке, которую
       * предложила модель. Без проверки достаточно подсунуть ей чужую ссылку
       * в тексте задачи — и мы откроем что угодно от его имени.
       */
      let target: URL
      try {
        target = new URL(url)
      } catch {
        return fail(new Error('Not a URL: ' + url))
      }
      if (target.protocol !== 'https:' && target.protocol !== 'http:') {
        return fail(new Error('Only http(s) links can be opened'))
      }
      // Точное совпадение домена или его поддомен: проверка через includes
      // пропустила бы chatick.com.evil.net.
      const host = target.hostname.toLowerCase()
      if (host !== 'chatick.com' && !host.endsWith('.chatick.com') && host !== 'localhost') {
        return fail(new Error('Only chatick.com links can be opened, got: ' + host))
      }

      /**
       * Открываем средствами системы.
       *
       * Аргументом, а не строкой команды: адрес приходит извне, и склеивать
       * его с командой значит отдать кавычки чужому тексту. execFile ничего
       * не разбирает через оболочку.
       *
       * Windows: у start нет исполняемого файла, поэтому там cmd с /c, а
       * пустые кавычки — заголовок окна, без них start съедает сам адрес.
       */
      const { execFile } = await import('node:child_process')
      await new Promise<void>((resolve, reject) => {
        const done = (err: unknown) => (err ? reject(err) : resolve())
        if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', target.href], done)
        else if (process.platform === 'darwin') execFile('open', [target.href], done)
        else execFile('xdg-open', [target.href], done)
      })
      return json({ opened: target.href })
    } catch (e) {
      return fail(e)
    }
  },
)
