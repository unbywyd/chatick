import { Hono } from 'hono'
import { and, asc, desc, eq, gt, gte, ilike, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  activityLog,
  chatSummaries,
  companies,
  companyInvites,
  companyMembers,
  credentialAccessLog,
  credentials,
  documents,
  documentVersions,
  dbConnections, dbTablePolicies, files,
  messages,
  notes,
  notifications,
  projectMembers,
  projects,
  shares,
  resourceSecrets, resourceViewers,
  resourceFiles,
  taskBlockers, taskChecklist, taskLinks, taskResources,
  taskComments,
  taskReleases,
  releases,
  projectIntegrations,
  releaseEvents,
  taskGroups,
  tasks,
  timeEntries,
  users,
} from '../db/schema.js'
import {
  canCreateProjects,
  projectNameTaken,
  companyRoleOf,
  defaultDomainPermissions,
  defaultPermissions,
  resolveDomains,
  PERMISSION_LEVELS,
  hasPermission,
  memberDomains,
  projectRoleOf,
  PROJECT_COLORS,
  type ProjectPermission, ownsOrManages } from './projects.js'
import { nanoid } from 'nanoid'
import { authenticateBridge, closeSession, startDeviceAuth, pollDeviceAuth, IDLE_TTL_MS, type BridgeIdentity } from '../lib/bridge-auth.js'
import { readFromConnection } from './db-connections.js'
import { connectDoc, guideDoc } from '../lib/bridge-docs.js'
import { logActivity } from '../lib/audit.js'
import { sendAddedToProjectMail, sendRemovedFromProjectMail } from '../lib/mails.js'
import { sendInviteMail } from '../lib/mail-invite.js'
import { createNote, noteToTask, NOTE_TYPES, canUseKnowledge, canEditKnowledge, type NoteType } from './notes.js'
import { enqueue as enqueueEmbedding, searchNoteIds, searchTaskIds } from '../lib/embeddings.js'
import { readTimeConfig, maybeTranslate, timeConfigForProject } from './time.js'
import { readPresence } from './auth.js'
import { canPublish, createShare, locate, revokeShare, type ShareEntityType } from './shares.js'
import { notifyChatMentions } from './messages.js'
import { notify, extractMentions, commentWatchers } from '../lib/notify.js'
import { setDue } from '../lib/notify-config.js'
import { notifyTask, unassignNotice, dependentsOf, blockersOf, checklistAnswerNotice } from './tasks.js'
import { projectPath, projectUrl, companyOf } from '../lib/links.js'
import { htmlToText, sanitizeHtml } from '../lib/sanitize-html.js'
import { searchInDocument, searchInText, DEFAULT_CONTEXT } from '../lib/doc-search.js'
import { richText } from '../lib/markdown.js'
import { profilesForProject } from '../lib/job-title.js'
import { normalizeRefs } from '../lib/task-refs.js'
import { fetchSiteIcon, nameFromUrl } from '../lib/site-icon.js'
import { encrypt } from '../lib/crypto.js'
import { membersLockedForProject, MEMBERS_LOCKED } from '../lib/members-locked.js'
import { broadcast, sendToUserAnywhere, tasksChanged } from '../ws.js'
import { shortUrlFor, parseTaskRef, resolveShortCode } from '../lib/short-links.js'
import { BUILD_TYPES, buildType, firstStage, isLiveStage, isValidStage } from '../lib/release-stages.js'
import { isFeatureEnabled } from '../lib/features.js'
import { REPORT_KINDS, submitAssistantReport, type ReportKind } from '../lib/assistant-report.js'
import { randomBytes } from 'node:crypto'
import { notifyReleaseStage } from './releases.js'
import { env } from '../env.js'

// Мост для внешнего ИИ (SPEC §8.27). Всё выполняется ОТ ИМЕНИ пользователя,
// одобрившего туннель, и проверяется теми же hasPermission, что и живой UI.

type BridgeEnv = { Variables: { bridge: BridgeIdentity } }
export const bridgeRoute = new Hono()

const APP = () => (env.APP_URL || 'https://app.chatick.com').replace(/\/$/, '')

// Внятная ошибка вместо пустого 500: читатель — агент, ему нужно понять,
// что пошло не так, и решить, чинить запрос или сдаться.
bridgeRoute.onError((err, c) => {
  console.error('[bridge]', err)
  return c.json({ error: 'Request failed', detail: String(err instanceof Error ? err.message : err) }, 500)
})

// --- Публичное: инструкция и device flow (без токена) ----------------------

bridgeRoute.get('/', (c) => c.text(connectDoc()))

bridgeRoute.post('/device', async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
  const clientName = typeof body.client === 'string' && body.client.trim() ? body.client.trim() : 'AI assistant'
  const { userCode, deviceCode, expiresInSec } = await startDeviceAuth(clientName)
  return c.json({
    userCode,
    deviceCode,
    verifyUrl: `${APP()}/#/connect`,
    expiresInSec,
    instructions: `Tell the human: open ${APP()}/#/connect and enter code ${userCode}. Then poll /x/device/poll with deviceCode.`,
  })
})

bridgeRoute.post('/device/poll', async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
  const deviceCode = typeof body.deviceCode === 'string' ? body.deviceCode : ''
  if (!deviceCode) return c.json({ error: 'deviceCode is required' }, 400)

  const r = await pollDeviceAuth(deviceCode)
  if (r.status !== 'approved') return c.json({ status: r.status })
  return c.json({
    status: 'approved',
    token: r.token,
    user: r.identity.user,
    project: r.identity.project,
    company: r.identity.company,
    // Область словом, а не догадкой по пустым полям: мастер-туннель и
    // компанейский оба приходят без project, и без этого признака клиент
    // называет мастер «доступом к компании» — то есть занижает то, что человек
    // на самом деле открыл.
    scope: r.identity.scopeAll ? 'all' : r.identity.companyId ? 'company' : 'project',
    // Срок сразу при выдаче: не «когда-нибудь протухнет», а конкретный момент,
    // на который клиент может смотреть до начала долгой работы.
    expiresAt: r.identity.expiresAt?.toISOString(),
    idleTimeoutSec: Math.floor(IDLE_TTL_MS / 1000),
    guideUrl: `${(process.env.API_PUBLIC_URL || 'https://api.chatick.com').replace(/\/$/, '')}/x/guide`,
    next: 'Read the guide with: curl -s <guideUrl> -H "authorization: Bearer <token>"',
  })
})

// --- Всё ниже требует токена ------------------------------------------------

bridgeRoute.use('/*', async (c, next) => {
  // публичные пути уже обработаны выше
  const path = new URL(c.req.url).pathname
  if (path === '/x' || path === '/x/' || path.startsWith('/x/device')) return next()

  const header = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
  const identity = await authenticateBridge(header ?? c.req.query('token'))
  if (!identity) {
    return c.json(
      {
        error: 'Tunnel closed or token invalid',
        hint: 'Run the device flow again — see GET /x for instructions.',
      },
      401,
    )
  }
  ;(c as unknown as { set: (k: 'bridge', v: BridgeIdentity) => void }).set('bridge', identity)
  await next()
  // Сколько туннелю осталось — на КАЖДОМ ответе.
  //
  // Иначе о протухании узнают единственным способом: поймав 401 посреди
  // многошаговой работы. Так уже получалась задача-полуфабрикат — сама задача
  // создалась, а чеклист к ней упал с 401. Зная остаток, клиент переподключится
  // до начала длинной операции, а не после половины.
  if (identity.expiresAt) {
    const left = Math.max(0, Math.floor((identity.expiresAt.getTime() - Date.now()) / 1000))
    c.res.headers.set('x-tunnel-expires-at', identity.expiresAt.toISOString())
    c.res.headers.set('x-tunnel-expires-in', String(left))
  }
})

const auth = (c: { get: (k: 'bridge') => BridgeIdentity }) => c.get('bridge')

type Ctx = { get: (k: 'bridge') => BridgeIdentity; req: { query: (k: string) => string | undefined } }

/**
 * Проект текущего запроса.
 * Туннель на проект — он и есть. Туннель на компанию — берём ?project= и
 * проверяем, что человек действительно в нём состоит: доступ к компании не
 * означает доступ к проектам, куда его не включили.
 */
async function resolveProject(c: Ctx): Promise<{ projectId: string } | { error: string; status: 400 | 403 | 404 }> {
  const id = auth(c)
  if (id.projectId) return { projectId: id.projectId }

  const asked = c.req.query('project')
  if (!asked) {
    return {
      error: id.scopeAll
        ? 'This connection covers all your projects: pass ?project=<id> (or projectId in the body). Call GET /x/projects to list them, or GET /x/companies to see them grouped by company.'
        : 'This is a company-wide connection: pass ?project=<id> (or projectId in the body). Call GET /x/projects to list available projects.',
      status: 400,
    }
  }
  const project = await db.query.projects.findFirst({ where: eq(projects.id, asked) })
  if (!project) return { error: 'Project not found', status: 404 }
  // Мастер-туннель не привязан к компании — ограничение проверяем только для
  // компанейского. Членство в проекте проверяется в обоих случаях ниже, и
  // именно оно решает: шире собственного доступа туннель не даёт.
  if (!id.scopeAll && project.companyId !== id.companyId) {
    return { error: 'Project not found in this company', status: 404 }
  }
  if (!(await memberDomains(asked, id.userId))) {
    return { error: 'You are not a member of that project', status: 403 }
  }
  return { projectId: asked }
}

/** Единая проверка прав: тот же механизм, что и для живого пользователя. */
async function require(c: Ctx, perm: ProjectPermission, projectId: string) {
  const id = auth(c)
  const ok = await hasPermission(projectId, id.userId, perm)
  return ok ? null : { error: `Forbidden: your account lacks ${perm} in this project`, permission: perm }
}

bridgeRoute.get('/guide', (c) => c.text(guideDoc(auth(c as never))))

// Список доступных проектов. Для company-туннеля это отправная точка:
// из него ИИ узнаёт, какие ?project= вообще можно передавать.
bridgeRoute.get('/projects', async (c) => {
  const id = auth(c as never)

  // Мастер: берём проекты по членству — компанией он не ограничен.
  //
  // Архивные из СПИСКОВ убираем: ассистент выбирает, где работать, и
  // законченный проект в этом выборе только мешает. А вот адресный запрос по
  // projectId отдаём как есть — по прямой ссылке архивный проект открывается,
  // иначе «убрали с глаз» превратилось бы в «отобрали доступ».
  const rows = id.scopeAll
    ? (
        await db
          .select({ p: projects })
          .from(projectMembers)
          .innerJoin(projects, eq(projects.id, projectMembers.projectId))
          .where(and(eq(projectMembers.userId, id.userId), isNull(projects.archivedAt)))
      ).map((r) => r.p)
    : id.companyId
      ? await db.query.projects.findMany({
          where: and(eq(projects.companyId, id.companyId), isNull(projects.archivedAt)),
        })
      : id.projectId
        ? await db.query.projects.findMany({ where: eq(projects.id, id.projectId) })
        : []

  // Названия компаний: с мастер-доступом проекты приходят из разных компаний,
  // и без подписи одинаковые названия не различить.
  const companyIds = [...new Set(rows.map((p) => p.companyId))]
  const companyNames = new Map(
    companyIds.length
      ? (await db.select().from(companies).where(inArray(companies.id, companyIds))).map((c) => [c.id, c.name])
      : [],
  )

  const items = []
  for (const p of rows) {
    // показываем только проекты, где человек действительно состоит
    const perms = await memberDomains(p.id, id.userId)
    if (!perms) continue
    items.push({
      id: p.id,
      name: p.name,
      about: p.about,
      companyId: p.companyId,
      companyName: companyNames.get(p.companyId),
      // Язык проекта здесь же: писать на нём требует руководство, а узнать
      // его иначе можно было только отдельным /x/context на каждый проект.
      language: (JSON.parse(p.aiConfig || '{}') as { language?: string }).language ?? 'en',
      permissions: perms,
    })
  }
  // Где человек сейчас: с доступом на всю компанию иначе приходится
  // переспрашивать «а в каком проекте?» — или, что хуже, угадывать.
  const here = readPresence(id.userId)
  const activeProject = here && items.some((x) => x.id === here.projectId) ? here.projectId : null

  return c.json({
    items,
    scope: id.scopeAll ? 'all' : id.companyId ? 'company' : 'project',
    activeProject,
    activeProjectName: activeProject ? items.find((x) => x.id === activeProject)?.name : undefined,
    hint:
      id.companyId || id.scopeAll
        ? activeProject
          ? `The person is looking at "${items.find((x) => x.id === activeProject)?.name}" right now — prefer it unless told otherwise. Pass ?project=<id> on every project-scoped call.`
          : 'Pass ?project=<id> on every project-scoped call.'
        : undefined,
  })
})

// Компании человека — со списком его проектов в каждой. Нужно мастер-туннелю:
// плоский список проектов из разных компаний читается плохо, а решение «в
// какой компании работаем» ассистент должен принимать осознанно.
bridgeRoute.get('/companies', async (c) => {
  const id = auth(c as never)

  const rows = await db
    .select({ c: companies, role: companyMembers.role })
    .from(companyMembers)
    .innerJoin(companies, eq(companies.id, companyMembers.companyId))
    .where(eq(companyMembers.userId, id.userId))

  // Туннель шире своей области не показывает: проектный — свою компанию,
  // компанейский — свою, мастер — все.
  const visible = id.scopeAll
    ? rows
    : id.companyId
      ? rows.filter((r) => r.c.id === id.companyId)
      : await (async () => {
          if (!id.projectId) return []
          const p = await db.query.projects.findFirst({ where: eq(projects.id, id.projectId) })
          return p ? rows.filter((r) => r.c.id === p.companyId) : []
        })()

  // Названия компаний не уникальны: их заводят не связанные между собой люди,
  // и запретить второму назвать фирму так же нельзя. Поэтому одноимённые
  // помечаем явно — иначе на «работаем в WebToPro» ассистент выберет наугад.
  const seen = new Map<string, number>()
  for (const r of visible) seen.set(r.c.name, (seen.get(r.c.name) ?? 0) + 1)

  const items = []
  for (const r of visible) {
    const mine = await db
      .select({ p: projects })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(and(eq(projectMembers.userId, id.userId), eq(projects.companyId, r.c.id)))
    const ambiguous = (seen.get(r.c.name) ?? 0) > 1
    items.push({
      id: r.c.id,
      name: r.c.name,
      ambiguousName: ambiguous || undefined,
      myRole: r.role,
      projects: mine.map((x) => ({ id: x.p.id, name: x.p.name })),
    })
  }

  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([n]) => n)

  return c.json({
    items,
    scope: id.scopeAll ? 'all' : id.companyId ? 'company' : 'project',
    hint: dupes.length
      ? `Pass ?project=<id> from these lists on every project-scoped call. NOTE: more than one company is named ${dupes
          .map((n) => `"${n}"`)
          .join(', ')} — never pick by name alone; ask the person which one, or infer it from the project they mean.`
      : 'Pass ?project=<id> from these lists on every project-scoped call.',
  })
})

/**
 * Люди КОМПАНИИ — со своей ролью и должностью.
 *
 * Отличается от GET /x/members: там команда одного проекта, здесь все
 * сотрудники. Должность живёт на уровне компании и наследуется проектами,
 * поэтому «кто у нас QA» — вопрос отсюда, а не из проекта.
 */
bridgeRoute.get('/company/members', async (c) => {
  const id = auth(c as never)
  // Компания известна из туннеля; на проектном — берём её у проекта, чтобы
  // ассистенту не приходилось переподключаться ради должности.
  let companyId = id.companyId ?? null
  if (!companyId) {
    const scope = await resolveProject(c as never)
    if ('error' in scope) return c.json({ error: scope.error }, scope.status)
    companyId = await companyOf(scope.projectId)
  }
  if (!companyId) return c.json({ error: 'Company unknown' }, 400)
  const myRole = await companyRoleOf(companyId, id.userId)
  if (!myRole) return c.json({ error: 'You are not a member of that company' }, 403)

  const rows = await db
    .select({ m: companyMembers, u: users })
    .from(companyMembers)
    .innerJoin(users, eq(users.id, companyMembers.userId))
    .where(eq(companyMembers.companyId, companyId))

  return c.json({
    companyId,
    canManage: myRole === 'admin',
    members: rows.map((r) => ({
      userId: r.u.id,
      name: r.u.name,
      email: r.u.email,
      companyRole: r.m.role,
      jobTitle: r.m.jobTitle || undefined,
      responsibility: r.m.responsibility || undefined,
    })),
    hint: 'jobTitle here is the COMPANY-wide one: every project inherits it unless that project sets its own. Change it with PATCH /x/company/members/<userId>.',
  })
})

/**
 * Должность и роль человека В КОМПАНИИ.
 *
 * Ассистент умел менять должность внутри проекта и не умел — в компании.
 * Просьба «расставь роли всем: Таль — CEO, Ханан — QA» выполнялась по одному
 * проекту за раз или не выполнялась вовсе, хотя должность по своей природе
 * общая: человек бэкендер и здесь, и там.
 *
 * Роль в компании тоже здесь, но это иной вес: manager и admin видят ВСЕ
 * проекты компании, включая те, куда человека не звали (см. видимость в
 * projects.ts). Поэтому менять её может только admin — как и в интерфейсе, —
 * и в описании инструмента это сказано прямо.
 */
bridgeRoute.patch('/company/members/:userId', async (c) => {
  const id = auth(c as never)
  // Компания известна из туннеля; на проектном — берём её у проекта, чтобы
  // ассистенту не приходилось переподключаться ради должности.
  let companyId = id.companyId ?? null
  if (!companyId) {
    const scope = await resolveProject(c as never)
    if ('error' in scope) return c.json({ error: scope.error }, scope.status)
    companyId = await companyOf(scope.projectId)
  }
  if (!companyId) return c.json({ error: 'Company unknown' }, 400)
  if ((await companyRoleOf(companyId, id.userId)) !== 'admin') {
    return c.json({ error: 'Forbidden: only a company admin changes company roles and titles' }, 403)
  }

  const userId = c.req.param('userId')
  const target = await db.query.companyMembers.findFirst({
    where: and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId)),
  })
  if (!target) return c.json({ error: 'Not a member of this company' }, 404)

  const parsed = await readJson(c as never)
  if ('error' in parsed) return c.json(parsed, 400)
  const body = parsed.body as { role?: string; jobTitle?: string; responsibility?: string }

  const patch: Record<string, unknown> = {}
  if (body.role !== undefined) {
    if (!['admin', 'manager', 'member'].includes(body.role)) {
      return c.json({ error: 'role must be "admin", "manager" or "member"' }, 400)
    }
    // Последнего админа не понижаем — иначе компания остаётся без хозяина, и
    // вернуть права будет некому. Та же проверка стоит в интерфейсе.
    if (userId === id.userId && body.role !== 'admin') {
      const admins = await db.query.companyMembers.findMany({
        where: and(eq(companyMembers.companyId, companyId), eq(companyMembers.role, 'admin')),
      })
      if (admins.length <= 1) return c.json({ error: 'Cannot demote the only admin' }, 400)
    }
    patch.role = body.role
  }
  if (body.jobTitle !== undefined) patch.jobTitle = String(body.jobTitle).trim().slice(0, 120)
  if (body.responsibility !== undefined) patch.responsibility = String(body.responsibility).trim().slice(0, 300)
  if (!Object.keys(patch).length) {
    return c.json({ error: 'Nothing to change. Supported: role, jobTitle, responsibility.' }, 400)
  }

  await db.update(companyMembers).set(patch).where(eq(companyMembers.id, target.id))
  return c.json({
    ok: true,
    userId,
    companyRole: patch.role ?? target.role,
    jobTitle: patch.jobTitle ?? target.jobTitle,
    responsibility: patch.responsibility ?? target.responsibility,
    note: 'Company-wide. Projects inherit this unless a project sets its own value for this person.',
  })
})

/**
 * Репорт разработчикам Chatick: чего не хватило, что сломалось, о чём попросил
 * человек.
 *
 * Проект НЕ обязателен, и это важно: самые ценные репорты приходят как раз
 * оттуда, где ассистент не смог ничего сделать — нужной ручки нет, и выбирать
 * проект не в чем.
 *
 * Отдельная ручка, а не задача в проекте: это обращение к нам, а не работа
 * команды. Класть его в чужой проект значило бы засорять людям доску тем, что
 * им чинить нечем.
 */
bridgeRoute.post('/report', async (c) => {
  const id = auth(c as never)

  const parsed = await readJson(c as never)
  if ('error' in parsed) return c.json(parsed, 400)
  const b = parsed.body as Record<string, unknown>

  const kind = String(b.kind ?? 'missing')
  if (!(REPORT_KINDS as readonly string[]).includes(kind)) {
    return c.json({ error: `kind must be one of: ${REPORT_KINDS.join(', ')}` }, 400)
  }

  const res = await submitAssistantReport({
    kind: kind as ReportKind,
    body: String(b.body ?? ''),
    context: typeof b.context === 'string' ? b.context : undefined,
    user: id.user,
    projectId: id.projectId,
    clientName: typeof b.client === 'string' ? b.client : undefined,
  })
  if (!res.ok) return c.json({ error: res.error }, res.status)

  return c.json({
    ok: true,
    id: res.id,
    // Ответ говорит, что будет дальше: иначе ассистент обещает человеку
    // больше, чем есть — «передал разработчикам» звучит как «починят завтра».
    note: 'Sent to the Chatick team. It is read, not auto-implemented — do not promise the person a fix or a date.',
  })
})

// --- Управление проектами (SPEC §8.27) --------------------------------------
//
// Доступно только компанейскому туннелю: у проектного нет и понятия «компания»,
// а создание проекта — действие на её уровне. Права те же, что в интерфейсе:
// заводить проекты могут админы и менеджеры компании.
//
// Состав участников и удаление проекта намеренно оставлены человеку: первое
// раздаёт доступ к чужим данным, второе необратимо.

bridgeRoute.post('/projects', async (c) => {
  const id = auth(c as never)
  if (!id.companyId) {
    return c.json({ error: 'Company-wide access required', hint: 'Ask the human to grant company-wide access.' }, 403)
  }
  if (!canCreateProjects(await companyRoleOf(id.companyId, id.userId))) {
    return c.json({ error: 'Only company admins and managers can create projects' }, 403)
  }
  // Проекты приходят только из внешней системы — мост ИИ не исключение:
  // настройка существовала, но здесь не проверялась, и ассистент заводил
  // проекты в обход неё.
  const cmp = await db.query.companies.findFirst({ where: eq(companies.id, id.companyId) })
  if (cmp?.projectsViaApiOnly) {
    return c.json(
      {
        error: 'Projects are created in the external system',
        hint: `Create it in ${cmp.externalSystemName || 'the external system'} — it will appear here automatically.`,
      },
      403,
    )
  }

  const parsed_body = await readJson(c as never)
  if ('error' in parsed_body) return c.json(parsed_body, 400)
  const body = parsed_body.body as Record<string, unknown>
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return c.json({ error: 'name is required' }, 400)
  const about = typeof body.about === 'string' ? body.about.slice(0, 5000) : ''
  const chatRules = typeof body.chatRules === 'string' ? body.chatRules.slice(0, 4000) : ''
  if (await projectNameTaken(id.companyId, name)) {
    return c.json({ error: `A project named "${name}" already exists in this company` }, 409)
  }

  const slug = `${name.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project'}-${nanoid(6)}`
  const [project] = await db
    .insert(projects)
    .values({
      companyId: id.companyId,
      name: name.slice(0, 120),
      about,
      slug,
      chatRules,
      color: PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)]!,
    })
    .returning()

  // Владелец — человек, от чьего имени работает туннель: проект должен
  // остаться его, даже когда ассистента отключат.
  await db.insert(projectMembers).values({
    projectId: project!.id,
    userId: id.userId,
    role: 'owner',
    permissions: JSON.stringify(defaultPermissions('owner')),
    rulesAcceptedAt: new Date(),
  })

  await logActivity({
    projectId: project!.id,
    actorId: id.userId,
    action: 'create',
    entityType: 'project',
    entityId: project!.id,
    entityLabel: project!.name,
  })

  return c.json({ id: project!.id, name: project!.name, slug: project!.slug }, 201)
})

bridgeRoute.patch('/projects/:id', async (c) => {
  const id = auth(c as never)
  const projectId = c.req.param('id')

  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return c.json({ error: 'Not found' }, 404)

  // Туннель на проект правит только свой проект; компанейский — любой в своей
  // компании, но по-прежнему в рамках роли человека.
  if (id.projectId && id.projectId !== projectId) return c.json({ error: 'Forbidden' }, 403)
  if (id.companyId && project.companyId !== id.companyId) return c.json({ error: 'Forbidden' }, 403)

  const member = await projectRoleOf(projectId, id.userId)
  const companyRole = await companyRoleOf(project.companyId, id.userId)
  if (!(member?.role === 'owner' || member?.role === 'admin' || canCreateProjects(companyRole))) {
    return c.json({ error: 'Only project owners/admins and company managers can change settings' }, 403)
  }

  const parsed_body = await readJson(c as never)
  if ('error' in parsed_body) return c.json(parsed_body, 400)
  const body = parsed_body.body as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 120)
  if (typeof body.about === 'string') patch.about = body.about.slice(0, 5000)
  if (typeof body.chatRules === 'string') patch.chatRules = body.chatRules.slice(0, 4000)
  if (typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color)) patch.color = body.color
  if (!Object.keys(patch).length) {
    return c.json({ error: 'Nothing to update', hint: 'Supported: name, about, chatRules, color.' }, 400)
  }

  if (typeof patch.name === 'string' && (await projectNameTaken(project.companyId, patch.name, projectId))) {
    return c.json({ error: `A project named "${patch.name}" already exists in this company` }, 409)
  }

  const [updated] = await db.update(projects).set(patch).where(eq(projects.id, projectId)).returning()

  await logActivity({
    projectId,
    actorId: id.userId,
    action: 'update',
    entityType: 'project',
    entityId: projectId,
    entityLabel: updated!.name,
  })

  return c.json({ id: updated!.id, name: updated!.name, about: updated!.about, chatRules: updated!.chatRules, color: updated!.color })
})

// --- Ссылки на сущности (SPEC §8.34) ----------------------------------------
//
// Ассистент часто заканчивает работу словами «вот файл» или «смотри заметку» —
// и без ссылки человеку приходится искать это руками.

bridgeRoute.post('/shares/:type/:id', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const type = c.req.param('type')
  const entityId = c.req.param('id')
  if (!['file', 'note', 'resource', 'message', 'task'].includes(type)) {
    return c.json({ error: 'Unsupported entity', hint: 'file | note | resource | message | task' }, 400)
  }

  // Ровно та же проверка, что в интерфейсе, — вызовом, а не копией правила:
  // разъехавшись, они дали бы ассистенту и человеку разные ответы на один
  // и тот же вопрос.
  const target = await locate(type as ShareEntityType, entityId)
  if (!target || target.projectId !== scope.projectId) return c.json({ error: 'Not found' }, 404)
  if (!(await canPublish(scope.projectId, id.userId, target.authorId))) {
    return c.json({ error: 'Only the author, project owners and admins can publish links' }, 403)
  }

  const share = await createShare(type as ShareEntityType, entityId, scope.projectId, id.userId)
  if (!share) return c.json({ error: 'Not found' }, 404)

  const app = APP()
  return c.json({
    // Ссылка для команды: откроется у того, кто в проекте. Публичная работает
    // без входа — её отдаём отдельно, чтобы ассистент не путал их местами.
    appUrl: `${app}/#${await appPathOf(type, scope.projectId, entityId)}`,
    publicUrl: `${app}/#/s/${share.slug}`,
    slug: share.slug,
  })
})

/**
 * Опубликовано ли уже — и по какой ссылке.
 *
 * Проверить это было нечем: публикация выдаёт ссылку, но узнать, что вещь уже
 * лежит в открытом доступе, ассистент не мог. А это первое, что надо знать,
 * прежде чем говорить человеку «сейчас опубликую» — или прежде чем обсуждать
 * содержимое как приватное.
 */
bridgeRoute.get('/shares/:type/:id', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const type = c.req.param('type')
  if (!['file', 'note', 'resource', 'message', 'task'].includes(type)) {
    return c.json({ error: 'Unsupported entity', hint: 'file | note | resource | message | task' }, 400)
  }
  const member = await projectRoleOf(scope.projectId, id.userId)
  if (!member) return c.json({ error: 'Forbidden' }, 403)

  const row = await db.query.shares.findFirst({
    where: and(eq(shares.entityType, type as ShareEntityType), eq(shares.entityId, c.req.param('id')), isNull(shares.revokedAt)),
  })
  if (!row || row.projectId !== scope.projectId) return c.json({ shared: false })
  return c.json({ shared: true, publicUrl: `${APP()}/#/s/${row.slug}`, slug: row.slug, since: row.createdAt })
})

bridgeRoute.delete('/shares/:type/:id', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const member = await projectRoleOf(scope.projectId, id.userId)
  if (!(member?.role === 'owner' || member?.role === 'admin')) return c.json({ error: 'Forbidden' }, 403)

  await revokeShare(c.req.param('type') as ShareEntityType, c.req.param('id'))
  return c.json({ ok: true })
})

/**
 * Внутренний адрес сущности — тот же, что открывается в приложении.
 *
 * Через projectPath: адрес проекта включает компанию (SPEC §8.45). Здесь
 * оставался формат `/p/<id>/…` без неё — такого маршрута во фронте нет, и
 * ссылка, которую ассистент отдавал человеку, открывала пустую страницу.
 */
async function appPathOf(type: string, projectId: string, id: string): Promise<string> {
  const companyId = (await companyOf(projectId)) ?? ''
  if (type === 'message') return projectPath(companyId, projectId, `/chat?msg=${id}`)
  const tab = type === 'file' ? 'files' : type === 'note' ? 'notes' : type === 'resource' ? 'resources' : 'tasks'
  return projectPath(companyId, projectId, `/${tab}/${id}`)
}

// --- Контекст проекта -------------------------------------------------------

// --- журнал проекта ---------------------------------------------------------
//
// «Что тут происходило» — вопрос, с которого начинается почти любое
// подключение к чужому проекту: кто трогал задачу, когда удалили файл,
// что менялось на прошлой неделе. Без этого ассистент реконструирует
// историю по текущему состоянию и ошибается.
//
// Только чтение: журнал — свидетельство, и править его нельзя ни людям,
// ни ассистенту.
bridgeRoute.get('/activity', async (c) => {
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const q = c.req.query()
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200)
  const conds = [eq(activityLog.projectId, scope.projectId)]

  if (q.entityType) conds.push(eq(activityLog.entityType, q.entityType))
  if (q.action) conds.push(eq(activityLog.action, q.action as 'create'))
  if (q.entityId) conds.push(eq(activityLog.entityId, q.entityId))
  if (q.q?.trim()) conds.push(ilike(activityLog.entityLabel, `%${q.q.trim()}%`))
  if (q.from && !isNaN(Date.parse(q.from))) conds.push(sql`${activityLog.createdAt} >= ${new Date(q.from)}`)
  if (q.to && !isNaN(Date.parse(q.to))) conds.push(sql`${activityLog.createdAt} <= ${new Date(q.to + 'T23:59:59')}`)

  // actor=me — «что делал я»: чаще всего спрашивают именно про себя.
  if (q.actor) {
    const who = q.actor === 'me' ? auth(c as never).userId : q.actor
    conds.push(eq(activityLog.actorId, who))
  }

  const rows = await db
    .select({ a: activityLog, actor: users })
    .from(activityLog)
    .leftJoin(users, eq(users.id, activityLog.actorId))
    .where(and(...conds))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit)

  return c.json({
    items: rows.map((r) => ({
      action: r.a.action,
      entityType: r.a.entityType,
      entityId: r.a.entityId,
      entityLabel: r.a.entityLabel,
      // Пустой actor — это система или ИИ, а не «неизвестно кто».
      actor: r.actor ? r.actor.name || r.actor.email : 'system',
      at: r.a.createdAt,
    })),
    count: rows.length,
  })
})

bridgeRoute.get('/context', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const project = await db.query.projects.findFirst({ where: eq(projects.id, scope.projectId) })
  if (!project) return c.json({ error: 'Not found' }, 404)

  const members = await db
    .select({ m: projectMembers, u: users })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, scope.projectId))

  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      todo: sql<number>`count(*) filter (where ${tasks.status} = 'todo')::int`,
      inProgress: sql<number>`count(*) filter (where ${tasks.status} = 'in_progress')::int`,
      review: sql<number>`count(*) filter (where ${tasks.status} = 'review')::int`,
      verified: sql<number>`count(*) filter (where ${tasks.status} = 'verified')::int`,
      done: sql<number>`count(*) filter (where ${tasks.status} = 'done')::int`,
      mine: sql<number>`count(*) filter (where ${tasks.assigneeId} = ${id.userId} and ${tasks.status} <> 'done')::int`,
    })
    .from(tasks)
    .where(and(eq(tasks.projectId, scope.projectId), isNull(tasks.deletedAt)))

  const sprints = await db.query.taskGroups.findMany({
    where: and(eq(taskGroups.projectId, scope.projectId), isNull(taskGroups.deletedAt)),
  })

  const aiConfig = JSON.parse(project.aiConfig || '{}') as { language?: string }

  return c.json({
    project: { id: project.id, name: project.name, about: project.about, language: aiConfig.language ?? 'en' },
    chatRules: project.chatRules,
    you: { ...id.user, permissions: await memberDomains(scope.projectId, id.userId) },
    members: members.map((r) => ({
      id: r.u.id,
      name: r.u.name,
      email: r.u.email,
      role: r.m.role,
      jobTitle: r.m.jobTitle,
      responsibility: r.m.responsibility,
      isYou: r.u.id === id.userId,
    })),
    sprints: sprints.map((s) => ({ id: s.id, name: s.name })),
    tasks: counts,
  })
})


// --- Что меня касается: уведомления и контекст (SPEC §8.30) ---------------
// Ради сценария «Клауд, проверь что там»: агент читает адресованное человеку,
// доходит до исходного сообщения и отвечает, не открывая интерфейс.

/**
 * События, где к человеку обратились лично.
 *
 * Отдельно от общей ленты, потому что вес разный: «кто-то закрыл свою задачу»
 * и «человек задал вопрос и ждёт ответа» — не одно и то же, а в общем списке
 * второе тонет среди первого. Именно так и вышло: вопрос в комментарии
 * пришлось искать тремя запросами, потому что в ленте он лежал наравне с
 * чужими статусами.
 */
const MENTION_EVENTS = ['chat_mention', 'task_mention', 'comment_mention', 'note_mention', 'task_assigned'] as const

/**
 * Событие → ветка сводки инбокса.
 *
 * Человек спрашивает «что мне ответили?», и ассистент начинал искать: точек
 * входа было две, и они спорили друг с другом. У /x/mentions в гайде стояло
 * «CHECK THIS BEFORE /x/inbox», у /x/inbox — «start every check here». Лечили
 * инструкцией, а инструкцию можно не прочитать.
 *
 * Ветки решают это не текстом, а формой ответа: видно, ЧТО ждёт и сколько
 * его, — и переходить есть смысл только туда, где счётчик больше нуля.
 *
 * Порядок здесь — это и есть приоритет. Модель читает сверху вниз, и первым
 * стоит то, где человек ждёт ответа. Отдельного поля «важность» нет: его она
 * всё равно не прочтёт, а порядок прочтёт.
 */
const INBOX_BRANCHES = [
  { kind: 'mentions', events: MENTION_EVENTS, next: 'GET /x/mentions' },
  { kind: 'answers', events: ['checklist_answer'], next: 'GET /x/tasks/<id> — ответы в чек-листе' },
  { kind: 'comments', events: ['task_comment'], next: 'GET /x/tasks/<id>/comments' },
  { kind: 'tasks', events: ['task_status', 'task_due'], next: 'GET /x/tasks/<id>' },
  { kind: 'releases', events: ['release_status'], next: 'GET /x/releases' },
  { kind: 'notes', events: ['note_reminder'], next: 'GET /x/notes' },
  { kind: 'timers', events: ['timer_running'], next: 'GET /x/timer' },
] as const satisfies readonly { kind: string; events: readonly string[]; next: string }[]

bridgeRoute.get('/mentions', async (c) => {
  const id = auth(c as never)
  const onlyUnread = c.req.query('unread') !== '0'
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 30))

  const conds = [eq(notifications.userId, id.userId), inArray(notifications.event, MENTION_EVENTS as never)]
  if (id.projectId) conds.push(eq(notifications.projectId, id.projectId))
  if (onlyUnread) conds.push(isNull(notifications.readAt))
  const since = parseSince(c.req.query('since'))
  if (since) conds.push(gt(notifications.createdAt, since))

  const rows = await db
    .select({ n: notifications, actor: users, project: projects })
    .from(notifications)
    .leftJoin(users, eq(users.id, notifications.actorId))
    .innerJoin(projects, eq(projects.id, notifications.projectId))
    .where(and(...conds))
    .orderBy(desc(notifications.createdAt))
    .limit(limit)

  return c.json({
    items: rows.map((r) => ({
      id: r.n.id,
      event: r.n.event,
      title: r.n.title,
      whatIsAsked: r.n.summary,
      body: r.n.body,
      from: r.actor ? { id: r.actor.id, name: r.actor.name } : { id: 'ai', name: 'AI' },
      project: { id: r.project.id, name: r.project.name },
      entityType: r.n.entityType,
      entityId: r.n.entityId,
      url: `${APP()}/#${r.n.link}`,
      unread: !r.n.readAt,
      createdAt: r.n.createdAt,
    })),
    hint:
      'These are the things addressed to YOU personally — answer them first. For entityType="task" the entityId is the task id: read it with GET /x/tasks/<id> and reply with POST /x/tasks/<id>/comments. Mark handled ones read with POST /x/inbox/read — {"entityType":"task","entityId":"<id>"} clears every notification about that task at once, which is what you want after handling one: assigned, mentioned and commented are separate items. Leave them and the person keeps a counter for work you already did.',
  })
})

/** `since` для лент: ISO-строка. Мусор игнорируем, а не отвечаем ошибкой. */
function parseSince(raw: string | undefined): Date | null {
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

bridgeRoute.get('/inbox', async (c) => {
  const id = auth(c as never)
  const onlyUnread = c.req.query('unread') !== '0'
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 30))

  // company-туннель видит все проекты человека, проектный — только свой
  const conds = [eq(notifications.userId, id.userId)]
  if (id.projectId) conds.push(eq(notifications.projectId, id.projectId))
  if (onlyUnread) conds.push(isNull(notifications.readAt))
  // «что нового с момента X» — чтобы не тянуть последние тридцать и не искать
  // в них глазами незнакомое.
  const since = parseSince(c.req.query('since'))
  if (since) conds.push(gt(notifications.createdAt, since))

  const rows = await db
    .select({ n: notifications, actor: users, project: projects })
    .from(notifications)
    .leftJoin(users, eq(users.id, notifications.actorId))
    .innerJoin(projects, eq(projects.id, notifications.projectId))
    .where(and(...conds))
    .orderBy(desc(notifications.createdAt))
    .limit(limit)

  // Ветки считаем агрегатом по тем же условиям: тридцать строк в ответе не
  // говорят, сколько всего ждёт, — а «сколько» и есть первый вопрос.
  const counts = await db
    .select({ event: notifications.event, n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(...conds))
    .groupBy(notifications.event)
  const byEvent = new Map(counts.map((r) => [r.event as string, r.n]))

  const branches = INBOX_BRANCHES.map((b) => ({
    kind: b.kind,
    count: b.events.reduce((sum, e) => sum + (byEvent.get(e) ?? 0), 0),
    next: b.next,
  })).filter((b) => b.count > 0) // пустую ветку не пишем: «count: 0» читается как «я проверил» и на этом успокаивает

  return c.json({
    // Сколько всего ждёт. Не сумма веток: если событие когда-нибудь выпадет из
    // INBOX_BRANCHES, расхождение скажет об этом вслух, а не спрячет.
    unreadTotal: counts.reduce((s, r) => s + r.n, 0),
    branches,
    items: rows.map((r) => ({
      // id остаётся: им гасят через POST /x/inbox/read. Без него ассистент
      // видит, что работа есть, и не может отметить её сделанной.
      id: r.n.id,
      event: r.n.event,
      title: r.n.title,
      // чего от человека хотят, словами ИИ — главное поле для агента
      whatIsAsked: r.n.summary,
      body: r.n.body,
      from: r.actor ? { id: r.actor.id, name: r.actor.name } : { id: 'ai', name: 'AI' },
      project: { id: r.project.id, name: r.project.name },
      // по этим полям агент дотягивается до сути: сообщение, задача, комментарий
      entityType: r.n.entityType,
      entityId: r.n.entityId,
      url: `${APP()}/#${r.n.link}`,
      unread: !r.n.readAt,
      createdAt: r.n.createdAt,
    })),
    hint:
      'Start here — this is the one place that says what is waiting. "branches" lists it by kind, most urgent first, and only kinds that actually have something; go to a branch\'s "next" only when its count is above zero. "items" carries the newest in full: whatIsAsked says what the person is expected to do. For entityType="task" read GET /x/tasks/<entityId>; for entityType="message" call GET /x/messages/<entityId>/context and answer with POST /x/messages (replyToId=<entityId>). The "answers" branch means someone replied inside a task checklist — GET /x/tasks/<id> shows the counts, GET /x/tasks/<id>/checklist the answers themselves. Mark handled ones read with POST /x/inbox/read; {"entityType":"task","entityId":"<id>"} clears every notification about one task at once. Pass since=<ISO> to ask only for what is new.',
  })
})

bridgeRoute.post('/inbox/read', async (c) => {
  const id = auth(c as never)
  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const ids = Array.isArray(b.ids) ? (b.ids as unknown[]).map(String) : []
  const all = b.all === true
  // Погасить всё, что вело на эту задачу. Интерфейс так и делает, открывая
  // карточку: на одну задачу уведомлений накапливается несколько — назначили,
  // упомянули, прокомментировали. Ассистент держит в руках id задачи, а не их,
  // и без этого приёма ему пришлось бы сперва вычитывать /mentions и
  // сопоставлять entityId. Шаг лишний, и его пропускали: разобранные задачи
  // оставались непрочитанными.
  const entityType = typeof b.entityType === 'string' ? b.entityType : null
  const entityId = typeof b.entityId === 'string' ? b.entityId : null
  const byEntity = Boolean(entityType && entityId)

  if (!ids.length && !all && !byEntity) {
    return c.json({ error: 'Pass ids[], entityType+entityId, or all=true' }, 400)
  }
  const conds = [eq(notifications.userId, id.userId), isNull(notifications.readAt)]
  // Оба поля значат что-то только вместе: один entityType погасил бы разом все
  // задачи человека.
  if (byEntity) {
    conds.push(eq(notifications.entityType, entityType!), eq(notifications.entityId, entityId!))
  } else if (!all) {
    conds.push(inArray(notifications.id, ids))
  }
  if (id.projectId) conds.push(eq(notifications.projectId, id.projectId))

  await db.update(notifications).set({ readAt: new Date() }).where(and(...conds))
  sendToUserAnywhere(id.userId, 'notification', {})
  return c.json({ ok: true })
})

/**
 * Что из группового чата человек вправе видеть — тем же правилом, что и живой
 * интерфейс (canSee в messages.ts).
 *
 * В чате лежат не только доставленные сообщения. `held` — черновик, на который
 * диспетчер задал уточняющий вопрос АВТОРУ: команде он ещё не показан. `routed`
 * превращено в действие и в чат не пошло вовсе, `pending` ещё не обработано.
 * Мост работает от имени человека и не должен видеть больше него: без этого
 * условия ассистент читал чужие неподтверждённые черновики.
 */
function visibleInChat(userId: string) {
  return or(eq(messages.status, 'delivered' as const), eq(messages.authorId, userId))!
}

/** Окно переписки вокруг сообщения: без него агент не поймёт, о чём просят. */
bridgeRoute.get('/messages/:id/context', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const target = await db.query.messages.findFirst({
    where: and(eq(messages.id, c.req.param('id')), eq(messages.projectId, scope.projectId)),
  })
  if (!target) return c.json({ error: 'Message not found' }, 404)
  // Само сообщение — по тому же правилу: чужой черновик не открывается и по
  // прямой ссылке.
  if (target.status !== 'delivered' && target.authorId !== id.userId) return c.json({ error: 'Message not found' }, 404)

  const around = Math.min(30, Math.max(1, Number(c.req.query('around')) || 10))
  const [before, after] = await Promise.all([
    db
      .select({ m: messages, u: users })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.authorId))
      .where(
        and(
          eq(messages.projectId, scope.projectId),
          eq(messages.mode, 'group' as const),
          visibleInChat(id.userId),
          lt(messages.createdAt, target.createdAt),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(around),
    db
      .select({ m: messages, u: users })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.authorId))
      .where(
        and(
          eq(messages.projectId, scope.projectId),
          eq(messages.mode, 'group' as const),
          visibleInChat(id.userId),
          gt(messages.createdAt, target.createdAt),
        ),
      )
      .orderBy(messages.createdAt)
      .limit(around),
  ])

  const view = (r: { m: typeof messages.$inferSelect; u: typeof users.$inferSelect | null }) => ({
    id: r.m.id,
    text: r.m.text,
    author: r.u ? { id: r.u.id, name: r.u.name } : { id: 'ai', name: 'AI' },
    replyTo: r.m.replyToId || undefined,
    isYou: r.m.authorId === id.userId,
    createdAt: r.m.createdAt,
  })

  // вложения целевого сообщения: просьбы вида «пришли файл» часто ссылаются на них
  const atts = await db.select().from(files).where(eq(files.messageId, target.id))
  // автора целевого сообщения надо подтянуть: без него target выглядел как «AI»,
  // и агент не понимал, кто именно его о чём-то просит
  const targetAuthor = target.authorId
    ? (await db.query.users.findFirst({ where: eq(users.id, target.authorId) })) ?? null
    : null

  return c.json({
    target: {
      ...view({ m: target, u: targetAuthor }),
      attachments: atts.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: Number(f.size) })),
    },
    before: before.reverse().map(view),
    after: after.map(view),
  })
})

// --- Хелперы ----------------------------------------------------------------

/** «me», id, имя или email → userId. */
async function resolveAssignee(id: BridgeIdentity, projectId: string, value: unknown): Promise<string | null | undefined> {
  if (value === null) return null // явный сброс
  if (typeof value !== 'string' || !value.trim()) return undefined
  const v = value.trim()
  if (v.toLowerCase() === 'me') return id.userId

  const rows = await db
    .select({ u: users })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
  const lower = v.toLowerCase()
  const hit =
    rows.find((r) => r.u.id === v) ??
    rows.find((r) => r.u.email.toLowerCase() === lower) ??
    rows.find((r) => r.u.name.toLowerCase() === lower) ??
    rows.find((r) => r.u.name.toLowerCase().includes(lower))
  return hit?.u.id
}

/** ISO или «tomorrow» / «in 3 days» / «next monday». */
/**
 * Ругаться на неизвестные поля в теле.
 *
 * Молча проглоченное поле — худший исход для ассистента: запрос успешен, а
 * работа не сделана, и узнать об этом можно только перечитав объект. Так и
 * случилось с checklist: агент отправил его внутри задачи, получил 201 и
 * доложил о созданных пунктах, которых не было.
 *
 * Подсказываем, куда идти, если поле — это отдельный подресурс.
 */
/**
 * Срок задачи из того, что прислал ассистент.
 *
 * Принимаем и «2026-09-14», и полную метку времени: модель пишет то так, то
 * так, и отказ на голой дате означал бы, что срок ставится через раз.
 *
 * Голую дату разворачиваем в полдень по UTC, а не в полночь: полночь в поясе
 * западнее UTC откатывается на предыдущий день, и «14-е» показывалось бы как
 * 13-е. Полдень переживает сдвиг в любую сторону.
 *
 * null — снять срок, undefined — не трогать: это разные намерения, и путать
 * их нельзя.
 */
function parseDue(v: unknown): Date | null | undefined {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  if (typeof v !== 'string') return undefined
  const raw = v.trim()
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00Z` : raw
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? undefined : d
}

const SUBRESOURCE_HINT: Record<string, string> = {
  checklist: 'POST /x/tasks/<id>/checklist — a checklist is a sub-resource, not a task field',
  comments: 'POST /x/tasks/<id>/comments',
  comment: 'POST /x/tasks/<id>/comments',
  secrets: 'POST /x/resources/<id>/secrets',
  attachments: 'POST /x/files, then pass attachmentIds',
}

const TASK_FIELDS = [
  'title',
  'description',
  'assignee',
  'status',
  'priority',
  'estimateMinutes',
  // Срок. Ассистент ставит задачи не реже человека, и без этого поля они
  // выходили бы без даты — а дописывать её потом руками значит потерять
  // смысл поручать заведение задач ему.
  'dueDate',
  // Свои номера задачи: экраны в макете, пункты договора, позиции сметы.
  'refs',
  'sprintId',
  // Файлы к задаче: в интерфейсе их крепят прямо к ней, а через мост
  // оставалось только комментировать со вложением — не то же самое.
  'attachmentIds',
  // Ресурсы к задаче: «вот стенд, вот ключ». Ссылкой, а не копией в описании —
  // иначе доступы расползаются по тексту, который читают все.
  'resourceIds',
  // Версии, к которым относится задача. Связь необязательна с обеих сторон:
  // версия живёт без задачи, задача без версии.
  'releaseIds',
  // Из чего задача выросла. Разбирая одну задачу на несколько, ассистент
  // проставляет связь здесь же — вторым вызовом её забывают.
  'links',
  // project передают в query, но в теле он безобиден и приходит по привычке
  'project',
] as const

/**
 * Поля тела групповой правки.
 *
 * Отдельный список, а не TASK_FIELDS: здесь другое тело — какие задачи менять,
 * что ставить всем и что своё каждой. Само содержимое set проверяется по
 * TASK_FIELDS, поэтому набор допустимых полей задачи остаётся один.
 */
const BULK_FIELDS = ['tasks', 'set', 'refs', 'project'] as const

/**
 * Потолок задач в одной партии.
 *
 * Не из-за базы: сотня строк ей безразлична. Из-за уведомлений и писем — по
 * задаче на исполнителя, и «обнови все» превращается в рассылку. Число
 * пришлось выбирать: 100 покрывает и «все экраны макета», и разумную часть
 * бэклога, но не даёт задеть проект целиком одним движением.
 */
const BULK_MAX = 100

/**
 * Привязать уже загруженные файлы к задаче.
 *
 * Берём только свои файлы этого проекта и снимаем временный флаг — иначе
 * уборщик снесёт их через сутки как неприкаянные.
 */
async function attachToTask(fileIds: unknown, projectId: string, userId: string, taskId: string) {
  const ids = Array.isArray(fileIds)
    ? (fileIds as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 10)
    : []
  if (!ids.length) return []
  await db
    .update(files)
    .set({ taskId, pendingUntil: null })
    .where(and(inArray(files.id, ids), eq(files.projectId, projectId), eq(files.uploadedById, userId)))
  const rows = await db.select().from(files).where(and(eq(files.taskId, taskId), isNull(files.deletedAt)))
  return rows.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: Number(f.size) }))
}

/**
 * Привязать ресурсы к задаче.
 *
 * Ссылкой, а не копией: доступы живут в ресурсе, и право решать, кто видит
 * секрет, остаётся за ним. Скопированный в описание пароль читают все, кому
 * видна задача, и отозвать его уже нельзя.
 *
 * Чужие id молча отбрасываем — ресурс из другого проекта к этой задаче не
 * относится, и 400 на такое означало бы отказ во всей операции из-за одной
 * опечатки в списке.
 */
/**
 * Версии, к которым относится задача.
 *
 * Добавляется со стороны ЗАДАЧИ, как ресурсы: «подними 1.4 в Google Play» —
 * это работа, у неё есть исполнитель и срок, а у версии их нет. В ручках
 * версий обратной опции нет намеренно, чтобы связь заводилась в одном месте.
 *
 * Чужие id молча отбрасываются, а не роняют запрос: одна устаревшая ссылка не
 * должна отменять правку всей задачи.
 */
async function linkReleases(releaseIds: unknown, projectId: string, taskId: string) {
  const ids = Array.isArray(releaseIds)
    ? (releaseIds as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 20)
    : []
  await db.delete(taskReleases).where(eq(taskReleases.taskId, taskId))
  if (ids.length) {
    const mine = await db
      .select({ id: releases.id })
      .from(releases)
      .where(and(inArray(releases.id, ids), eq(releases.projectId, projectId)))
    if (mine.length) {
      await db.insert(taskReleases).values(mine.map((r) => ({ taskId, releaseId: r.id }))).onConflictDoNothing()
    }
  }
  return releasesOfTask(taskId)
}

/**
 * Связать только что созданную задачу с теми, из которых она выросла.
 *
 * Принимаем номера ("TASK-3"), а не только id: ассистент оперирует номерами,
 * и требовать от него лишний запрос за id значит получить связь, которую он
 * не поставит.
 */
async function linkTasks(links: unknown, projectId: string, taskId: string, userId: string) {
  const raw = Array.isArray(links) ? (links as unknown[]) : []
  if (!raw.length) return []

  // Два вида записи: "TASK-3" и {task:"TASK-3", kind:"related"}.
  const wanted = raw
    .map((x) =>
      typeof x === 'string'
        ? { key: x.trim(), kind: 'derived' as const }
        : x && typeof x === 'object'
          ? {
              key: String((x as Record<string, unknown>).task ?? '').trim(),
              kind: (x as Record<string, unknown>).kind === 'related' ? ('related' as const) : ('derived' as const),
            }
          : { key: '', kind: 'derived' as const },
    )
    .filter((x) => x.key)
    .slice(0, 50)
  if (!wanted.length) return []

  const rows: { projectId: string; fromTaskId: string; toTaskId: string; kind: string; createdById: string }[] = []
  const seen = new Set<string>()
  for (const w of wanted) {
    const found = await taskByKey(projectId, w.key)
    // Молча пропускаем ненайденное: задача уже создана, и ронять весь вызов
    // из-за одной опечатки в номере значило бы потерять её.
    if (!found || found.id === taskId || seen.has(found.id)) continue
    seen.add(found.id)
    // Новая задача выросла ИЗ перечисленных — она слева.
    rows.push({ projectId, fromTaskId: taskId, toTaskId: found.id, kind: w.kind, createdById: userId })
  }
  if (rows.length) await db.insert(taskLinks).values(rows).onConflictDoNothing()
  return rows.map((r) => ({ taskId: r.toTaskId, kind: r.kind }))
}

/**
 * Связи задачи одной выборкой — для GET /x/tasks/<id>.
 *
 * Отдаём вместе с задачей, а не отдельной ручкой: «из чего это выросло» —
 * вопрос того же ряда, что «кто исполнитель», и ради него незачем делать
 * второй запрос. Ассистент, читающий задачу перед работой, увидит исходную
 * сразу, а не после того, как догадается спросить.
 */
async function linksOfTask(taskId: string) {
  const out = await db
    .select({ t: tasks, linkId: taskLinks.id, kind: taskLinks.kind })
    .from(taskLinks)
    .innerJoin(tasks, eq(tasks.id, taskLinks.toTaskId))
    .where(and(eq(taskLinks.fromTaskId, taskId), isNull(tasks.deletedAt)))
    .orderBy(asc(tasks.number))
  const inc = await db
    .select({ t: tasks, linkId: taskLinks.id, kind: taskLinks.kind })
    .from(taskLinks)
    .innerJoin(tasks, eq(tasks.id, taskLinks.fromTaskId))
    .where(and(eq(taskLinks.toTaskId, taskId), isNull(tasks.deletedAt)))
    .orderBy(asc(tasks.number))

  const view = (r: { t: typeof tasks.$inferSelect; linkId: string }) => ({
    ...linkedView(r.t),
    linkId: r.linkId,
  })
  const derivedFrom = out.filter((r) => r.kind === 'derived').map(view)
  const derivedInto = inc.filter((r) => r.kind === 'derived').map(view)
  const related = [...out, ...inc].filter((r) => r.kind === 'related').map(view)
  // Пустые поля не отдаём: у большинства задач связей нет, и три пустых
  // массива в каждом ответе — шум, который ассистент читает как данные.
  return {
    ...(derivedFrom.length ? { derivedFrom } : {}),
    ...(derivedInto.length ? { derivedInto } : {}),
    ...(related.length ? { related } : {}),
  }
}

/** Версии задачи со статусом — чтобы не переходить внутрь за одним словом. */
async function releasesOfTask(taskId: string) {
  const rows = await db
    .select({ r: releases })
    .from(taskReleases)
    .innerJoin(releases, eq(releases.id, taskReleases.releaseId))
    .where(eq(taskReleases.taskId, taskId))
  return rows.map(({ r }) => ({
    id: r.id,
    version: r.version,
    buildType: r.buildType,
    status: r.status,
    statusLabel: buildType(r.buildType)?.stages.find((st) => st.key === r.status)?.label ?? r.status,
    isLive: isLiveStage(r.buildType, r.status),
    referenceUrl: r.referenceUrl,
  }))
}

/**
 * Состояние чек-листа: сколько всего, сколько закрыто, на сколько ОТВЕТИЛИ.
 *
 * Задача с чек-листом выглядела задачей без него: GET /x/tasks/<id> отдавал
 * вложения, версии и связи, а чек-лист — нет. Ответы на десять вопросов лежали
 * в задаче и не были видны нигде: ни здесь, ни в комментариях, ни в инбоксе.
 *
 * Третье число, answered, и есть суть. done значит «сделано», answered — «на
 * пункт ответили, но галочку не поставили», и второе означает «мне ответили».
 * Без него «7 из 10» говорит только о работе, а не о разговоре.
 *
 * Числами, а не строкой «7/10»: модель разбирает такую строку обратно и
 * иногда ошибается. И третье число в неё не влезает.
 *
 * Счётчик, а не сам список. Довод «версии показываем всегда» (см. GET
 * /tasks/:id) применим к ФАКТУ наличия чек-листа, но не к содержимому: у
 * версии это две строки, у пункта — заметка до четырёх тысяч символов, а
 * ручку зовут по любому поводу. Содержимое читается отдельно, через
 * GET /x/tasks/<id>/checklist.
 *
 * Один агрегат, без выборки строк: покрыт индексом task_checklist_task_idx.
 */
async function checklistCounts(taskId: string) {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      done: sql<number>`count(*) filter (where ${taskChecklist.done})::int`,
      answered: sql<number>`count(*) filter (where ${taskChecklist.note} <> '')::int`,
    })
    .from(taskChecklist)
    .where(eq(taskChecklist.taskId, taskId))
  return row && row.total > 0 ? row : null
}

/**
 * ЗАМЕНЯЕТ весь список ресурсов задачи присланным.
 *
 * Так работают поля-списки в PATCH, и для releaseIds это верно. Но для
 * ресурсов замена опасна: приславший один id молча сотрёт привязки, которые
 * поставил кто-то другой, и узнают об этом, когда доступ понадобится.
 * Поэтому у ассистента есть отдельные POST/DELETE /tasks/<id>/resources —
 * добавить одно, убрать одно, ничего не задев. Это поле оставлено для тех,
 * кто действительно хочет задать список целиком.
 */
async function linkResources(resourceIds: unknown, projectId: string, taskId: string) {
  const ids = Array.isArray(resourceIds)
    ? (resourceIds as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 20)
    : []
  await db.delete(taskResources).where(eq(taskResources.taskId, taskId))
  if (ids.length) {
    const mine = await db
      .select({ id: credentials.id })
      .from(credentials)
      .where(and(inArray(credentials.id, ids), eq(credentials.projectId, projectId), isNull(credentials.deletedAt)))
    if (mine.length) {
      await db.insert(taskResources).values(mine.map((r) => ({ taskId, resourceId: r.id }))).onConflictDoNothing()
    }
  }
  const rows = await db
    .select({ id: credentials.id, name: credentials.name, url: credentials.url })
    .from(taskResources)
    .innerJoin(credentials, eq(credentials.id, taskResources.resourceId))
    .where(eq(taskResources.taskId, taskId))
  return rows
}

/**
 * Разобрать тело запроса, назвав ошибку разбора ошибкой разбора.
 *
 * Раньше повсюду стояло `c.req.json().catch(() => ({}))`: сломанный JSON молча
 * превращался в пустой объект, и дальше валидация честно сообщала «title is
 * required». Ассистент шёл искать проблему в title, а дело было в одном
 * обратном слэше — например, в ивритском «מאשר\\ת», где он ломает строку.
 * Двадцать минут поисков не в том месте.
 *
 * Возвращает либо тело, либо готовый ответ с позицией, на которой парсер
 * споткнулся: по ней видно, какой символ виноват.
 */
async function readJson(c: {
  req: { text: () => Promise<string> }
}): Promise<{ body: Record<string, unknown> } | { error: string; hint: string }> {
  const raw = await c.req.text().catch(() => '')
  if (!raw.trim()) return { body: {} }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'Body must be a JSON object', hint: `Got ${Array.isArray(parsed) ? 'an array' : typeof parsed}.` }
    }
    return { body: parsed as Record<string, unknown> }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // Позиция из сообщения движка + кусок текста вокруг неё: «ошибка на 47»
    // без самого текста заставляет считать символы руками.
    //
    // Позицию сообщают не все версии V8 — в новых её в тексте нет. Тогда
    // показываем начало тела: даже оно полезнее пустоты, потому что чаще
    // всего ломается первая же строка с экранированием.
    const at = /position (\d+)/.exec(message)?.[1]
    const near = at
      ? raw.slice(Math.max(0, Number(at) - 30), Number(at) + 30)
      : raw.slice(0, 120)
    return {
      error: `Invalid JSON: ${message}`,
      hint: near
        ? `Near: …${near}… — a backslash or an unescaped quote is the usual cause; in JSON a literal \\ must be written \\\\.`
        : 'A backslash or an unescaped quote is the usual cause; in JSON a literal \\ must be written \\\\.',
    }
  }
}

function unknownFields(body: Record<string, unknown>, allowed: readonly string[]): string | null {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k))
  if (!extra.length) return null
  const hints = extra.filter((k) => SUBRESOURCE_HINT[k]).map((k) => `${k}: use ${SUBRESOURCE_HINT[k]}`)
  return `Unknown field${extra.length > 1 ? 's' : ''}: ${extra.join(', ')}. Allowed: ${allowed.join(', ')}.${
    hints.length ? ` ${hints.join('; ')}.` : ''
  }`
}

/**
 * Файлы, вшитые в произвольный HTML: описание задачи, тело документа, заметки.
 *
 * Такие картинки не связаны с сущностью ни одним полем — только ссылкой внутри
 * текста. Без этого списка ассистент видит «вложений нет» и делает вывод, что
 * смотреть нечего, хотя картинка вшита в текст.
 */
async function inlineAttachments(html: string | null | undefined, projectId: string) {
  const ids = inlineFileIds(html)
  if (!ids.length) return []
  const rows = await db
    .select()
    .from(files)
    .where(and(inArray(files.id, ids), eq(files.projectId, projectId), isNull(files.deletedAt)))
  return rows.map(fileView)
}

/**
 * Инлайн-картинки, вставленные прямо в текст.
 *
 * Такие файлы не привязаны к задаче полем taskId — редактор грузит их отдельно,
 * — и в attachments не попадали: ассистент видел пустой список и делал вывод,
 * что смотреть нечего, хотя картинка была вшита в описание. Достаём их из
 * самого HTML: id — последний сегмент пути в src.
 */
function inlineFileIds(html: string | null | undefined): string[] {
  if (!html) return []
  const ids = new Set<string>()
  for (const m of html.matchAll(/\/files\/inline\/([A-Za-z0-9_-]+)/g)) ids.add(m[1]!)
  return [...ids]
}

/**
 * Вложение в том же виде, что отдаёт GET /x/files: ассистенту не приходится
 * гадать, как забрать содержимое, — адрес приходит вместе со списком.
 */
const EXT_BY_MIME: Record<string, string> = {
  'image/webp': '.webp',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'audio/mpeg': '.mp3',
  'video/mp4': '.mp4',
}

/** Расширение, которого не хватает имени. Уже есть — возвращаем пустую строку. */
function extFor(name: string, mime: string): string {
  const known = EXT_BY_MIME[mime] ?? (name.includes('.') ? name.slice(name.lastIndexOf('.')) : '')
  if (!known) return ''
  return name.toLowerCase().endsWith(known.toLowerCase()) ? '' : known
}

const fileView = (f: typeof files.$inferSelect) => ({
  id: f.id,
  name: f.name,
  mime: f.mime,
  // Расширение по типу: скачав файл под именем без него, ассистент пытается
  // прочитать webp как текст и получает экран двоичного мусора.
  //
  // Пустое, если имя уже оканчивается на него: иначе наивная склейка
  // name + ext даёт «shot.webp.webp», и подстраховываться приходится читателю.
  ext: extFor(f.name, f.mime),
  size: Number(f.size),
  contentUrl: `${(process.env.API_PUBLIC_URL || 'https://api.chatick.com').replace(/\/$/, '')}/x/files/${f.id}/content`,
})

/**
 * Вложения нескольких задач или сообщений разом.
 *
 * Одним запросом на список, а не по одному на строку: список задач бывает
 * длинным, и сотня отдельных запросов к базе ради вложений — плохая цена за
 * удобство.
 */
async function attachmentsFor(
  column: typeof files.taskId | typeof files.messageId | typeof files.commentId,
  ids: string[],
  projectId: string,
  /** id => html, откуда достать инлайн-картинки описания */
  htmlById?: Map<string, string | null>,
): Promise<Map<string, ReturnType<typeof fileView>[]>> {
  const map = new Map<string, ReturnType<typeof fileView>[]>()
  if (!ids.length) return map
  const rows = await db
    .select()
    .from(files)
    .where(and(inArray(column, ids), eq(files.projectId, projectId), isNull(files.deletedAt)))
  for (const f of rows) {
    const key = (column === files.taskId ? f.taskId : column === files.messageId ? f.messageId : f.commentId) ?? ''
    if (!key) continue
    const list = map.get(key) ?? []
    list.push(fileView(f))
    map.set(key, list)
  }

  // Картинки из текста: их id нигде не связан с задачей, кроме самого HTML
  if (htmlById?.size) {
    const wanted = new Map<string, string[]>() // fileId -> [ownerId]
    for (const [ownerId, html] of htmlById) {
      for (const fid of inlineFileIds(html)) {
        wanted.set(fid, [...(wanted.get(fid) ?? []), ownerId])
      }
    }
    if (wanted.size) {
      const inlineRows = await db
        .select()
        .from(files)
        .where(and(inArray(files.id, [...wanted.keys()]), eq(files.projectId, projectId), isNull(files.deletedAt)))
      for (const f of inlineRows) {
        for (const ownerId of wanted.get(f.id) ?? []) {
          const list = map.get(ownerId) ?? []
          // Один и тот же файл может быть и вложением, и в тексте
          if (!list.some((x) => x.id === f.id)) list.push(fileView(f))
          map.set(ownerId, list)
        }
      }
    }
  }
  return map
}

const taskView = (
  t: typeof tasks.$inferSelect,
  assignee?: { id: string; name: string } | null,
  attachments?: ReturnType<typeof fileView>[],
  deps?: { openBlockers: number; blocking: number },
  /**
   * Компания проекта — только чтобы собрать ссылку. Приходит параметром, а не
   * запросом внутри: taskView зовут на каждую строку списка, и запрос на
   * компанию превратился бы в полсотни одинаковых.
   */
  companyId?: string | null,
  /**
   * Короткая ссылка — chatick.com/t-AbC12.
   *
   * Приходит параметром по той же причине, что и companyId, только строже:
   * получить её — это запрос в базу, а при первом обращении ещё и вставка.
   * В списке из полусотни задач это полсотни ссылок, которые никто не просил.
   * Поэтому её передают только там, где ответ про одну задачу, — то есть
   * там, где агент и правда собирается дать её человеку.
   */
  shortUrl?: string | null,
) => ({
  id: t.id,
  number: t.number,
  /**
   * Готовая ссылка на задачу.
   *
   * Раньше в ответе был только id, и клиент собирал адрес сам — угадывая
   * формат. Угадывали неверно: /#/p/<id> без компании выглядит правдоподобно,
   * а такого маршрута нет, и человек из ссылки попадал на белый экран. Отдать
   * готовый URL дешевле, чем чинить каждого клиента отдельно.
   */
  ...(companyId ? { url: projectUrl(env.APP_URL, companyId, t.projectId, `/tasks/${t.id}`) } : {}),
  ...(shortUrl ? { shortUrl } : {}),
  title: t.title,
  description: t.description,
  status: t.status,
  priority: t.priority,
  estimateMinutes: t.estimateMinutes ? Number(t.estimateMinutes) : null,
  dueDate: t.dueDate ? t.dueDate.toISOString() : null,
  refs: t.refs || undefined,
  sprintId: t.groupId,
  assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
  // Файлы, приложенные к задаче. Раньше их не было в ответе вовсе: ассистент
  // видел задачу, но не знал, что к ней приложен макет, и узнать это мог
  // только перебрав все файлы проекта.
  attachments: attachments ?? [],
  // Зависимости: сколько НЕзакрытых задач эта ждёт и скольких держит сама.
  // Без этих чисел ассистент предлагает браться за работу, которую нельзя
  // начать, — а узнать об этом можно было только запросом на каждую задачу.
  ...(deps ? { openBlockers: deps.openBlockers, blocking: deps.blocking } : {}),
  updatedAt: t.updatedAt,
})

/** Счётчики зависимостей одним запросом на весь список. */
/**
 * Что происходило в комментариях: сколько их, когда последний и — главное —
 * ждёт ли меня там вопрос.
 *
 * `unansweredMention` истинно, когда меня упомянули, и после этого упоминания
 * я ничего не написал. Без этого поля «где меня спросили» выясняется чтением
 * комментариев по каждой задаче отдельно: три запроса вместо одного, и то
 * лишь если догадаться, в какую задачу смотреть.
 *
 * Одним запросом на весь список: по запросу на задачу это возвращало бы
 * полсотни обращений к базе на каждый показ списка.
 */
async function commentActivity(
  taskIds: string[],
  userId: string,
): Promise<Map<string, { count: number; lastAt: Date | null; unanswered: boolean }>> {
  const out = new Map<string, { count: number; lastAt: Date | null; unanswered: boolean }>()
  if (!taskIds.length) return out

  const rows = await db
    .select({
      taskId: taskComments.taskId,
      authorId: taskComments.authorId,
      body: taskComments.body,
      createdAt: taskComments.createdAt,
    })
    .from(taskComments)
    .where(inArray(taskComments.taskId, taskIds))
    .orderBy(asc(taskComments.createdAt))

  for (const row of rows) {
    const cur = out.get(row.taskId) ?? { count: 0, lastAt: null as Date | null, unanswered: false }
    cur.count += 1
    cur.lastAt = row.createdAt
    if (row.authorId === userId) {
      // Ответил — вопрос снят, даже если упоминание было раньше в той же ленте.
      cur.unanswered = false
    } else if (extractMentions(row.body).includes(userId)) {
      cur.unanswered = true
    }
    out.set(row.taskId, cur)
  }
  return out
}

async function depCounts(taskIds: string[]): Promise<Map<string, { openBlockers: number; blocking: number }>> {
  const out = new Map<string, { openBlockers: number; blocking: number }>()
  if (!taskIds.length) return out
  // Внешнюю задачу берём под явным алиасом «outer_t».
  //
  // Подзапрос сам обращается к tasks (нужен статус блокера), и без алиаса
  // ссылка на «id» разрешалась во ВНУТРЕННЮЮ таблицу из join, а не во внешнюю
  // строку: Postgres честно отвечал «column reference "id" is ambiguous», и
  // весь список задач падал с 500 — при том, что одиночная задача работала.
  const rows = await db.execute<{ id: string; open_blockers: number; blocking: number }>(sql`
    select outer_t.id as id,
      (select count(*)::int from ${taskBlockers} b
        join ${tasks} bt on bt.id = b.blocker_task_id
        where b.blocked_task_id = outer_t.id
          and bt.status <> 'done' and bt.deleted_at is null) as open_blockers,
      (select count(*)::int from ${taskBlockers} b
        join ${tasks} dt on dt.id = b.blocked_task_id
        where b.blocker_task_id = outer_t.id
          and dt.deleted_at is null) as blocking
    from ${tasks} outer_t
    where outer_t.id in (${sql.join(taskIds.map((x) => sql`${x}`), sql`, `)})
  `)
  for (const r of rows) out.set(r.id, { openBlockers: r.open_blockers, blocking: r.blocking })
  return out
}

// --- Задачи -----------------------------------------------------------------

bridgeRoute.get('/tasks', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.read', scope.projectId)
  if (denied) return c.json(denied, 403)

  const conds = [eq(tasks.projectId, scope.projectId), isNull(tasks.deletedAt)]
  const assignee = c.req.query('assignee')
  if (assignee) {
    const resolved = await resolveAssignee(id, scope.projectId, assignee)
    if (resolved === undefined) return c.json({ error: `Unknown assignee: ${assignee}` }, 400)
    conds.push(resolved === null ? isNull(tasks.assigneeId) : eq(tasks.assigneeId, resolved))
  }
  const status = c.req.query('status')
  if (status) {
    const list = status.split(',').filter(Boolean) as ('todo' | 'in_progress' | 'review' | 'verified' | 'done')[]
    conds.push(inArray(tasks.status, list))
  }
  const sprint = c.req.query('sprint')
  if (sprint) conds.push(eq(tasks.groupId, sprint))
  const q = c.req.query('q')?.trim()
  if (q) conds.push(or(ilike(tasks.title, `%${q}%`), ilike(tasks.description, `%${q}%`))!)

  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50))
  const rows = await db
    .select({ t: tasks, u: users })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .where(and(...conds))
    .orderBy(desc(tasks.updatedAt))
    .limit(limit)

  // Сколько задач ПОДОШЛО под фильтр, а не сколько поместилось в ответ.
  //
  // Без этого числа список молча обрезался: спринт из шестидесяти задач
  // приезжал полусотней, count говорил «50», и ассистент честно докладывал
  // «закрыл весь спринт», закрыв пятьдесят из шестидесяти. Обрезание, о
  // котором не сказано, читается как полнота — а групповые ручки как раз и
  // собирают список из этого ответа.
  const [{ total }] = (await db
    .select({ total: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(...conds))) as [{ total: number }]

  // Короткий вид: номер, название и главные поля, без описаний и вложений.
  //
  // Описание — цельный HTML тела задачи, и весит оно на порядок больше всего
  // остального: на живом проекте описания заняли 34 КБ против 2 КБ названий,
  // одно доходит до 3.5 КБ. Когда список нужен, чтобы ВЫБРАТЬ задачи и отдать
  // их номера в групповую ручку, все эти килобайты уходят в контекст впустую
  // и вытесняют оттуда то, ради чего ассистента позвали.
  if (c.req.query('fields') === 'brief') {
    const briefDeps = await depCounts(rows.map((r) => r.t.id))
    const chatter = await commentActivity(
      rows.map((r) => r.t.id),
      id.userId,
    )
    return c.json({
      items: rows.map((r) => ({
        id: r.t.id,
        number: r.t.number,
        title: r.t.title,
        status: r.t.status,
        priority: r.t.priority,
        refs: r.t.refs || undefined,
        sprintId: r.t.groupId,
        assignee: r.u ? { id: r.u.id, name: r.u.name } : null,
        // Ждёт ли задача чего-то — нужно и в кратком виде: именно по нему
        // выбирают, за что браться.
        openBlockers: briefDeps.get(r.t.id)?.openBlockers ?? 0,
        blocking: briefDeps.get(r.t.id)?.blocking ?? 0,
        // Где шла беседа — видно из списка, без чтения каждой задачи подряд.
        commentCount: chatter.get(r.t.id)?.count ?? 0,
        lastCommentAt: chatter.get(r.t.id)?.lastAt ?? null,
        // Главное поле: здесь спросили меня, и я ещё не ответил.
        unansweredMention: chatter.get(r.t.id)?.unanswered ?? false,
      })),
      count: rows.length,
      total,
      truncated: total > rows.length,
    })
  }

  const byTask = await attachmentsFor(
    files.taskId,
    rows.map((r) => r.t.id),
    scope.projectId,
    new Map(rows.map((r) => [r.t.id, r.t.description])),
  )
  const deps = await depCounts(rows.map((r) => r.t.id))
  // Компания — один раз на весь список: она у всех задач одна, а внутри
  // taskView запрос повторился бы на каждую строку.
  const listCompanyId = await companyOf(scope.projectId)
  return c.json({
    items: rows.map((r) => taskView(r.t, r.u, byTask.get(r.t.id), deps.get(r.t.id), listCompanyId)),
    count: rows.length,
    total,
    // Явный признак, а не «сравни два числа сам»: пропустить его труднее.
    truncated: total > rows.length,
  })
})

/**
 * Одинаковая правка сразу многим задачам.
 *
 * Зачем: «проставь номера всем экранам», «перекинь спринт», «закрой всё
 * проверенное» — это десятки задач. По одному запросу на штуку ассистент
 * упирается в лимиты, теряет середину списка и не может сказать, что именно
 * прошло. Здесь одно тело, один ответ, и в ответе видно каждую задачу.
 *
 * Объявлено ДО '/tasks/:id': иначе параметр съел бы слово bulk и правка
 * пришла бы в задачу с номером «bulk».
 */
bridgeRoute.patch('/tasks/bulk', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const bad = unknownFields(b, BULK_FIELDS)
  if (bad) return c.json({ error: bad }, 400)

  if (!Array.isArray(b.tasks) || !b.tasks.length) {
    return c.json({ error: 'tasks must be a non-empty array of task numbers or ids' }, 400)
  }
  // Потолок на партию: ассистент охотно присылает «все задачи проекта», а это
  // и запрос на минуту, и уведомление каждому участнику по каждой задаче.
  if (b.tasks.length > BULK_MAX) {
    return c.json({ error: `Too many tasks: ${b.tasks.length}. Maximum ${BULK_MAX} per request.` }, 400)
  }

  // Что меняем — одно и то же для всех. Разбираем ОДИН раз и теми же
  // правилами, что в одиночном PATCH: расхождение здесь означало бы, что
  // через партию можно записать то, что поштучно запрещено.
  const set = (b.set ?? {}) as Record<string, unknown>
  if (typeof set !== 'object' || Array.isArray(set)) return c.json({ error: 'set must be an object' }, 400)
  const badSet = unknownFields(set, TASK_FIELDS)
  if (badSet) return c.json({ error: badSet }, 400)

  const patch: Record<string, unknown> = {}
  if (typeof set.title === 'string') patch.title = set.title.slice(0, 300)
  if (typeof set.description === 'string') patch.description = richText(set.description)
  if ((['todo', 'in_progress', 'review', 'verified', 'done'] as const).includes(set.status as never)) patch.status = set.status
  if ((['low', 'normal', 'high', 'urgent'] as const).includes(set.priority as never)) patch.priority = set.priority
  if (set.estimateMinutes !== undefined) patch.estimateMinutes = set.estimateMinutes == null ? null : String(set.estimateMinutes)
  {
    const due = parseDue(set.dueDate)
    if (due !== undefined) setDue(patch, due)
  }
  if (set.sprintId !== undefined) patch.groupId = set.sprintId ?? null
  if (set.assignee !== undefined) {
    const resolved = await resolveAssignee(id, scope.projectId, set.assignee)
    if (resolved === undefined) return c.json({ error: `Unknown assignee: ${String(set.assignee)}` }, 400)
    patch.assigneeId = resolved
  }

  // Номера — единственное поле, у которого своё значение на каждую задачу:
  // «проставь 19.1, 19.2, 21.3» ровно за этим сюда и приходят. Общий refs в
  // set тоже допустим — когда номер один на всех.
  const refsById = (b.refs ?? null) as Record<string, unknown> | null
  if (refsById !== null && (typeof refsById !== 'object' || Array.isArray(refsById))) {
    return c.json({ error: 'refs must be an object mapping task number or id to its refs string' }, 400)
  }
  if (typeof set.refs === 'string') patch.refs = normalizeRefs(set.refs)

  if (!Object.keys(patch).length && !refsById) return c.json({ error: 'Nothing to update' }, 400)

  // Права — по тому, ЧТО меняют, ровно как поштучно: двигать по доске может
  // любой, кто видит задачи, переписывать — только tasks.edit. Персональные
  // номера это правка, поэтому одного changeStatus для них мало.
  const statusOnly = !refsById && Object.keys(patch).every((k) => k === 'status' || k === 'groupId' || k === 'sortOrder')
  const denied = await require(c as never, statusOnly ? 'tasks.changeStatus' : 'tasks.edit', scope.projectId)
  if (denied) return c.json(denied, 403)

  // Ключ задачи → строка номеров. Регистр приводим: TASK-4 и task-4 — одно.
  const refsKey = new Map<string, string>()
  for (const [k, v] of Object.entries(refsById ?? {})) {
    if (typeof v !== 'string') return c.json({ error: `refs.${k} must be a string` }, 400)
    refsKey.set(k.trim().toUpperCase(), v)
  }

  const wanted = b.tasks.map((x) => String(x).trim()).filter(Boolean)
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, scope.projectId), isNull(tasks.deletedAt)))
  const byKey = new Map<string, (typeof rows)[number]>()
  for (const r of rows) {
    byKey.set(r.id.toUpperCase(), r)
    byKey.set(r.number.toUpperCase(), r)
  }

  // Одна на всю пачку: задачи из одного проекта.
  const bulkCompanyId = await companyOf(scope.projectId)
  const updated: ReturnType<typeof taskView>[] = []
  const failed: { task: string; error: string }[] = []
  const touched = new Set<string | null>()

  for (const key of wanted) {
    const existing = byKey.get(key.toUpperCase())
    if (!existing) {
      failed.push({ task: key, error: 'Not found in this project' })
      continue
    }
    // Чужую задачу не переписываем — то же правило, что поштучно и в вебе.
    // Проверяем КАЖДУЮ: иначе партия стала бы способом обойти проверку,
    // подмешав к своим задачам чужие.
    if (!statusOnly && !(await ownsOrManages(scope.projectId, id.userId, [existing.createdById, existing.assigneeId]))) {
      failed.push({ task: existing.number, error: 'Forbidden: you can only edit tasks you created or that are assigned to you' })
      continue
    }

    const own = { ...patch }
    const personal = refsKey.get(existing.id.toUpperCase()) ?? refsKey.get(existing.number.toUpperCase())
    if (personal !== undefined) own.refs = normalizeRefs(personal)
    if (!Object.keys(own).length) {
      failed.push({ task: existing.number, error: 'Nothing to update for this task' })
      continue
    }

    const [row] = await db.update(tasks).set(own).where(eq(tasks.id, existing.id)).returning()
    void logActivity({
      projectId: scope.projectId,
      actorId: id.userId,
      action: 'update',
      entityType: 'task',
      entityId: existing.id,
      entityLabel: `${row!.number} ${row!.title}`,
    })
    // Уведомления те же, что поштучно: партия не повод молча менять чужую
    // задачу — человек должен узнать, что с его работой что-то сделали.
    const assigneeChanged = own.assigneeId !== undefined && own.assigneeId !== existing.assigneeId
    void notifyTask(scope.projectId, id.userId, row!, {
      assigneeChanged: assigneeChanged && Boolean(row!.assigneeId),
      statusChanged: own.status !== undefined && own.status !== existing.status,
      mentions: own.description !== undefined && own.description !== existing.description,
    })
    if (assigneeChanged && existing.assigneeId) void unassignNotice(existing.assigneeId, existing.id)
    for (const u of [row!.assigneeId, row!.createdById, existing.assigneeId, existing.createdById]) touched.add(u)

    const who = row!.assigneeId ? await db.query.users.findFirst({ where: eq(users.id, row!.assigneeId) }) : null
    updated.push(taskView(row!, who, undefined, undefined, bulkCompanyId))
  }

  // Список обновляем один раз на всю партию, а не на каждую задачу.
  if (updated.length) tasksChanged(scope.projectId, [...touched])

  // Провалы отдаём рядом с успехами, а не прячем: «ok» на запрос, где половина
  // задач не нашлась, — худший исход. Ассистент доложит о сделанном, а сделана
  // будет половина.
  return c.json({ updated: updated.length, failed: failed.length, items: updated, errors: failed })
})

/**
 * Удалить сразу несколько задач.
 *
 * Удаление здесь мягкое и обратимое: запись уходит в корзину на семь дней, и
 * вернуть её ассистент может сам через /x/trash. Поштучно мост это давно
 * умеет, так что партия не даёт новых прав — только избавляет от тридцати
 * запросов подряд, на середине которых ассистент теряет нить и не может
 * сказать, что успел удалить.
 *
 * Права считаем ПО КАЖДОЙ задаче, как и поштучно: свою удаляет участник,
 * чужую — только с tasks.delete. Одной проверки на всю партию хватило бы,
 * чтобы к своим задачам подмешать чужие.
 *
 * Объявлено ДО '/tasks/:id' — иначе слово bulk уедет в параметр.
 */
bridgeRoute.delete('/tasks/bulk', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const bad = unknownFields(b, ['tasks', 'project'])
  if (bad) return c.json({ error: bad }, 400)

  if (!Array.isArray(b.tasks) || !b.tasks.length) {
    return c.json({ error: 'tasks must be a non-empty array of task numbers or ids' }, 400)
  }
  if (b.tasks.length > BULK_MAX) {
    return c.json({ error: `Too many tasks: ${b.tasks.length}. Maximum ${BULK_MAX} per request.` }, 400)
  }

  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, scope.projectId), isNull(tasks.deletedAt)))
  const byKey = new Map<string, (typeof rows)[number]>()
  for (const r of rows) {
    byKey.set(r.id.toUpperCase(), r)
    byKey.set(r.number.toUpperCase(), r)
  }

  const deleted: { id: string; number: string; title: string }[] = []
  const failed: { task: string; error: string }[] = []
  const touched = new Set<string | null>()

  for (const raw of b.tasks.map((x) => String(x).trim()).filter(Boolean)) {
    const existing = byKey.get(raw.toUpperCase())
    if (!existing) {
      failed.push({ task: raw, error: 'Not found in this project' })
      continue
    }
    const own = await ownsOrManages(scope.projectId, id.userId, [existing.createdById, existing.assigneeId])
    const denied = await require(c as never, own ? 'tasks.create' : 'tasks.delete', scope.projectId)
    if (denied) {
      failed.push({ task: existing.number, error: 'Forbidden: not yours to delete' })
      continue
    }

    await db.update(tasks).set({ deletedAt: new Date(), deletedById: id.userId }).where(eq(tasks.id, existing.id))
    // Задачи нет в списках — уведомлению о ней там тоже делать нечего.
    if (existing.assigneeId) void unassignNotice(existing.assigneeId, existing.id)
    void logActivity({
      projectId: scope.projectId,
      actorId: id.userId,
      action: 'delete',
      entityType: 'task',
      entityId: existing.id,
      entityLabel: `${existing.number} ${existing.title}`,
    })
    touched.add(existing.assigneeId)
    touched.add(existing.createdById)
    deleted.push({ id: existing.id, number: existing.number, title: existing.title })
  }

  if (deleted.length) tasksChanged(scope.projectId, [...touched])

  return c.json({
    deleted: deleted.length,
    failed: failed.length,
    items: deleted,
    errors: failed,
    restorableForDays: 7,
  })
})

/**
 * Открыть задачу по ссылке — короткой, длинной или по номеру.
 *
 * Человек кидает ассистенту то, что у него под рукой: адрес из строки
 * браузера, короткую ссылку из чата, «TASK-81» из разговора. Раньше ассистент
 * должен был разобрать это сам и позвать GET /x/tasks/<id> с проектом — а из
 * короткой ссылки проект не выводится вообще: в ней только код, и что за ним
 * стоит, знает лишь база. Свою же ссылку ассистент прочитать не мог.
 *
 * Проект определяем ИЗ ССЫЛКИ, а не требуем параметром: он там уже есть, и
 * спрашивать его второй раз — просить человека сделать работу за машину.
 *
 * Права проверяются как везде: ссылка не даёт доступа к чужому проекту, она
 * лишь избавляет от ручного разбора.
 */
bridgeRoute.get('/open', async (c) => {
  const id = auth(c as never)
  const raw = c.req.query('link') || c.req.query('url') || ''
  const ref = parseTaskRef(raw)
  if (!ref) {
    return c.json(
      {
        error:
          'Could not read that as a task. Pass a task link (https://chatick.com/t-abc12 or .../p/<project>/tasks/<id>) or a number like TASK-81.',
      },
      400,
    )
  }

  // Куда смотреть: короткая ссылка знает проект, длинная называет его, номер —
  // нет, и тогда нужен открытый туннель проекта или ?project=.
  let projectId: string
  let key: string
  if (ref.kind === 'short') {
    const link = await resolveShortCode('task', ref.code)
    if (!link) return c.json({ error: 'That short link does not exist or has expired' }, 404)
    projectId = link.projectId
    key = link.entityId
  } else if (ref.kind === 'long') {
    projectId = ref.projectId
    key = ref.taskId
  } else {
    const scope = await resolveProject(c as never)
    if ('error' in scope) return c.json({ error: scope.error }, scope.status)
    projectId = scope.projectId
    key = ref.number
  }

  // Членство проверяем ВСЕГДА, в том числе для ссылки: она сокращает путь, а
  // не открывает двери. Чужую задачу по чужой ссылке не покажем.
  if (!(await memberDomains(projectId, id.userId))) {
    return c.json({ error: 'You are not a member of that project' }, 403)
  }
  const denied = await require(c as never, 'tasks.read', projectId)
  if (denied) return c.json(denied, 403)

  const row = await db
    .select({ t: tasks, u: users })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .where(
      and(
        or(eq(tasks.id, key), eq(tasks.number, key.toUpperCase()))!,
        eq(tasks.projectId, projectId),
        isNull(tasks.deletedAt),
      ),
    )
    .limit(1)
  if (!row.length) return c.json({ error: 'Not found' }, 404)

  const attached = await attachmentsFor(
    files.taskId,
    [row[0]!.t.id],
    projectId,
    new Map([[row[0]!.t.id, row[0]!.t.description]]),
  )
  const linkedReleases = await releasesOfTask(row[0]!.t.id)
  const taskLinkList = await linksOfTask(row[0]!.t.id)
  // Чек-лист — здесь, а не в taskView: тот зовётся построчно на списках, и
  // запрос внутри превратился бы в полсотни одинаковых. Пустой не показываем,
  // как и версии: у большинства задач его нет.
  const checklist = await checklistCounts(row[0]!.t.id)
  return c.json({
    ...taskView(
      row[0]!.t,
      row[0]!.u,
      attached.get(row[0]!.t.id),
      undefined,
      await companyOf(projectId),
      await shortUrlFor('task', row[0]!.t.id, projectId, id.userId),
    ),
    // Проект называем явно: ассистент пришёл по ссылке и мог не знать, где
    // оказался, — а следующий его вызов потребует projectId.
    projectId,
    ...(linkedReleases.length ? { releases: linkedReleases } : {}),
    ...(checklist ? { checklist } : {}),
    ...taskLinkList,
  })
})

/**
 * Поиск по задачам и их обсуждениям — во ВСЕХ проектах человека.
 *
 * «Где та таска, где я писал» — типичный вопрос, и он не про один проект: в
 * StartPlan люди состоят в 8–20 проектах, и перебирать их руками никто не
 * станет. Обычный GET /x/tasks ищет внутри одного — этого мало.
 *
 * Поиск понимает СМЫСЛ: «оплата не проходит» находит ивритскую задачу
 * «תיקון ה-iframe של התשלום» без единого общего слова. Комментарии
 * индексируются вместе с задачей: ответ чаще в обсуждении, чем в заголовке.
 *
 * Граница — проекты, где человек СОСТОИТ. Не компания: задача принадлежит
 * проекту, и показать её тому, кого туда не звали, значит показать чужое —
 * молча, без всякой ошибки.
 */
bridgeRoute.get('/search/tasks', async (c) => {
  const id = auth(c as never)
  const q = c.req.query('q')?.trim()
  if (!q) return c.json({ error: 'q is required', hint: 'Ask in plain words — meaning is matched, not substrings.' }, 400)

  // Компания из туннеля; на проектном — из проекта, чтобы не переподключаться
  // ради поиска.
  let companyId = id.companyId ?? null
  const askedProject = c.req.query('project')?.trim() || null
  if (!companyId) {
    const scope = await resolveProject(c as never)
    if ('error' in scope) return c.json({ error: scope.error }, scope.status)
    companyId = await companyOf(scope.projectId)
  }
  if (!companyId) return c.json({ error: 'Company unknown' }, 400)

  const found = await searchTaskIds({
    query: q,
    userId: id.userId,
    companyId,
    projectId: askedProject,
    limit: Math.min(50, Math.max(1, Number(c.req.query('limit')) || 20)),
  })
  if (!found.ids.length) {
    return c.json({
      items: [],
      hint: 'Nothing matched. The search goes by meaning, so rephrasing rarely helps — more likely it is simply not there.',
    })
  }

  const rows = await db
    .select({ t: tasks, u: users, p: projects })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .where(inArray(tasks.id, found.ids))

  // Порядок поиска сильнее выборки: ближайшее по смыслу первым.
  const ordered = [...rows].sort((a, b) => found.ids.indexOf(a.t.id) - found.ids.indexOf(b.t.id))

  return c.json({
    items: ordered.map((r) => ({
      id: r.t.id,
      number: r.t.number,
      title: r.t.title,
      status: r.t.status,
      project: { id: r.t.projectId, name: r.p?.name ?? '' },
      assignee: r.u ? { id: r.u.id, name: r.u.name } : null,
      // Найдено по смыслу: общих слов с запросом может не быть вовсе, и без
      // пометки такой ответ выглядит случайным.
      ...(found.semanticIds.has(r.t.id) ? { matchedBy: 'meaning' as const } : {}),
      updatedAt: r.t.updatedAt,
    })),
    hint:
      'Searched across every project you are in. Comments are indexed together with their task, so "where did we discuss X" lands on the task that holds the discussion. Read one with GET /x/tasks/<id>?project=<projectId> — take projectId from the item.',
  })
})

bridgeRoute.get('/tasks/:id', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.read', scope.projectId)
  if (denied) return c.json(denied, 403)
  // Номер ИЛИ id, как и у зависимостей: ассистент оперирует «TASK-81», и
  // требовать здесь uuid значило бы держать две разные привычки для соседних
  // ручек. Ровно на этом он и спотыкался, когда терялся idmap.
  const key = c.req.param('id').trim()
  const row = await db
    .select({ t: tasks, u: users })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .where(
      and(
        or(eq(tasks.id, key), eq(tasks.number, key.toUpperCase()))!,
        eq(tasks.projectId, scope.projectId),
        isNull(tasks.deletedAt),
      ),
    )
    .limit(1)
  if (!row.length) return c.json({ error: 'Not found' }, 404)
  const attached = await attachmentsFor(
    files.taskId,
    [row[0]!.t.id],
    scope.projectId,
    new Map([[row[0]!.t.id, row[0]!.t.description]]),
  )
  // Версии показываем всегда, а не по запросу: «к какой версии эта задача» —
  // вопрос того же ряда, что и «кто исполнитель», и ради него незачем делать
  // второй запрос.
  const linkedReleases = await releasesOfTask(row[0]!.t.id)
  const taskLinkList = await linksOfTask(row[0]!.t.id)
  // Чек-лист — по тому же доводу, что и версии выше. Задача с десятью
  // вопросами выглядела задачей без них, и ответы были не видны нигде.
  const checklist = await checklistCounts(row[0]!.t.id)
  return c.json({
    ...taskView(
      row[0]!.t,
      row[0]!.u,
      attached.get(row[0]!.t.id),
      undefined,
      await companyOf(scope.projectId),
      await shortUrlFor('task', row[0]!.t.id, scope.projectId, id.userId),
    ),
    ...(linkedReleases.length ? { releases: linkedReleases } : {}),
    ...(checklist ? { checklist } : {}),
    ...taskLinkList,
  })
})

bridgeRoute.post('/tasks', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.create', scope.projectId)
  if (denied) return c.json(denied, 403)

  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const bad = unknownFields(b, TASK_FIELDS)
  if (bad) return c.json({ error: bad }, 400)

  const title = typeof b.title === 'string' ? b.title.trim() : ''
  if (!title) return c.json({ error: 'title is required' }, 400)

  const assigneeId = await resolveAssignee(id, scope.projectId, b.assignee)
  if (b.assignee !== undefined && assigneeId === undefined) return c.json({ error: `Unknown assignee: ${String(b.assignee)}` }, 400)

  // Номер = max+1, а НЕ count: удалённые задачи оставляют дыры, и count
  // повторно выдаёт уже занятый номер (unique-индекс project+number).
  const [{ next }] = (await db
    .select({ next: sql<number>`coalesce(max(cast(substring(${tasks.number} from 6) as int)), 0) + 1` })
    .from(tasks)
    .where(eq(tasks.projectId, scope.projectId))) as [{ next: number }]

  const [row] = await db
    .insert(tasks)
    .values({
      projectId: scope.projectId,
      number: `TASK-${next}`,
      title: title.slice(0, 300),
      description: typeof b.description === 'string' ? richText(b.description) : '',
      status: (['todo', 'in_progress', 'review', 'verified', 'done'] as const).includes(b.status as never)
        ? (b.status as 'todo')
        : 'todo',
      priority: (['low', 'normal', 'high', 'urgent'] as const).includes(b.priority as never)
        ? (b.priority as 'normal')
        : 'normal',
      assigneeId: assigneeId ?? null,
      estimateMinutes: b.estimateMinutes != null ? String(b.estimateMinutes) : null,
      refs: typeof b.refs === 'string' ? normalizeRefs(b.refs) : '',
      groupId: typeof b.sprintId === 'string' ? b.sprintId : null,
      dueDate: parseDue(b.dueDate),
      createdById: id.userId,
    })
    .returning()

  void logActivity({
    projectId: scope.projectId,
    actorId: id.userId,
    action: 'create',
    entityType: 'task',
    entityId: row!.id,
    entityLabel: `${row!.number} ${row!.title}`,
  })
  const attachments = await attachToTask(b.attachmentIds, scope.projectId, id.userId, row!.id)
  const resources = b.resourceIds !== undefined ? await linkResources(b.resourceIds, scope.projectId, row!.id) : []
  const taskReleaseList = b.releaseIds !== undefined ? await linkReleases(b.releaseIds, scope.projectId, row!.id) : []
  const linked = await linkTasks(b.links, scope.projectId, row!.id, id.userId)
  // Назначение через мост затрагивает человека ровно так же, как из интерфейса:
  // раньше задача сваливалась на него молча.
  void notifyTask(scope.projectId, id.userId, row!, { assigneeChanged: Boolean(row!.assigneeId), mentions: true })
  tasksChanged(scope.projectId, [row!.assigneeId, row!.createdById])
  // подтягиваем исполнителя, чтобы агент сразу видел, на кого задача ушла
  const who = row!.assigneeId ? await db.query.users.findFirst({ where: eq(users.id, row!.assigneeId) }) : null
  return c.json(
    {
      ...taskView(
        row!,
        who,
        undefined,
        undefined,
        await companyOf(scope.projectId),
        await shortUrlFor('task', row!.id, scope.projectId, id.userId),
      ),
      attachments,
      ...(b.releaseIds !== undefined ? { releases: taskReleaseList } : {}),
      // Сколько связей реально легло: ненайденные номера пропускаются молча,
      // и без этого поля ассистент считал бы связанным то, что не связалось.
      ...(linked.length ? { links: linked } : {}),
    },
    201,
  )
})

bridgeRoute.patch('/tasks/:id', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  // Номер или id — одинаково во всех ручках задачи.
  const existing = await taskByKey(scope.projectId, c.req.param('id'))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const taskId = existing.id

  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const bad = unknownFields(b, TASK_FIELDS)
  if (bad) return c.json({ error: bad }, 400)

  const patch: Record<string, unknown> = {}
  if (typeof b.title === 'string') patch.title = b.title.slice(0, 300)
  if (typeof b.description === 'string') patch.description = richText(b.description)
  if ((['todo', 'in_progress', 'review', 'verified', 'done'] as const).includes(b.status as never)) patch.status = b.status
  if ((['low', 'normal', 'high', 'urgent'] as const).includes(b.priority as never)) patch.priority = b.priority
  if (b.estimateMinutes !== undefined) patch.estimateMinutes = b.estimateMinutes == null ? null : String(b.estimateMinutes)
  {
    const due = parseDue(b.dueDate)
    if (due !== undefined) setDue(patch, due)
  }
  if (typeof b.refs === 'string') patch.refs = normalizeRefs(b.refs)
  if (b.sprintId !== undefined) patch.groupId = b.sprintId ?? null
  if (b.assignee !== undefined) {
    const resolved = await resolveAssignee(id, scope.projectId, b.assignee)
    if (resolved === undefined) return c.json({ error: `Unknown assignee: ${String(b.assignee)}` }, 400)
    patch.assigneeId = resolved
  }

  // Вложения и ресурсы живут не в полях задачи, а в своих таблицах — но это
  // такое же изменение. Без этой оговорки запрос «привяжи ресурс к задаче»
  // отвергался с «Nothing to update»: поле разрешено, в списке допустимых
  // есть, а ручка считала тело пустым.
  if (
    !Object.keys(patch).length &&
    b.attachmentIds === undefined &&
    b.resourceIds === undefined &&
    b.releaseIds === undefined &&
    b.links === undefined
  ) {
    return c.json({ error: 'Nothing to update' }, 400)
  }

  // Права — по тому, ЧТО меняют, как и в вебе: передвинуть карточку по доске
  // может любой, кто видит задачи; переписывать её — только tasks.edit.
  //
  // Проверяем после разбора всего тела: иначе смена срока или исполнителя
  // проскочила бы мимо проверки. Раньше мост требовал tasks.edit на любое
  // изменение, и участник не мог отметить сделанной даже назначенную на него
  // задачу — при том, что документы и заметки писать ему разрешено.
  const statusOnly = Object.keys(patch).every((k) => k === 'status' || k === 'groupId' || k === 'sortOrder')
  const denied = await require(c as never, statusOnly ? 'tasks.changeStatus' : 'tasks.edit', scope.projectId)
  if (denied) return c.json(denied, 403)
  // Чужую задачу не переписываем — то же правило, что в интерфейсе: иначе
  // ассистент может больше, чем человек, от чьего имени он действует.
  if (!statusOnly && !(await ownsOrManages(scope.projectId, id.userId, [existing.createdById, existing.assigneeId]))) {
    return c.json({ error: 'Forbidden: you can only edit tasks you created or that are assigned to you' }, 403)
  }

  // Пустой set() — ошибка драйвера, а не безобидный no-op: запрос, меняющий
  // только вложения или ресурсы, не трогает полей самой задачи.
  const [row] = Object.keys(patch).length
    ? await db.update(tasks).set(patch).where(eq(tasks.id, taskId)).returning()
    : [existing]
  void logActivity({
    projectId: scope.projectId,
    actorId: id.userId,
    action: 'update',
    entityType: 'task',
    entityId: taskId,
    entityLabel: `${row!.number} ${row!.title}`,
  })
  const attachments = await attachToTask(b.attachmentIds, scope.projectId, id.userId, row!.id)
  const resources = b.resourceIds !== undefined ? await linkResources(b.resourceIds, scope.projectId, row!.id) : []
  const taskReleaseList = b.releaseIds !== undefined ? await linkReleases(b.releaseIds, scope.projectId, row!.id) : []
  // Связи ДОБАВЛЯЮТСЯ, а не заменяют прежние, — в отличие от releaseIds.
  // Разница намеренная: «эта задача выросла ещё и вот из этой» дописывает
  // историю, а стереть её молча, прислав короткий список, было бы потерей.
  // Убирают связь отдельной ручкой DELETE, где это видно по названию.
  const linkedNow = b.links !== undefined ? await linkTasks(b.links, scope.projectId, row!.id, id.userId) : []
  // Те же уведомления, что из интерфейса: назначили — сказали, сняли — убрали.
  const assigneeChanged = patch.assigneeId !== undefined && patch.assigneeId !== existing.assigneeId
  void notifyTask(scope.projectId, id.userId, row!, {
    assigneeChanged: assigneeChanged && Boolean(row!.assigneeId),
    statusChanged: patch.status !== undefined && patch.status !== existing.status,
    mentions: patch.description !== undefined && patch.description !== existing.description,
  })
  if (assigneeChanged && existing.assigneeId) void unassignNotice(existing.assigneeId, existing.id)
  tasksChanged(scope.projectId, [row!.assigneeId, row!.createdById, existing.assigneeId, existing.createdById])
  const who = row!.assigneeId ? await db.query.users.findFirst({ where: eq(users.id, row!.assigneeId) }) : null
  return c.json({
    ...taskView(
      row!,
      who,
      undefined,
      undefined,
      await companyOf(scope.projectId),
      await shortUrlFor('task', row!.id, scope.projectId, id.userId),
    ),
    ...(b.attachmentIds !== undefined ? { attachments } : {}),
    ...(b.resourceIds !== undefined ? { resources } : {}),
    ...(b.releaseIds !== undefined ? { releases: taskReleaseList } : {}),
    ...(linkedNow.length ? { links: linkedNow } : {}),
  })
})

bridgeRoute.delete('/tasks/:id', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  // Номер или id — одинаково во всех ручках задачи.
  const existing = await taskByKey(scope.projectId, c.req.param('id'))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const taskId = existing.id

  // Свою задачу удаляет и участник; чужую — только с tasks.delete. То же
  // правило, что в интерфейсе: удаление мягкое, восстановимо 7 дней.
  const own = await ownsOrManages(scope.projectId, id.userId, [existing.createdById, existing.assigneeId])
  const denied = await require(c as never, own ? 'tasks.create' : 'tasks.delete', scope.projectId)
  if (denied) return c.json(denied, 403)

  await db.update(tasks).set({ deletedAt: new Date(), deletedById: id.userId }).where(eq(tasks.id, taskId))
  // Задачи нет в списках — уведомлению о ней там тоже делать нечего.
  if (existing.assigneeId) void unassignNotice(existing.assigneeId, existing.id)
  void logActivity({
    projectId: scope.projectId,
    actorId: id.userId,
    action: 'delete',
    entityType: 'task',
    entityId: taskId,
    entityLabel: `${existing.number} ${existing.title}`,
  })
  tasksChanged(scope.projectId, [existing.assigneeId, existing.createdById])
  return c.json({ ok: true, restorableForDays: 7 })
})

// --- Корзина -----------------------------------------------------------------
//
// Мост умеет удалять задачи и файлы и честно отвечает «restorableForDays: 7».
// Но заглянуть в корзину и вернуть удалённое он не мог — обещание было пустым:
// ассистент, удаливший не то, отправлял человека чинить это руками. А через
// семь дней запись стирает уборщик (lib/file-cleanup.ts), и чинить уже нечего.

/** Сколько дней осталось на возврат: удалённое старше семи суток уже не спасти. */
function daysLeft(deletedAt: Date | null): number {
  if (!deletedAt) return 0
  return Math.max(0, 7 - Math.floor((Date.now() - deletedAt.getTime()) / 86_400_000))
}

bridgeRoute.get('/trash', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.read', scope.projectId)
  if (denied) return c.json(denied, 403)

  const want = (c.req.query('type') ?? '').trim()
  const [deletedTasks, deletedFiles] = await Promise.all([
    want && want !== 'task'
      ? []
      : db
          .select({ t: tasks, u: users })
          .from(tasks)
          .leftJoin(users, eq(users.id, tasks.deletedById))
          .where(and(eq(tasks.projectId, scope.projectId), sql`${tasks.deletedAt} is not null`))
          .orderBy(desc(tasks.deletedAt))
          .limit(100),
    want && want !== 'file'
      ? []
      : db
          .select({ f: files, u: users })
          .from(files)
          .leftJoin(users, eq(users.id, files.deletedById))
          .where(and(eq(files.projectId, scope.projectId), sql`${files.deletedAt} is not null`))
          .orderBy(desc(files.deletedAt))
          .limit(100),
  ])

  const items = [
    ...deletedTasks.map((r) => ({
      type: 'task' as const,
      id: r.t.id,
      label: `${r.t.number} ${r.t.title}`,
      deletedAt: r.t.deletedAt,
      deletedBy: r.u?.name ?? null,
      daysLeft: daysLeft(r.t.deletedAt),
      restore: `POST /x/tasks/${r.t.id}/restore`,
    })),
    ...deletedFiles.map((r) => ({
      type: 'file' as const,
      id: r.f.id,
      label: r.f.name,
      deletedAt: r.f.deletedAt,
      deletedBy: r.u?.name ?? null,
      daysLeft: daysLeft(r.f.deletedAt),
      restore: `POST /x/files/${r.f.id}/restore`,
    })),
  ].sort((a, b) => (b.deletedAt?.getTime() ?? 0) - (a.deletedAt?.getTime() ?? 0))

  return c.json({ items, hint: 'Deleted items are purged for good after 7 days — daysLeft says how long is left.' })
})

bridgeRoute.post('/tasks/:id/restore', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.delete', scope.projectId)
  if (denied) return c.json(denied, 403)

  // Здесь ищем ВКЛЮЧАЯ удалённые — восстанавливать нечего, если не видеть
  // корзину. Общий taskByKey не подходит: он живые задачи и отдаёт.
  const key = c.req.param('id').trim()
  const task = await db.query.tasks.findFirst({
    where: and(
      or(eq(tasks.id, key), eq(tasks.number, key.toUpperCase()))!,
      eq(tasks.projectId, scope.projectId),
    ),
  })
  if (!task) return c.json({ error: 'Not found' }, 404)
  if (!task.deletedAt) return c.json({ error: 'That task is not in the trash' }, 400)

  await db.update(tasks).set({ deletedAt: null, deletedById: null }).where(eq(tasks.id, task.id))
  void logActivity({
    projectId: scope.projectId,
    actorId: id.userId,
    action: 'restore',
    entityType: 'task',
    entityId: task.id,
    entityLabel: `${task.number}: ${task.title}`,
  })
  tasksChanged(scope.projectId, [task.assigneeId, task.createdById])
  return c.json({ ok: true, id: task.id, number: task.number, title: task.title })
})

bridgeRoute.post('/files/:id/restore', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const file = await db.query.files.findFirst({
    where: and(eq(files.id, c.req.param('id')), eq(files.projectId, scope.projectId)),
  })
  if (!file) return c.json({ error: 'Not found' }, 404)
  if (!file.deletedAt) return c.json({ error: 'That file is not in the trash' }, 400)

  // Свой файл возвращает и тот, кто его загрузил, — как в интерфейсе.
  const own = file.uploadedById === id.userId
  if (!own) {
    const denied = await require(c as never, 'files.delete', scope.projectId)
    if (denied) return c.json(denied, 403)
  }

  await db.update(files).set({ deletedAt: null, deletedById: null }).where(eq(files.id, file.id))
  void logActivity({
    projectId: scope.projectId,
    actorId: id.userId,
    action: 'restore',
    entityType: 'file',
    entityId: file.id,
    entityLabel: file.name,
  })
  return c.json({ ok: true, id: file.id, name: file.name })
})

// --- Комментарии к задаче ---------------------------------------------------

// --- чек-лист задачи --------------------------------------------------------
//
// Ассистент и задаёт вопросы по задаче, и закрывает пункты, когда сделал.
// Права те же, что у человека, от чьего имени он работает.

// --- Зависимости между задачами ---------------------------------------------
//
// «Эта ждёт ту». Ассистент разбирает макет и первым видит, что оплата не
// делается раньше авторизации, — а расставить это до сих пор не мог.
//
// Проверка колец — та же функция, что и в вебе, а не своя копия: разойдись они,
// и через мост стало бы можно создать связь, запрещённую в интерфейсе.

/** Краткий вид связанной задачи: список зависимостей, а не карточки. */
const linkedView = (t: typeof tasks.$inferSelect) => ({
  id: t.id,
  number: t.number,
  title: t.title,
  status: t.status,
  refs: t.refs || undefined,
})

/** Задача по номеру ИЛИ id — ассистент оперирует номерами. */
async function taskByKey(projectId: string, key: string) {
  const raw = key.trim()
  return db.query.tasks.findFirst({
    where: and(
      eq(tasks.projectId, projectId),
      isNull(tasks.deletedAt),
      or(eq(tasks.id, raw), eq(tasks.number, raw.toUpperCase()))!,
    ),
  })
}

/**
 * Что держит проект и с кого спрашивать.
 *
 * Ответ на вопрос, который человек задаёт первым: «почему не движется?».
 * Собрать это из /x/tasks можно было и раньше, но пришлось бы вытянуть все
 * задачи, построить граф самому и не ошибиться — а ошибка тут тихая: назовёшь
 * не того ответственного, и человек пойдёт торопить постороннего.
 *
 * Отдаём цепочками, а не плоским списком: важно не «сколько заблокировано», а
 * что одна закрытая задача разблокирует пятерых. Порядок — по весу: сверху то,
 * с чего начинать.
 */
// --- Внешние БД проекта (шаг 1: только чтение) ------------------------------
//
// Ассистенту нужно знать, что за база у проекта, и уметь достать оттуда факты:
// «сколько заказов за месяц», «какие поля у таблицы настроек». Без этого он
// рассуждает о данных, которых не видел.
//
// Писать он не может ничего: read-only транзакция, и это гарантия СУБД, а не
// наша проверка.

bridgeRoute.get('/db', async (c) => {
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  if (env.DB_CONNECTIONS_ENABLED !== 'true') return c.json({ error: 'Not found' }, 404)
  const denied = await require(c as never, 'resources.read', scope.projectId)
  if (denied) return c.json(denied, 403)

  const rows = await db
    .select()
    .from(dbConnections)
    .where(and(eq(dbConnections.projectId, scope.projectId), isNull(dbConnections.deletedAt)))

  const items = await Promise.all(
    rows.map(async (r) => {
      const pol = await db.select().from(dbTablePolicies).where(eq(dbTablePolicies.connectionId, r.id))
      const readable = pol.filter((p) => p.canRead)
      return {
        id: r.id,
        name: r.name,
        kind: r.kind,
        // Хост и база — чтобы ассистент понимал, о какой системе речь.
        // Строки подключения здесь нет и не будет: она прошла бы через
        // историю внешней модели и осталась там навсегда.
        host: r.host,
        database: r.database,
        // Читать можно ТОЛЬКО это. Список отдаём сразу: иначе ассистент
        // сочиняет запрос к таблице, которой для него не существует, и
        // получает отказ вместо ответа.
        readableTables: readable.map((p) => ({
          name: p.schemaName === 'public' ? p.tableName : `${p.schemaName}.${p.tableName}`,
          hiddenColumns: JSON.parse(p.hiddenColumns || '[]') as string[],
        })),
      }
    }),
  )
  return c.json({ items, writable: false })
})

bridgeRoute.post('/db/:id/read', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  if (env.DB_CONNECTIONS_ENABLED !== 'true') return c.json({ error: 'Not found' }, 404)
  const denied = await require(c as never, 'resources.read', scope.projectId)
  if (denied) return c.json(denied, 403)

  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const bad = unknownFields(b, ['sql', 'limit', 'project'])
  if (bad) return c.json({ error: bad }, 400)
  const sqlText = typeof b.sql === 'string' ? b.sql.trim() : ''
  if (!sqlText) return c.json({ error: 'sql is required' }, 400)

  const r = await readFromConnection({
    projectId: scope.projectId,
    userId: id.userId,
    connectionId: c.req.param('id'),
    sql: sqlText,
    limit: typeof b.limit === 'number' ? b.limit : undefined,
    viaBridge: true,
  })
  if ('error' in r) return c.json({ error: r.error }, r.status)
  return c.json(r.result)
})

bridgeRoute.get('/blockers', async (c) => {
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.read', scope.projectId)
  if (denied) return c.json(denied, 403)

  const companyId = (await companyOf(scope.projectId)) ?? ''
  const url = (taskId: string) => `${APP()}/#${projectPath(companyId, scope.projectId, `/tasks/${taskId}`)}`

  // Все живые связи проекта одним запросом: и держащая задача, и ждущая, и оба
  // исполнителя. По одной задаче за раз это N запросов на ровном месте.
  const rows = await db
    .select({
      blockerId: tasks.id,
      blockerNumber: tasks.number,
      blockerTitle: tasks.title,
      blockerStatus: tasks.status,
      blockerAssignee: users.name,
      blockerAssigneeId: users.id,
      blockedId: sql<string>`blocked.id`,
      blockedNumber: sql<string>`blocked.number`,
      blockedTitle: sql<string>`blocked.title`,
      blockedStatus: sql<string>`blocked.status`,
    })
    .from(taskBlockers)
    .innerJoin(tasks, eq(tasks.id, taskBlockers.blockerTaskId))
    .innerJoin(sql`${tasks} blocked`, sql`blocked.id = ${taskBlockers.blockedTaskId}`)
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .where(
      and(
        eq(taskBlockers.projectId, scope.projectId),
        isNull(tasks.deletedAt),
        sql`blocked.deleted_at is null`,
        // Закрытая задача никого не держит: связь остаётся историей, но в
        // «что мешает сейчас» ей не место.
        sql`${tasks.status} <> 'done'`,
        sql`blocked.status <> 'done'`,
      ),
    )

  // Группируем по держащей задаче.
  const byBlocker = new Map<
    string,
    {
      task: { id: string; number: string; title: string; status: string; url: string }
      owner: { id: string; name: string } | null
      blocks: { id: string; number: string; title: string; status: string; url: string }[]
    }
  >()
  for (const r of rows) {
    let entry = byBlocker.get(r.blockerId)
    if (!entry) {
      entry = {
        task: {
          id: r.blockerId,
          number: r.blockerNumber,
          title: r.blockerTitle,
          status: r.blockerStatus,
          url: url(r.blockerId),
        },
        // Кто отвечает. null — задача ничья, и это отдельная проблема: спросить
        // не с кого, а держит она столько же.
        owner: r.blockerAssigneeId ? { id: r.blockerAssigneeId, name: r.blockerAssignee ?? '' } : null,
        blocks: [],
      }
      byBlocker.set(r.blockerId, entry)
    }
    entry.blocks.push({
      id: r.blockedId,
      number: r.blockedNumber,
      title: r.blockedTitle,
      status: r.blockedStatus,
      url: url(r.blockedId),
    })
  }

  const items = [...byBlocker.values()].sort((a, b) => b.blocks.length - a.blocks.length)

  // Сводка по людям: с кого спрашивать и сколько на нём висит. Считаем
  // РАЗЛИЧНЫЕ ждущие задачи, а не сумму — одна задача может ждать двоих, и
  // сумма приписала бы её обоим.
  const byOwner = new Map<string, { id: string | null; name: string; holding: number; blocks: Set<string> }>()
  for (const it of items) {
    const key = it.owner?.id ?? ''
    const cur = byOwner.get(key) ?? {
      id: it.owner?.id ?? null,
      name: it.owner?.name ?? '',
      holding: 0,
      blocks: new Set<string>(),
    }
    cur.holding += 1
    for (const b of it.blocks) cur.blocks.add(b.id)
    byOwner.set(key, cur)
  }
  const owners = [...byOwner.values()]
    .map((o) => ({ id: o.id, name: o.name || undefined, holdingTasks: o.holding, blockingTasks: o.blocks.size }))
    .sort((a, b) => b.blockingTasks - a.blockingTasks)

  return c.json({
    // Сколько задач держат другие и сколько ждут — по головам, без двойного счёта.
    holdingCount: items.length,
    blockedCount: new Set(rows.map((r) => r.blockedId)).size,
    // Кто отвечает за то, что держит. Пусто — значит всё ничьё.
    owners,
    items,
  })
})

bridgeRoute.get('/tasks/:id/blockers', async (c) => {
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.read', scope.projectId)
  if (denied) return c.json(denied, 403)

  const task = await taskByKey(scope.projectId, c.req.param('id'))
  if (!task) return c.json({ error: 'Task not found' }, 404)

  const blockers = await db
    .select({ t: tasks, linkId: taskBlockers.id })
    .from(taskBlockers)
    .innerJoin(tasks, eq(tasks.id, taskBlockers.blockerTaskId))
    .where(and(eq(taskBlockers.blockedTaskId, task.id), isNull(tasks.deletedAt)))
    .orderBy(asc(tasks.number))

  const blocking = await db
    .select({ t: tasks, linkId: taskBlockers.id })
    .from(taskBlockers)
    .innerJoin(tasks, eq(tasks.id, taskBlockers.blockedTaskId))
    .where(and(eq(taskBlockers.blockerTaskId, task.id), isNull(tasks.deletedAt)))
    .orderBy(asc(tasks.number))

  return c.json({
    task: { number: task.number, title: task.title },
    // Чего ждёт эта задача. Незакрытые здесь — и есть причина, по которой её
    // нельзя брать в работу.
    blockedBy: blockers.map((r) => ({ ...linkedView(r.t), linkId: r.linkId })),
    // Кого держит она сама.
    blocking: blocking.map((r) => ({ ...linkedView(r.t), linkId: r.linkId })),
    /** Сколько НЕзакрытых блокеров: ноль — задачу можно брать. */
    openBlockers: blockers.filter((r) => r.t.status !== 'done').length,
  })
})

bridgeRoute.post('/tasks/:id/blockers', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.edit', scope.projectId)
  if (denied) return c.json(denied, 403)

  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const bad = unknownFields(b, ['tasks', 'side', 'project'])
  if (bad) return c.json({ error: bad }, 400)

  const task = await taskByKey(scope.projectId, c.req.param('id'))
  if (!task) return c.json({ error: 'Task not found' }, 404)

  const side = b.side === 'blocking' ? 'blocking' : 'blockedBy'
  const keys = Array.isArray(b.tasks) ? b.tasks.map((x) => String(x).trim()).filter(Boolean) : []
  if (!keys.length) return c.json({ error: 'tasks must be a non-empty array of task numbers or ids' }, 400)
  if (keys.length > 50) return c.json({ error: `Too many tasks: ${keys.length}. Maximum 50 per request.` }, 400)

  const resolved: { id: string; number: string }[] = []
  for (const k of keys) {
    const found = await taskByKey(scope.projectId, k)
    if (!found) return c.json({ error: `Task ${k} not found in this project` }, 404)
    if (found.id === task.id) return c.json({ error: 'A task cannot block itself' }, 400)
    resolved.push({ id: found.id, number: found.number })
  }

  // Кольцо: обе задачи в нём невозможно закрыть НИКОГДА. Проверяем той же
  // функцией, что и веб, и до вставки.
  const forbidden =
    side === 'blockedBy'
      ? await dependentsOf(scope.projectId, task.id)
      : await blockersOf(scope.projectId, task.id)
  const looped = resolved.filter((r) => forbidden.has(r.id))
  if (looped.length) {
    return c.json(
      {
        error: `Circular dependency: ${looped.map((l) => l.number).join(', ')} already depends on ${task.number}. Linking them would mean neither could ever be finished.`,
      },
      400,
    )
  }

  await db
    .insert(taskBlockers)
    .values(
      resolved.map((r) => ({
        projectId: scope.projectId,
        blockedTaskId: side === 'blockedBy' ? task.id : r.id,
        blockerTaskId: side === 'blockedBy' ? r.id : task.id,
        createdById: id.userId,
      })),
    )
    .onConflictDoNothing()

  void logActivity({
    projectId: scope.projectId,
    actorId: id.userId,
    action: 'update',
    entityType: 'task',
    entityId: task.id,
    entityLabel: `${task.number} ${task.title}`,
  })
  tasksChanged(scope.projectId, [task.assigneeId, task.createdById])
  return c.json({ ok: true, linked: resolved.length })
})

/* --- Файлы ресурса в мосте --------------------------------------------------
 *
 * Ассистент видит, что файл существует и как называется, но не его
 * содержимое: список отдаёт имя и размер. Скачать можно, и это отдельное
 * осознанное действие, которое пишется в журнал доступа рядом с раскрытием
 * пароля.
 */

bridgeRoute.get('/resources/:id/files', async (c) => {
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'resources.read', scope.projectId)
  if (denied) return c.json(denied, 403)

  const resource = await db.query.credentials.findFirst({
    where: and(
      eq(credentials.id, c.req.param('id')),
      eq(credentials.projectId, scope.projectId),
      isNull(credentials.deletedAt),
    ),
  })
  if (!resource) return c.json({ error: 'Resource not found' }, 404)

  const rows = await db
    .select({ id: resourceFiles.id, name: resourceFiles.name, size: resourceFiles.size, mime: resourceFiles.mime })
    .from(resourceFiles)
    .where(eq(resourceFiles.resourceId, resource.id))
    .orderBy(asc(resourceFiles.name))

  return c.json({
    resource: { id: resource.id, name: resource.name || resource.url || '' },
    items: rows,
    hint: rows.length
      ? 'Download a file with GET /x/resources/<id>/files/<fileId>. It is a deliberate act and it is logged.'
      : undefined,
  })
})

/**
 * Приложить файл к ресурсу.
 *
 * Тело — multipart, как и у файлов проекта. Ассистенту не нужно знать про
 * это: инструмент chatick_upload собирает форму сам. Но ручка остаётся
 * обычной, чтобы её можно было позвать и curl-ом.
 */
bridgeRoute.post('/resources/:id/files', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  // manage, а не read: положить файл под ресурс — то же по весу действие,
  // что завести секрет.
  const denied = await require(c as never, 'resources.manage', scope.projectId)
  if (denied) return c.json(denied, 403)

  const resource = await db.query.credentials.findFirst({
    where: and(
      eq(credentials.id, c.req.param('id')),
      eq(credentials.projectId, scope.projectId),
      isNull(credentials.deletedAt),
    ),
  })
  if (!resource) return c.json({ error: 'Resource not found' }, 404)

  const form = await c.req.formData()
  const file = form.get('file')
  if (!file || typeof file === 'string') {
    return c.json({ error: 'file field is required (multipart: -F "file=@path")' }, 400)
  }

  const plain = Buffer.from(await file.arrayBuffer())
  const MAX = 25 * 1024 * 1024
  if (plain.length > MAX) {
    return c.json({ error: `File is too large: ${plain.length} bytes, maximum ${MAX}` }, 400)
  }

  const { resolveStorage } = await import('../lib/s3.js')
  const { PutObjectCommand } = await import('@aws-sdk/client-s3')
  const { encryptBytes } = await import('../lib/crypto.js')
  const store = await resolveStorage(scope.projectId)
  const key = `${store.keyPrefix}resource-files/${resource.id}/${nanoid()}`
  await store.client.send(
    new PutObjectCommand({
      Bucket: store.bucket,
      Key: key,
      // В хранилище уходит шифротекст — доступ к бакету не даёт доступа к ключу.
      Body: encryptBytes(plain),
      ContentType: 'application/octet-stream',
    }),
  )

  const [row] = await db
    .insert(resourceFiles)
    .values({
      resourceId: resource.id,
      name: (file.name || 'file').slice(0, 200),
      key,
      mime: file.type || 'application/octet-stream',
      size: String(plain.length),
      uploadedById: id.userId,
    })
    .returning()

  void logActivity({
    projectId: scope.projectId,
    actorId: id.userId,
    action: 'update',
    entityType: 'resource',
    entityId: resource.id,
    entityLabel: resource.name || resource.url || '',
  })
  return c.json({ id: row!.id, name: row!.name, size: row!.size, encrypted: true }, 201)
})

bridgeRoute.get('/resources/:id/files/:fileId', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'resources.read', scope.projectId)
  if (denied) return c.json(denied, 403)

  const resource = await db.query.credentials.findFirst({
    where: and(
      eq(credentials.id, c.req.param('id')),
      eq(credentials.projectId, scope.projectId),
      isNull(credentials.deletedAt),
    ),
  })
  if (!resource) return c.json({ error: 'Resource not found' }, 404)

  const file = await db.query.resourceFiles.findFirst({
    where: and(eq(resourceFiles.id, c.req.param('fileId')), eq(resourceFiles.resourceId, resource.id)),
  })
  if (!file) return c.json({ error: 'File not found' }, 404)

  const { resolveStorage } = await import('../lib/s3.js')
  const { GetObjectCommand } = await import('@aws-sdk/client-s3')
  const { decryptBytes } = await import('../lib/crypto.js')
  const store = await resolveStorage(scope.projectId)
  const obj = await store.client.send(new GetObjectCommand({ Bucket: store.bucket, Key: file.key }))
  const plain = decryptBytes(Buffer.from(await obj.Body!.transformToByteArray()))

  // Тот же журнал, что и у раскрытия пароля: забрать ключ подписи — событие,
  // о котором через полгода спросят «кто это сделал».
  await db.insert(credentialAccessLog).values({
    projectId: scope.projectId,
    userId: id.userId,
    action: 'reveal',
    credentialId: resource.id,
    credentialName: `${resource.name || resource.url || ''} · ${file.name}`,
  })

  return new Response(new Uint8Array(plain), {
    headers: {
      'content-type': file.mime,
      'content-length': String(plain.length),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'cache-control': 'no-store',
    },
  })
})

/**
 * Убрать файл ресурса — и запись, и объект из хранилища.
 *
 * Положить файл ассистент мог, а убрать нет — и ошибочно приложенный
 * кейстор оставалось удалять человеку руками. Асимметрия «создать можно,
 * исправить нельзя» — та же, из-за которой ресурсы плодились дублями.
 */
bridgeRoute.delete('/resources/:id/files/:fileId', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'resources.manage', scope.projectId)
  if (denied) return c.json(denied, 403)

  const resource = await db.query.credentials.findFirst({
    where: and(
      eq(credentials.id, c.req.param('id')),
      eq(credentials.projectId, scope.projectId),
      isNull(credentials.deletedAt),
    ),
  })
  if (!resource) return c.json({ error: 'Resource not found' }, 404)

  const [gone] = await db
    .delete(resourceFiles)
    .where(and(eq(resourceFiles.id, c.req.param('fileId')), eq(resourceFiles.resourceId, resource.id)))
    .returning()
  if (!gone) return c.json({ error: 'File is not attached to this resource' }, 404)

  // Из хранилища тоже: иначе шифротекст останется висеть там, откуда его
  // считали удалённым.
  try {
    const { resolveStorage } = await import('../lib/s3.js')
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
    const store = await resolveStorage(scope.projectId)
    await store.client.send(new DeleteObjectCommand({ Bucket: store.bucket, Key: gone.key }))
  } catch {
    // Запись уже удалена; висящий объект — меньшее зло, чем ошибка в ответе.
  }

  void logActivity({
    projectId: scope.projectId,
    actorId: id.userId,
    action: 'update',
    entityType: 'resource',
    entityId: resource.id,
    entityLabel: resource.name || resource.url || '',
  })
  return c.json({ ok: true })
})

/* --- Ресурсы задачи в мосте ------------------------------------------------
 *
 * Задача ССЫЛАЕТСЯ на доступ, а не хранит его копию. Значения секретов здесь
 * не отдаются нигде: ассистент видит, что доступ существует и как он
 * называется, а раскрыть его может только тот, кому это позволяет сам ресурс.
 */

bridgeRoute.get('/tasks/:id/resources', async (c) => {
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.read', scope.projectId)
  if (denied) return c.json(denied, 403)

  const task = await taskByKey(scope.projectId, c.req.param('id'))
  if (!task) return c.json({ error: 'Task not found' }, 404)

  const rows = await db
    .select({ id: credentials.id, name: credentials.name, url: credentials.url })
    .from(taskResources)
    .innerJoin(credentials, eq(credentials.id, taskResources.resourceId))
    .where(and(eq(taskResources.taskId, task.id), isNull(credentials.deletedAt)))
    .orderBy(asc(credentials.name))

  return c.json({ task: { number: task.number, title: task.title }, items: rows })
})

/** Привязать ресурсы — ДОБАВЛЯЕТ, ничего не стирая. */
bridgeRoute.post('/tasks/:id/resources', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.edit', scope.projectId)
  if (denied) return c.json(denied, 403)

  const parsed_r = await readJson(c as never)
  if ('error' in parsed_r) return c.json(parsed_r, 400)
  const b = parsed_r.body as Record<string, unknown>
  const bad = unknownFields(b, ['resources', 'project'])
  if (bad) return c.json({ error: bad }, 400)

  const task = await taskByKey(scope.projectId, c.req.param('id'))
  if (!task) return c.json({ error: 'Task not found' }, 404)

  const ids = Array.isArray(b.resources) ? b.resources.map((x) => String(x).trim()).filter(Boolean) : []
  if (!ids.length) return c.json({ error: 'resources must be a non-empty array of resource ids' }, 400)
  if (ids.length > 50) return c.json({ error: `Too many resources: ${ids.length}. Maximum 50 per request.` }, 400)

  // Только ресурсы этого проекта: чужой показал бы доступ, которого нет.
  const mine = await db
    .select({ id: credentials.id })
    .from(credentials)
    .where(
      and(inArray(credentials.id, ids), eq(credentials.projectId, scope.projectId), isNull(credentials.deletedAt)),
    )
  if (mine.length !== ids.length) {
    return c.json({ error: 'Some resources are not in this project' }, 400)
  }

  await db
    .insert(taskResources)
    .values(mine.map((r) => ({ taskId: task.id, resourceId: r.id })))
    .onConflictDoNothing()

  void logActivity({
    projectId: scope.projectId,
    actorId: id.userId,
    action: 'update',
    entityType: 'task',
    entityId: task.id,
    entityLabel: `${task.number} ${task.title}`,
  })
  tasksChanged(scope.projectId, [task.assigneeId, task.createdById])
  return c.json({ ok: true, linked: mine.length })
})

/** Отвязать один ресурс. Остальные привязки не трогаются. */
bridgeRoute.delete('/tasks/:id/resources/:resourceId', async (c) => {
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.edit', scope.projectId)
  if (denied) return c.json(denied, 403)

  const task = await taskByKey(scope.projectId, c.req.param('id'))
  if (!task) return c.json({ error: 'Task not found' }, 404)

  const [gone] = await db
    .delete(taskResources)
    .where(and(eq(taskResources.taskId, task.id), eq(taskResources.resourceId, c.req.param('resourceId'))))
    .returning()
  if (!gone) return c.json({ error: 'Resource is not linked to this task' }, 404)

  tasksChanged(scope.projectId, [task.assigneeId, task.createdById])
  return c.json({ ok: true })
})

/* --- Связи задач в мосте ---------------------------------------------------
 *
 * Ассистент — главный их потребитель: разбирая одну задачу на несколько, он и
 * проставляет derived. Ручки намеренно отдельны от блокеров: связь ничего не
 * держит, и смешать их значило бы позволить «похожей задаче» гасить работу.
 */

bridgeRoute.get('/tasks/:id/links', async (c) => {
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.read', scope.projectId)
  if (denied) return c.json(denied, 403)

  const task = await taskByKey(scope.projectId, c.req.param('id'))
  if (!task) return c.json({ error: 'Task not found' }, 404)

  const out = await db
    .select({ t: tasks, linkId: taskLinks.id, kind: taskLinks.kind })
    .from(taskLinks)
    .innerJoin(tasks, eq(tasks.id, taskLinks.toTaskId))
    .where(and(eq(taskLinks.fromTaskId, task.id), isNull(tasks.deletedAt)))
    .orderBy(asc(tasks.number))

  const inc = await db
    .select({ t: tasks, linkId: taskLinks.id, kind: taskLinks.kind })
    .from(taskLinks)
    .innerJoin(tasks, eq(tasks.id, taskLinks.fromTaskId))
    .where(and(eq(taskLinks.toTaskId, task.id), isNull(tasks.deletedAt)))
    .orderBy(asc(tasks.number))

  const view = (r: { t: typeof tasks.$inferSelect; linkId: string }) => ({
    ...linkedView(r.t),
    linkId: r.linkId,
  })

  return c.json({
    task: { number: task.number, title: task.title },
    /** Из чего эта задача выросла. */
    derivedFrom: out.filter((r) => r.kind === 'derived').map(view),
    /** Что выросло из неё. */
    derivedInto: inc.filter((r) => r.kind === 'derived').map(view),
    /** Просто связанные: симметрично, обе стороны в одном списке. */
    related: [...out, ...inc].filter((r) => r.kind === 'related').map(view),
  })
})

bridgeRoute.post('/tasks/:id/links', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.edit', scope.projectId)
  if (denied) return c.json(denied, 403)

  const parsed_l = await readJson(c as never)
  if ('error' in parsed_l) return c.json(parsed_l, 400)
  const b = parsed_l.body as Record<string, unknown>
  const bad = unknownFields(b, ['tasks', 'kind', 'direction', 'project'])
  if (bad) return c.json({ error: bad }, 400)

  const task = await taskByKey(scope.projectId, c.req.param('id'))
  if (!task) return c.json({ error: 'Task not found' }, 404)

  const kind = b.kind === 'derived' ? 'derived' : 'related'
  const direction = b.direction === 'into' ? 'into' : 'from'
  const keys = Array.isArray(b.tasks) ? b.tasks.map((x) => String(x).trim()).filter(Boolean) : []
  if (!keys.length) return c.json({ error: 'tasks must be a non-empty array of task numbers or ids' }, 400)
  if (keys.length > 50) return c.json({ error: `Too many tasks: ${keys.length}. Maximum 50 per request.` }, 400)

  const resolved: { id: string; number: string }[] = []
  for (const k of keys) {
    const found = await taskByKey(scope.projectId, k)
    if (!found) return c.json({ error: `Task ${k} not found in this project` }, 404)
    if (found.id === task.id) return c.json({ error: 'A task cannot link to itself' }, 400)
    resolved.push({ id: found.id, number: found.number })
  }

  // Уже связанные пропускаем: уникальный индекс ловит только одинаковый
  // порядок пары, а связь в обратную сторону — та же самая связь.
  const existing = await db
    .select({ a: taskLinks.fromTaskId, b: taskLinks.toTaskId })
    .from(taskLinks)
    .where(
      and(
        eq(taskLinks.projectId, scope.projectId),
        or(eq(taskLinks.fromTaskId, task.id), eq(taskLinks.toTaskId, task.id)),
      ),
    )
  const already = new Set(existing.flatMap((r) => [r.a, r.b]))
  const fresh = resolved.filter((r) => !already.has(r.id))

  if (fresh.length) {
    await db
      .insert(taskLinks)
      .values(
        fresh.map((r) => ({
          projectId: scope.projectId,
          fromTaskId: direction === 'from' ? task.id : r.id,
          toTaskId: direction === 'from' ? r.id : task.id,
          kind,
          createdById: id.userId,
        })),
      )
      .onConflictDoNothing()
  }

  void logActivity({
    projectId: scope.projectId,
    actorId: id.userId,
    action: 'update',
    entityType: 'task',
    entityId: task.id,
    entityLabel: `${task.number} ${task.title}`,
  })
  tasksChanged(scope.projectId, [task.assigneeId, task.createdById])
  return c.json({ ok: true, linked: fresh.length })
})

bridgeRoute.delete('/tasks/:id/links/:linkId', async (c) => {
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.edit', scope.projectId)
  if (denied) return c.json(denied, 403)

  const task = await taskByKey(scope.projectId, c.req.param('id'))
  if (!task) return c.json({ error: 'Task not found' }, 404)

  const [gone] = await db
    .delete(taskLinks)
    .where(and(eq(taskLinks.id, c.req.param('linkId')), eq(taskLinks.projectId, scope.projectId)))
    .returning()
  if (!gone) return c.json({ error: 'Link not found' }, 404)

  tasksChanged(scope.projectId, [task.assigneeId, task.createdById])
  return c.json({ ok: true })
})

bridgeRoute.delete('/tasks/:id/blockers/:linkId', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.edit', scope.projectId)
  if (denied) return c.json(denied, 403)

  const task = await taskByKey(scope.projectId, c.req.param('id'))
  if (!task) return c.json({ error: 'Task not found' }, 404)

  const [gone] = await db
    .delete(taskBlockers)
    .where(and(eq(taskBlockers.id, c.req.param('linkId')), eq(taskBlockers.projectId, scope.projectId)))
    .returning()
  if (!gone) return c.json({ error: 'Link not found' }, 404)

  tasksChanged(scope.projectId, [task.assigneeId, task.createdById])
  return c.json({ ok: true })
})

bridgeRoute.get('/tasks/:id/checklist', async (c) => {
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.read', scope.projectId)
  if (denied) return c.json(denied, 403)

  const task = await taskByKey(scope.projectId, c.req.param('id'))
  if (!task) return c.json({ error: 'Task not found' }, 404)

  const rows = await db
    .select({ item: taskChecklist, who: users })
    .from(taskChecklist)
    .leftJoin(users, eq(users.id, taskChecklist.doneById))
    .where(eq(taskChecklist.taskId, task.id))
    .orderBy(asc(taskChecklist.sortOrder), asc(taskChecklist.createdAt))

  const items = rows.map((r) => ({
    id: r.item.id,
    text: r.item.text,
    // Ответ хранится размеченным, а читать его будет модель — отдаём текстом,
    // как заметки и документы: теги в ответе она примет за часть ответа.
    note: (r.item.note && htmlToText(r.item.note)) || undefined,
    done: r.item.done,
    doneBy: r.who ? r.who.name || r.who.email : undefined,
  }))
  const done = items.filter((i) => i.done).length
  return c.json({ items, done, total: items.length })
})

bridgeRoute.post('/tasks/:id/checklist', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.edit', scope.projectId)
  if (denied) return c.json(denied, 403)

  const task = await taskByKey(scope.projectId, c.req.param('id'))
  if (!task) return c.json({ error: 'Task not found' }, 404)
  if (!(await ownsOrManages(scope.projectId, id.userId, [task.createdById, task.assigneeId]))) {
    return c.json({ error: 'Forbidden: you can only edit tasks you created or that are assigned to you' }, 403)
  }

  const parsed_body = await readJson(c as never)
  if ('error' in parsed_body) return c.json(parsed_body, 400)
  const body = parsed_body.body as { items?: unknown; text?: unknown; note?: unknown }
  // Списком за раз: вопросы к задаче обычно задают пачкой, а не по одному.
  const incoming = Array.isArray(body.items)
    ? body.items
    : typeof body.text === 'string'
      ? [{ text: body.text, note: body.note }]
      : []
  const parsed = incoming
    .map((x) => (typeof x === 'string' ? { text: x, note: '' } : (x as { text?: unknown; note?: unknown })))
    .filter((x) => typeof x.text === 'string' && (x.text as string).trim())
    // Текст пункта — одна строка, его показывают как есть. А ответ под пунктом
    // живёт в том же виде, что описания и комментарии: ассистент пишет markdown,
    // и без разбора он лёг бы в базу звёздочками наружу.
    .map((x) => ({ text: (x.text as string).trim().slice(0, 500), note: typeof x.note === 'string' ? richText(x.note.slice(0, 4000)) : '' }))

  if (!parsed.length) return c.json({ error: 'Pass text or items: ["...", ...]' }, 400)

  const [{ maxSort }] = (await db
    .select({ maxSort: sql<number>`coalesce(max(${taskChecklist.sortOrder}), 0)` })
    .from(taskChecklist)
    .where(eq(taskChecklist.taskId, task.id))) as [{ maxSort: number }]

  const rows = await db
    .insert(taskChecklist)
    .values(parsed.map((p, i) => ({ taskId: task.id, projectId: scope.projectId, text: p.text, note: p.note, sortOrder: maxSort + i + 1 })))
    .returning()

  tasksChanged(scope.projectId, [task.assigneeId, task.createdById])
  return c.json({ added: rows.length, items: rows.map((r) => ({ id: r.id, text: r.text, done: r.done })) }, 201)
})

bridgeRoute.patch('/tasks/:id/checklist/:itemId', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.edit', scope.projectId)
  if (denied) return c.json(denied, 403)

  const task = await taskByKey(scope.projectId, c.req.param('id'))
  if (!task) return c.json({ error: 'Task not found' }, 404)
  if (!(await ownsOrManages(scope.projectId, id.userId, [task.createdById, task.assigneeId]))) {
    return c.json({ error: 'Forbidden: you can only edit tasks you created or that are assigned to you' }, 403)
  }

  const existing = await db.query.taskChecklist.findFirst({
    where: and(eq(taskChecklist.id, c.req.param('itemId')), eq(taskChecklist.taskId, task.id)),
  })
  if (!existing) return c.json({ error: 'Checklist item not found' }, 404)

  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as { text?: unknown; note?: unknown; done?: unknown }
  const patch: Record<string, unknown> = { updatedAt: new Date() }
  if (typeof b.text === 'string' && b.text.trim()) patch.text = b.text.trim().slice(0, 500)
  if (typeof b.note === 'string') patch.note = richText(b.note.slice(0, 4000))
  if (typeof b.done === 'boolean') {
    patch.done = b.done
    patch.doneById = b.done ? id.userId : null
    patch.doneAt = b.done ? new Date() : null
  }
  if (Object.keys(patch).length === 1) return c.json({ error: 'Nothing to change. Supported: text, note, done.' }, 400)

  const [row] = await db.update(taskChecklist).set(patch).where(eq(taskChecklist.id, existing.id)).returning()
  // Ответ под пунктом — событие; та же функция, что и на веб-пути. Условие
  // одно: заметка непуста и изменилась. См. checklistAnswerNotice.
  if (typeof patch.note === 'string' && patch.note && patch.note !== existing.note) {
    void checklistAnswerNotice({
      projectId: scope.projectId,
      task,
      actorId: id.userId,
      itemText: row!.text,
      note: patch.note,
    })
  }
  tasksChanged(scope.projectId, [task.assigneeId, task.createdById])
  return c.json({ id: row!.id, text: row!.text, note: row!.note || undefined, done: row!.done })
})

/**
 * Убрать пункт чек-листа.
 *
 * Добавлять и править мост умел, убирать — нет: лишний пункт оставался
 * навсегда. Здесь это безопасно — пункт живёт внутри задачи, ничего за собой
 * не тянет, и задача с него не меняется.
 */
bridgeRoute.delete('/tasks/:id/checklist/:itemId', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.edit', scope.projectId)
  if (denied) return c.json(denied, 403)

  const task = await taskByKey(scope.projectId, c.req.param('id'))
  if (!task) return c.json({ error: 'Task not found' }, 404)
  if (!(await ownsOrManages(scope.projectId, id.userId, [task.createdById, task.assigneeId]))) {
    return c.json({ error: 'Forbidden: you can only edit tasks you created or that are assigned to you' }, 403)
  }

  const existing = await db.query.taskChecklist.findFirst({
    where: and(eq(taskChecklist.id, c.req.param('itemId')), eq(taskChecklist.taskId, task.id)),
  })
  if (!existing) return c.json({ error: 'Checklist item not found' }, 404)

  await db.delete(taskChecklist).where(eq(taskChecklist.id, existing.id))
  tasksChanged(scope.projectId, [task.assigneeId, task.createdById])
  return c.json({ ok: true, removed: existing.text })
})

// Комментарии задачи — обсуждение, в котором ассистент участвует наравне со
// всеми: читает ветку, отвечает на конкретную реплику, пишет свою.
// Право то же, что в интерфейсе: комментировать может каждый, кто видит
// задачи (tasks.read). Правка и удаление чужих слов мосту не даются.

bridgeRoute.get('/tasks/:id/comments', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.read', scope.projectId)
  if (denied) return c.json(denied, 403)
  // Номер ИЛИ id — тем же ключом, что и POST рядом.
  //
  // Пока здесь стоял сырой параметр, пара «написал / прочитал» расходилась:
  // POST разрешал «TASK-2» в настоящий id и создавал комментарий правильно, а
  // GET искал комментарии с taskId = 'TASK-2' и не находил ничего. Наружу это
  // выглядело как молчаливая потеря — запись вернула id, чтение вернуло
  // пустоту, — и уводило от причины: искали «отдельный поток» и задержку.
  const task = await taskByKey(scope.projectId, c.req.param('id'))
  if (!task) return c.json({ error: 'Not found' }, 404)

  const rows = await db
    .select({ c: taskComments, u: users })
    .from(taskComments)
    // Ограничение по проекту обязательно: id задачи угадывать не нужно, его
    // видно в любой ссылке, и без этого условия туннель в один проект читал
    // бы обсуждения соседнего.
    .where(and(eq(taskComments.taskId, task.id), eq(taskComments.projectId, scope.projectId)))
    .leftJoin(users, eq(users.id, taskComments.authorId))
    .orderBy(taskComments.createdAt)
  // Файлы комментария привязаны к нему через commentId
  const byComment = await attachmentsFor(
    files.commentId,
    rows.map((r) => r.c.id),
    scope.projectId,
    new Map(rows.map((r) => [r.c.id, r.c.body])),
  )
  return c.json({
    items: rows.map((r) => ({
      id: r.c.id,
      text: r.c.body,
      author: r.u?.name ?? null,
      authorId: r.c.authorId,
      // Без этого ветка читается как плоский список и ассистент не видит,
      // кому что отвечали.
      replyTo: r.c.replyToId || undefined,
      attachments: byComment.get(r.c.id) ?? [],
      createdAt: r.c.createdAt,
    })),
  })
})

const COMMENT_FIELDS = ['text', 'replyTo', 'attachmentIds'] as const

bridgeRoute.post('/tasks/:id/comments', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.read', scope.projectId)
  if (denied) return c.json(denied, 403)
  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const bad = unknownFields(b, COMMENT_FIELDS)
  if (bad) return c.json({ error: bad }, 400)
  const text = typeof b.text === 'string' ? b.text.trim() : ''
  // Вложения — как в задачах и чате: сначала POST /x/files, потом id сюда.
  // Скриншот к комментарию часто и есть весь ответ, одним текстом его не
  // передать.
  const attachmentIds = Array.isArray(b.attachmentIds)
    ? (b.attachmentIds as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 10)
    : []
  if (!text && !attachmentIds.length) return c.json({ error: 'text or attachmentIds is required' }, 400)
  if (text.length > 10_000) return c.json({ error: 'text is too long (max 10000 characters)' }, 400)

  const task = await taskByKey(scope.projectId, c.req.param('id'))
  if (!task) return c.json({ error: 'Not found' }, 404)
  const taskId = task.id

  // Отвечать можно только на реплику из этой же задачи: иначе ветка укажет
  // в чужое обсуждение, и в интерфейсе цитата не найдётся.
  let replyToId: string | null = null
  if (b.replyTo !== undefined && b.replyTo !== null) {
    if (typeof b.replyTo !== 'string') return c.json({ error: 'replyTo must be a comment id' }, 400)
    const parent = await db.query.taskComments.findFirst({
      where: and(eq(taskComments.id, b.replyTo), eq(taskComments.taskId, taskId), eq(taskComments.projectId, scope.projectId)),
    })
    if (!parent) return c.json({ error: 'replyTo: no such comment in this task' }, 400)
    replyToId = parent.id
  }

  const [row] = await db
    .insert(taskComments)
    // Упоминания и превью берём из ИСХОДНОГО текста: в разметке @[Имя](id)
    // уже превращён в span, а в письме нужен текст, а не теги.
    .values({ taskId, projectId: scope.projectId, authorId: id.userId, body: text ? richText(text) : '📎', replyToId })
    .returning()

  // Привязываем только свои файлы этого проекта и снимаем временный флаг.
  // taskId проставляем заодно: как и в интерфейсе, файл из комментария виден
  // в разделе файлов задачи, а не только внутри реплики.
  let attachments: { id: string; name: string; mime: string; size: number }[] = []
  if (attachmentIds.length) {
    await db
      .update(files)
      .set({ commentId: row!.id, taskId, pendingUntil: null })
      .where(and(inArray(files.id, attachmentIds), eq(files.projectId, scope.projectId), eq(files.uploadedById, id.userId)))
    const rows = await db.select().from(files).where(eq(files.commentId, row!.id))
    attachments = rows.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: Number(f.size) }))
  }

  // Люди должны узнать, что ассистент написал в их задаче — ровно как если бы
  // это написал человек из интерфейса. Без этого комментарий появлялся молча.
  const author = await db.query.users.findFirst({ where: eq(users.id, id.userId) })
  const actorName = author?.name || 'Someone'
  const link = projectPath((await companyOf(scope.projectId)) ?? '', scope.projectId, `/tasks/${taskId}`)
  const mentioned = extractMentions(text)
  if (mentioned.length)
    void notify({
      projectId: scope.projectId,
      event: 'comment_mention',
      recipientIds: mentioned,
      actorId: id.userId,
      actorName,
      dedupeKey: `comment_mention:${row!.id}`,
      link,
      preview: text,
      entityType: 'task',
      entityId: task.id,
    })
  // Исполнитель, тот, кому отвечают, и автор задачи — если разговор не
  // адресован кому-то другому. Правило одно на все три пути (notify.ts).
  const watchers = commentWatchers({
    assigneeId: task.assigneeId,
    createdById: task.createdById,
    replyToAuthorId: replyToId
      ? ((await db.query.taskComments.findFirst({ where: eq(taskComments.id, replyToId) }))?.authorId ?? null)
      : null,
    mentioned,
    actorId: id.userId,
  })
  if (watchers.length)
    void notify({
      projectId: scope.projectId,
      event: 'task_comment',
      recipientIds: watchers,
      actorId: id.userId,
      actorName,
      dedupeKey: `task_comment:${row!.id}`,
      link,
      preview: text,
      vars: { ref: task.number },
      entityType: 'task',
      entityId: task.id,
    })

  broadcast(scope.projectId, 'task_comments_changed', { taskId })
  // Возвращаем и сам текст — тем, что реально записалось.
  //
  // Раньше в ответе были только id и дата, и проверить, доехали ли иврит с
  // разметкой без искажений, можно было лишь повторным чтением. Кодировка
  // ломалась на этом пути не раз, и ловилось это через раз.
  return c.json(
    { id: row!.id, text: row!.body, replyTo: row!.replyToId || undefined, attachments, createdAt: row!.createdAt },
    201,
  )
})

/** Комментарий этого проекта — или отказ. Общая часть правки и удаления. */
async function commentForWrite(c: Ctx, scope: { projectId: string }, commentId: string) {
  const row = await db.query.taskComments.findFirst({
    where: and(eq(taskComments.id, commentId), eq(taskComments.projectId, scope.projectId)),
  })
  if (!row) return { error: 'Not found', status: 404 as const }
  if (!(await ownerOrAdmin(scope.projectId, auth(c).userId, row.authorId))) {
    return { error: 'Forbidden: you can change only your own comments unless you are an admin', status: 403 as const }
  }
  return { comment: row }
}

bridgeRoute.patch('/tasks/:id/comments/:commentId', async (c) => {
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.read', scope.projectId)
  if (denied) return c.json(denied, 403)

  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const bad = unknownFields(b, ['text'] as const)
  if (bad) return c.json({ error: bad }, 400)
  const text = typeof b.text === 'string' ? b.text.trim() : ''
  if (!text) return c.json({ error: 'text is required' }, 400)
  if (text.length > 10_000) return c.json({ error: 'text is too long (max 10000 characters)' }, 400)

  const found = await commentForWrite(c as never, scope, c.req.param('commentId'))
  if ('error' in found) return c.json({ error: found.error }, found.status)

  const [row] = await db
    .update(taskComments)
    // Разметка та же, что при создании: иначе упоминание, добавленное при
    // правке, осталось бы простым текстом и человека бы не позвали.
    .set({ body: richText(text) })
    .where(eq(taskComments.id, found.comment.id))
    .returning()

  broadcast(scope.projectId, 'task_comments_changed', { taskId: found.comment.taskId })
  return c.json({ id: row!.id, text: row!.body })
})

bridgeRoute.delete('/tasks/:id/comments/:commentId', async (c) => {
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.read', scope.projectId)
  if (denied) return c.json(denied, 403)

  const found = await commentForWrite(c as never, scope, c.req.param('commentId'))
  if ('error' in found) return c.json({ error: found.error }, found.status)

  await db.delete(taskComments).where(eq(taskComments.id, found.comment.id))
  broadcast(scope.projectId, 'task_comments_changed', { taskId: found.comment.taskId })
  return c.json({ ok: true })
})

// --- Спринты ----------------------------------------------------------------

// --- команда проекта -------------------------------------------------------
// Управлять командой из редактора: посмотреть, кто есть, позвать человека,
// сменить роль и уровни доступа. Исключение намеренно оставлено интерфейсу:
// оно необратимо (уходит письмо, рвутся туннели), а цена ошибки ассистента
// здесь выше, чем удобство. Понизить до «только чтение» мост может — это
// откатывается одной строкой.

/**
 * Правило правки чужого: свои слова правит автор, любые — админ.
 *
 * То же самое, что в интерфейсе, и намеренно то же самое. Мост работает ОТ
 * ИМЕНИ человека — токен привязан к его учётной записи, — поэтому «можно ли
 * править» здесь вопрос не про ассистента, а про того, кто его послал. Прав
 * у него ровно столько же, сколько когда он делает это руками.
 *
 * Раньше правки и удаления через мост не было вовсе. Ограничение не
 * запрашивали, оно появилось попутно, из соображения «сказанное не
 * забрать» — и на деле означало, что автор не может исправить собственную
 * опечатку тем же способом, каким её сделал.
 */
async function ownerOrAdmin(projectId: string, userId: string, authorId: string | null): Promise<boolean> {
  if (authorId && authorId === userId) return true
  return managesTeam(projectId, userId)
}

/** Кто распоряжается людьми проекта: owner/admin проекта или admin компании. */
async function managesTeam(projectId: string, userId: string): Promise<boolean> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return false
  const m = await projectRoleOf(projectId, userId)
  if (m?.role === 'owner' || m?.role === 'admin') return true
  return (await companyRoleOf(project.companyId, userId)) === 'admin'
}

bridgeRoute.get('/members', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.read', scope.projectId)
  if (denied) return c.json(denied, 403)

  const rows = await db
    .select({ m: projectMembers, u: users })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, scope.projectId))

  // Должность может быть задана у компании и унаследована проектом —
  // ассистенту отдаём разрешённое значение, то же, что видит человек.
  const profiles = await profilesForProject(scope.projectId)
  return c.json({
    canManage: await managesTeam(scope.projectId, id.userId),
    members: rows.map((r) => ({
      userId: r.u.id,
      name: r.u.name,
      email: r.u.email,
      role: r.m.role,
      jobTitle: profiles.get(r.u.id)?.jobTitle || undefined,
      responsibility: profiles.get(r.u.id)?.responsibility || undefined,
      permissions: resolveDomains(r.m.role, r.m.permissions),
    })),
  })
})

/** Кандидаты: люди компании, которых ещё нет в проекте. */
bridgeRoute.get('/members/available', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  if (!(await managesTeam(scope.projectId, id.userId))) {
    return c.json({ error: 'Forbidden: only project owners/admins manage the team' }, 403)
  }

  const project = await db.query.projects.findFirst({ where: eq(projects.id, scope.projectId) })
  if (!project) return c.json({ error: 'Project not found' }, 404)

  const inProject = new Set(
    (await db.query.projectMembers.findMany({ where: eq(projectMembers.projectId, scope.projectId) })).map(
      (m) => m.userId,
    ),
  )
  const rows = await db
    .select({ m: companyMembers, u: users })
    .from(companyMembers)
    .innerJoin(users, eq(users.id, companyMembers.userId))
    .where(eq(companyMembers.companyId, project.companyId))

  return c.json({
    canInviteOutsiders: (await companyRoleOf(project.companyId, id.userId)) === 'admin',
    candidates: rows
      .filter((r) => !inProject.has(r.u.id))
      .map((r) => ({ userId: r.u.id, name: r.u.name, email: r.u.email, companyRole: r.m.role })),
  })
})

bridgeRoute.post('/members', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  if (!(await managesTeam(scope.projectId, id.userId))) {
    return c.json({ error: 'Forbidden: only project owners/admins manage the team' }, 403)
  }

  // Состав команды ведётся во внешней системе (SPEC §8.42). Мост ИИ — та же
  // дверь: без этой проверки ИИ добавлял бы людей, которых там нет.
  if (await membersLockedForProject(scope.projectId)) return c.json(MEMBERS_LOCKED, 403)
  const project = await db.query.projects.findFirst({ where: eq(projects.id, scope.projectId) })
  if (!project) return c.json({ error: 'Project not found' }, 404)

  const parsed_body = await readJson(c as never)
  if ('error' in parsed_body) return c.json(parsed_body, 400)
  const body = parsed_body.body as {
    userId?: string
    email?: string
    role?: string
    companyRole?: string
  }
  const role = body.role === 'admin' ? 'admin' : 'member'

  // По email искать удобнее: в разговоре звучит адрес, а не внутренний id.
  let userId = body.userId
  const email = body.email?.toLowerCase().trim()
  if (!userId && email) {
    const u = await db.query.users.findFirst({ where: eq(users.email, email) })
    if (u) userId = u.id
  }
  if (!userId && !email) {
    return c.json({ error: 'Pass userId or email. See GET /x/members/available.' }, 400)
  }

  // Человек уже в компании — просто включаем в проект.
  if (userId && (await companyRoleOf(project.companyId, userId))) {
    if (await projectRoleOf(scope.projectId, userId)) return c.json({ error: 'Already a member' }, 409)

    await db.insert(projectMembers).values({
      projectId: scope.projectId,
      userId,
      role,
      permissions: JSON.stringify(defaultDomainPermissions(role)),
    })

    const target = await db.query.users.findFirst({ where: eq(users.id, userId) })
    if (target) {
      await sendAddedToProjectMail({
        to: target.email,
        locale: target.locale,
        projectId: scope.projectId,
        projectName: project.name,
      })
    }
    await logActivity({
      projectId: scope.projectId,
      actorId: id.userId,
      action: 'create',
      entityType: 'member',
      entityId: userId,
      entityLabel: `${target?.name || target?.email || userId} added to the project`,
    })

    return c.json({ added: true, userId, role, permissions: defaultDomainPermissions(role) }, 201)
  }

  // Человека в компании нет. Звать со стороны — решение уровня компании, и
  // принимает его только её админ. Одним запросом: приглашение в компанию
  // несёт с собой проект, так что второго шага в интерфейсе не нужно.
  if (!email) {
    return c.json({ error: 'User is not a company member — pass email to invite them' }, 400)
  }
  if ((await companyRoleOf(project.companyId, id.userId)) !== 'admin') {
    return c.json(
      { error: 'Forbidden: only a company admin can invite people from outside the company' },
      403,
    )
  }

  const companyRole =
    body.companyRole === 'admin' || body.companyRole === 'manager' ? body.companyRole : 'member'

  const pending = await db.query.companyInvites.findFirst({
    where: and(
      eq(companyInvites.companyId, project.companyId),
      eq(companyInvites.email, email),
      eq(companyInvites.status, 'pending'),
    ),
  })
  if (pending) return c.json({ error: 'Invite already pending for this email' }, 409)

  const token = nanoid(32)
  await db.insert(companyInvites).values({
    companyId: project.companyId,
    email,
    role: companyRole,
    token,
    invitedById: id.userId,
    projectId: scope.projectId,
  })

  const company = await db.query.companies.findFirst({ where: eq(companies.id, project.companyId) })
  const inviter = await db.query.users.findFirst({ where: eq(users.id, id.userId) })
  await sendInviteMail({
    to: email,
    companyName: company?.name ?? '',
    role: companyRole,
    token,
    inviterLocale: inviter?.locale,
  })

  return c.json(
    {
      invited: true,
      email,
      companyRole,
      projectId: scope.projectId,
      note: 'Invite sent. The person joins the project once they accept it.',
    },
    201,
  )
})

bridgeRoute.patch('/members/:userId', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  if (!(await managesTeam(scope.projectId, id.userId))) {
    return c.json({ error: 'Forbidden: only project owners/admins manage the team' }, 403)
  }

  const userId = c.req.param('userId')
  const target = await projectRoleOf(scope.projectId, userId)
  if (!target) return c.json({ error: 'Not a project member' }, 404)
  if (target.role === 'owner') return c.json({ error: 'Project owner cannot be changed' }, 400)

  const parsed_body = await readJson(c as never)
  if ('error' in parsed_body) return c.json(parsed_body, 400)
  const body = parsed_body.body as {
    role?: string
    permissions?: Record<string, string>
    jobTitle?: string
    responsibility?: string
  }

  const patch: Record<string, unknown> = {}
  if (body.jobTitle !== undefined) patch.jobTitle = String(body.jobTitle).slice(0, 200)
  if (body.responsibility !== undefined) patch.responsibility = String(body.responsibility).slice(0, 400)

  let domains = resolveDomains(target.role, target.permissions)
  let role: 'owner' | 'admin' | 'member' = target.role

  if (body.role !== undefined) {
    if (body.role !== 'admin' && body.role !== 'member') {
      return c.json({ error: 'role must be "admin" or "member"' }, 400)
    }
    if (body.role !== role) {
      role = body.role
      // Как и в интерфейсе: смена роли сбрасывает уровни на умолчания новой,
      // иначе понижение выходит показным.
      domains = defaultDomainPermissions(role)
      patch.role = role
    }
  }

  if (body.permissions) {
    for (const [domain, level] of Object.entries(body.permissions)) {
      if (!(domain in domains)) {
        return c.json({ error: `Unknown permission domain: ${domain}`, domains: Object.keys(domains) }, 400)
      }
      if (!PERMISSION_LEVELS.includes(level as never)) {
        return c.json({ error: `Level must be one of ${PERMISSION_LEVELS.join(', ')} (got "${level}")` }, 400)
      }
      domains = { ...domains, [domain]: level }
    }
  }

  if (body.role !== undefined || body.permissions) patch.permissions = JSON.stringify(domains)
  if (!Object.keys(patch).length) return c.json({ error: 'Nothing to change' }, 400)

  await db.update(projectMembers).set(patch).where(eq(projectMembers.id, target.id))
  await logActivity({
    projectId: scope.projectId,
    actorId: id.userId,
    action: 'update',
    entityType: 'member',
    entityId: userId,
    entityLabel: patch.role ? `role changed to ${role}` : 'permissions changed',
  })

  return c.json({ ok: true, userId, role, permissions: domains })
})

/**
 * Убрать человека из проекта.
 *
 * Ассистент умел добавлять и менять роли, но не убирать: команда росла и
 * не убывала, и за каждым уходом человек шёл в интерфейс руками.
 *
 * Из ПРОЕКТА, а не из компании: компанию мост не трогает вовсе — это
 * решение другого уровня, и отдавать его ассистенту не стоит.
 */
bridgeRoute.delete('/members/:userId', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  if (!(await managesTeam(scope.projectId, id.userId))) {
    return c.json({ error: 'Forbidden: only project owners/admins manage the team' }, 403)
  }

  const project = await db.query.projects.findFirst({ where: eq(projects.id, scope.projectId) })
  if (!project) return c.json({ error: 'Project not found' }, 404)
  // Состав ведётся во внешней системе (SPEC §8.42).
  if (await membersLockedForProject(scope.projectId)) return c.json(MEMBERS_LOCKED, 403)

  const userId = c.req.param('userId')
  const target = await projectRoleOf(scope.projectId, userId)
  if (!target) return c.json({ error: 'Not a project member' }, 404)
  // Владелец один на проект и часто единственное начальство: убрав его,
  // проект остаётся без того, кто может вернуть людей и раздать права.
  if (target.role === 'owner') return c.json({ error: 'Project owner cannot be removed' }, 400)

  await db
    .delete(projectMembers)
    .where(and(eq(projectMembers.projectId, scope.projectId), eq(projectMembers.userId, userId)))

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) })
  if (user)
    await sendRemovedFromProjectMail({ to: user.email, locale: user.locale, projectName: project.name })

  await logActivity({
    projectId: scope.projectId,
    actorId: id.userId,
    action: 'delete',
    entityType: 'member',
    entityId: userId,
    entityLabel: `${user?.name || user?.email || userId} removed from the project`,
  })

  return c.json({ removed: true, userId })
})

/**
 * Версии проекта через мост (SPEC §8.46).
 *
 * Функция включается в проекте отдельно, поэтому каждая ручка начинается с
 * проверки: спрятанная вкладка ничего не защищает — мост её просто не видит.
 *
 * Удаления нет, как и в REST. Версия это факт: она была собрана и куда-то
 * уехала, и стереть её значит стереть ответ на «что было в проде тогда-то».
 */
async function releasesReady(
  c: Ctx,
  need: 'releases.read' | 'releases.manage',
): Promise<{ projectId: string } | { error: string; status: 403 | 404 | 400 }> {
  const scope = await resolveProject(c)
  if ('error' in scope) return scope
  if (!(await isFeatureEnabled(scope.projectId, 'releases'))) {
    return {
      error: 'Releases are turned off for this project. A project owner or admin can enable them in project settings.',
      status: 404,
    }
  }
  if (!(await hasPermission(scope.projectId, auth(c).userId, need))) {
    return { error: `Forbidden: ${need} is required`, status: 403 }
  }
  return { projectId: scope.projectId }
}

bridgeRoute.get('/releases', async (c) => {
  const ready = await releasesReady(c as never, 'releases.read')
  if ('error' in ready) return c.json({ error: ready.error }, ready.status)

  const rows = await db
    .select({ r: releases, u: users })
    .from(releases)
    .leftJoin(users, eq(users.id, releases.ownerId))
    .where(eq(releases.projectId, ready.projectId))
    .orderBy(desc(releases.createdAt))
    .limit(100)

  // «Что сейчас в проде» — ради этого вопроса всё и затевалось, поэтому ответ
  // приходит вместе со списком, а не собирается агентом из него.
  const live: Record<string, { version: string; id: string }> = {}
  for (const { r } of rows) {
    if (isLiveStage(r.buildType, r.status) && !live[r.buildType]) {
      live[r.buildType] = { version: r.version, id: r.id }
    }
  }

  return c.json({
    items: rows.map(({ r, u }) => ({
      id: r.id,
      version: r.version,
      appName: r.appName,
      buildType: r.buildType,
      status: r.status,
      statusLabel: buildType(r.buildType)?.stages.find((st) => st.key === r.status)?.label ?? r.status,
      isLive: isLiveStage(r.buildType, r.status),
      owner: u ? { id: u.id, name: u.name } : null,
      buildProfile: r.buildProfile,
      referenceUrl: r.referenceUrl,
      notes: r.notes,
      releasedAt: r.releasedAt,
      createdAt: r.createdAt,
    })),
    live,
    buildTypes: BUILD_TYPES.map((t) => ({ key: t.key, label: t.label, stages: t.stages })),
  })
})

bridgeRoute.get('/releases/:id', async (c) => {
  const ready = await releasesReady(c as never, 'releases.read')
  if ('error' in ready) return c.json({ error: ready.error }, ready.status)

  const row = await db.query.releases.findFirst({
    where: and(eq(releases.id, c.req.param('id')), eq(releases.projectId, ready.projectId)),
  })
  if (!row) return c.json({ error: 'Not found' }, 404)

  const events = await db
    .select({ e: releaseEvents, u: users })
    .from(releaseEvents)
    .leftJoin(users, eq(users.id, releaseEvents.actorId))
    .where(eq(releaseEvents.releaseId, row.id))
    .orderBy(desc(releaseEvents.createdAt))

  const linked = await db
    .select({ t: tasks })
    .from(taskReleases)
    .innerJoin(tasks, eq(tasks.id, taskReleases.taskId))
    .where(eq(taskReleases.releaseId, row.id))

  return c.json({
    id: row.id,
    version: row.version,
    appName: row.appName,
    buildType: row.buildType,
    status: row.status,
    isLive: isLiveStage(row.buildType, row.status),
    buildProfile: row.buildProfile,
    referenceUrl: row.referenceUrl,
    notes: row.notes,
    releasedAt: row.releasedAt,
    stages: buildType(row.buildType)?.stages ?? [],
    tasks: linked.map(({ t }) => ({ id: t.id, number: t.number, title: t.title, status: t.status })),
    events: events.map(({ e, u }) => ({
      status: e.status,
      fromStatus: e.fromStatus,
      comment: e.comment,
      actor: u ? { id: u.id, name: u.name } : null,
      createdAt: e.createdAt,
    })),
  })
})

const RELEASE_FIELDS = ['version', 'appName', 'buildType', 'status', 'referenceUrl', 'notes', 'comment', 'buildProfile', 'project'] as const
const REQUEST_FIELDS = ['version', 'appName', 'buildType', 'assignee', 'comment', 'referenceUrl', 'buildProfile', 'estimateMinutes', 'project'] as const

bridgeRoute.post('/releases', async (c) => {
  const ready = await releasesReady(c as never, 'releases.manage')
  if ('error' in ready) return c.json({ error: ready.error }, ready.status)
  const parsed = await readJson(c as never)
  if ('error' in parsed) return c.json(parsed, 400)
  const b = parsed.body as Record<string, unknown>
  const bad = unknownFields(b, RELEASE_FIELDS)
  if (bad) return c.json({ error: bad }, 400)

  const version = typeof b.version === 'string' ? b.version.trim() : ''
  const type = typeof b.buildType === 'string' ? b.buildType : ''
  if (!version) return c.json({ error: 'version is required' }, 400)
  if (!buildType(type)) {
    return c.json({ error: `Unknown buildType "${type}". Use one of: ${BUILD_TYPES.map((t) => t.key).join(', ')}` }, 400)
  }
  const status = typeof b.status === 'string' && b.status ? b.status : firstStage(type)!
  if (!isValidStage(type, status)) {
    const allowed = buildType(type)!.stages.map((st) => st.key).join(', ')
    return c.json({ error: `Unknown status "${status}" for ${type}. Allowed: ${allowed}` }, 400)
  }

  const [row] = await db
    .insert(releases)
    .values({
      projectId: ready.projectId,
      version,
      buildType: type,
      status,
      ownerId: auth(c as never).userId,
      buildProfile: typeof b.buildProfile === 'string' ? b.buildProfile.slice(0, 50) : null,
      referenceUrl: typeof b.referenceUrl === 'string' ? b.referenceUrl.slice(0, 2000) : null,
      notes: typeof b.notes === 'string' ? b.notes.slice(0, 5000) : null,
      releasedAt: isLiveStage(type, status) ? new Date() : null,
    })
    .returning()

  await db.insert(releaseEvents).values({
    releaseId: row!.id,
    status,
    fromStatus: null,
    comment: typeof b.comment === 'string' && b.comment.trim() ? b.comment.trim() : 'Version created',
    actorId: auth(c as never).userId,
  })
  broadcast(ready.projectId, 'releases_changed', {})
  return c.json({ id: row!.id, version: row!.version, buildType: row!.buildType, status: row!.status }, 201)
})

/**
 * «Запросить сборку» через мост: задача + версия + связь, одним вызовом.
 *
 * Ровно то же, что делает кнопка в интерфейсе. Ассистенту это нужнее, чем
 * человеку: «попроси Артёма собрать прод-билд 1.4» — обычная просьба, и без
 * этой ручки она распадалась бы на три вызова, между которыми бывает обрыв.
 * Тогда остаётся задача без версии — то самое полусостояние, которое потом
 * приходится разбирать руками.
 *
 * Права нужны обе: releases.manage — завести версию, tasks.create — поручить
 * работу. Иначе ассистент раздавал бы поручения от имени человека, который на
 * это не уполномочен.
 */
bridgeRoute.post('/releases/request', async (c) => {
  const ready = await releasesReady(c as never, 'releases.manage')
  if ('error' in ready) return c.json({ error: ready.error }, ready.status)
  const id = auth(c as never)
  if (!(await hasPermission(ready.projectId, id.userId, 'tasks.create'))) {
    return c.json({ error: 'Forbidden: tasks.create is required to ask someone for a build' }, 403)
  }
  const parsed = await readJson(c as never)
  if ('error' in parsed) return c.json(parsed, 400)
  const b = parsed.body as Record<string, unknown>
  const bad = unknownFields(b, REQUEST_FIELDS)
  if (bad) return c.json({ error: bad }, 400)

  const version = typeof b.version === 'string' ? b.version.trim() : ''
  const type = typeof b.buildType === 'string' ? b.buildType : ''
  if (!version) return c.json({ error: 'version is required' }, 400)
  if (!buildType(type)) {
    return c.json({ error: `Unknown buildType "${type}". Use one of: ${BUILD_TYPES.map((t) => t.key).join(', ')}` }, 400)
  }

  // Исполнителя разрешаем тем же способом, что и у задач: «me», имя или id.
  // Иначе ассистенту пришлось бы держать две разные привычки для соседних
  // ручек, и он спотыкался бы ровно на этом.
  const assigneeId = b.assignee !== undefined ? await resolveAssignee(id, ready.projectId, b.assignee) : null
  if (assigneeId === undefined) return c.json({ error: `Unknown assignee: ${String(b.assignee)}` }, 400)

  const comment = typeof b.comment === 'string' ? b.comment.trim() : ''
  const status = firstStage(type)!
  const label = buildType(type)!.label

  const [{ next, minSort }] = (await db
    .select({
      next: sql<number>`coalesce(max(cast(substring(${tasks.number} from 6) as int)), 0) + 1`,
      minSort: sql<number>`coalesce(min(${tasks.sortOrder}), 0)`,
    })
    .from(tasks)
    .where(eq(tasks.projectId, ready.projectId))) as [{ next: number; minSort: number }]

  const [task] = await db
    .insert(tasks)
    .values({
      projectId: ready.projectId,
      number: `TASK-${next}`,
      sortOrder: minSort - 1,
      title: [label, typeof b.appName === 'string' ? b.appName.trim() : '', version].filter(Boolean).join(' '),
      description: comment ? richText(comment) : '',
      status: 'todo',
      priority: 'normal',
      assigneeId: assigneeId ?? null,
      createdById: id.userId,
      estimateMinutes: typeof b.estimateMinutes === 'number' ? String(Math.max(0, Math.round(b.estimateMinutes))) : null,
    })
    .returning()

  const [release] = await db
    .insert(releases)
    .values({
      projectId: ready.projectId,
      version,
      appName: typeof b.appName === 'string' ? b.appName.trim().slice(0, 80) || null : null,
      buildType: type,
      status,
      ownerId: id.userId,
      buildProfile: typeof b.buildProfile === 'string' ? b.buildProfile.slice(0, 50) : null,
      referenceUrl: typeof b.referenceUrl === 'string' ? b.referenceUrl.slice(0, 2000) : null,
      notes: comment || null,
    })
    .returning()

  await db.insert(releaseEvents).values({
    releaseId: release!.id,
    status,
    fromStatus: null,
    comment: comment || `@requested:${task!.number}`,
    actorId: id.userId,
  })
  await db.insert(taskReleases).values({ taskId: task!.id, releaseId: release!.id })

  // Человек узнаёт о поручении так же, как о любой другой задаче.
  if (task!.assigneeId) void notifyTask(ready.projectId, id.userId, task!, { assigneeChanged: true, mentions: false })
  broadcast(ready.projectId, 'releases_changed', {})
  tasksChanged(ready.projectId, [task!.assigneeId, id.userId])

  const companyId = await companyOf(ready.projectId)
  return c.json(
    {
      task: {
        id: task!.id,
        number: task!.number,
        title: task!.title,
        ...(companyId ? { url: projectUrl(env.APP_URL, companyId, ready.projectId, `/tasks/${task!.id}`) } : {}),
      },
      release: {
        id: release!.id,
        version: release!.version,
        buildType: release!.buildType,
        status: release!.status,
        ...(companyId
          ? { url: projectUrl(env.APP_URL, companyId, ready.projectId, `/releases/${release!.id}`) }
          : {}),
      },
    },
    201,
  )
})

bridgeRoute.post('/releases/:id/stage', async (c) => {
  const ready = await releasesReady(c as never, 'releases.manage')
  if ('error' in ready) return c.json({ error: ready.error }, ready.status)
  const parsed = await readJson(c as never)
  if ('error' in parsed) return c.json(parsed, 400)
  const b = parsed.body as Record<string, unknown>

  const existing = await db.query.releases.findFirst({
    where: and(eq(releases.id, c.req.param('id')), eq(releases.projectId, ready.projectId)),
  })
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const status = typeof b.status === 'string' ? b.status : ''
  const comment = typeof b.comment === 'string' ? b.comment.trim() : ''
  if (!isValidStage(existing.buildType, status)) {
    const allowed = buildType(existing.buildType)?.stages.map((st) => st.key).join(', ') ?? ''
    return c.json({ error: `Unknown status "${status}" for ${existing.buildType}. Allowed: ${allowed}` }, 400)
  }
  // Комментарий обязателен: пустой переход не объясняет ничего, а спросить
  // задним числом уже не у кого — человек не вспомнит, почему две недели назад
  // откатил сборку.
  if (!comment) return c.json({ error: 'comment is required: say what happened, it is the point of the history' }, 400)
  if (status === existing.status) return c.json({ error: 'The version is already at this stage' }, 400)

  const nowLive = isLiveStage(existing.buildType, status)
  await db
    .update(releases)
    .set({
      status,
      updatedAt: new Date(),
      // Дата выката ставится один раз: откат и повторный выход не переписывают
      // момент, когда версия впервые доехала до людей.
      releasedAt: nowLive && !existing.releasedAt ? new Date() : existing.releasedAt,
    })
    .where(eq(releases.id, existing.id))
  await db.insert(releaseEvents).values({
    releaseId: existing.id,
    status,
    fromStatus: existing.status,
    comment,
    actorId: auth(c as never).userId,
  })
  broadcast(ready.projectId, 'releases_changed', {})
  // Через мост стадию двигает ассистент от имени человека — уведомление такое
  // же, как из интерфейса: автору версии и исполнителям связанных задач.
  void notifyReleaseStage(ready.projectId, auth(c as never).userId, existing, status)
  return c.json({ id: existing.id, version: existing.version, from: existing.status, status })
})

/**
 * Интеграция с Expo через мост.
 *
 * Ассистенту это нужно чаще, чем человеку: «подключи Expo» — просьба на одну
 * строку, а вручную это поход в интерфейс, копирование секрета и команда в
 * терминале. Ручка отдаёт готовую команду — её остаётся выполнить в папке
 * приложения.
 */
bridgeRoute.get('/integrations/expo', async (c) => {
  const ready = await releasesReady(c as never, 'releases.manage')
  if ('error' in ready) return c.json({ error: ready.error }, ready.status)
  const row = await db.query.projectIntegrations.findFirst({
    where: and(eq(projectIntegrations.projectId, ready.projectId), eq(projectIntegrations.kind, 'expo')),
  })
  if (!row) return c.json({ connected: false })
  const url = `${(process.env.API_PUBLIC_URL || 'https://api.chatick.com').replace(/\/$/, '')}/hooks/expo/${row.secret}`
  return c.json({
    connected: true,
    url,
    command: `eas webhook:create --event BUILD --url ${url} --secret ${row.secret}`,
    lastEventAt: row.lastEventAt,
  })
})

bridgeRoute.post('/integrations/expo', async (c) => {
  const ready = await releasesReady(c as never, 'releases.manage')
  if ('error' in ready) return c.json({ error: ready.error }, ready.status)
  const id = auth(c as never)

  const existing = await db.query.projectIntegrations.findFirst({
    where: and(eq(projectIntegrations.projectId, ready.projectId), eq(projectIntegrations.kind, 'expo')),
  })
  // Повторный вызов возвращает тот же секрет: иначе ассистент, позвавший ручку
  // дважды, тихо сломал бы уже настроенный вебхук.
  const secret = existing?.secret ?? randomBytes(24).toString('base64url').slice(0, 32)
  if (!existing) {
    await db
      .insert(projectIntegrations)
      .values({ projectId: ready.projectId, kind: 'expo', secret, createdById: id.userId })
  }
  const url = `${(process.env.API_PUBLIC_URL || 'https://api.chatick.com').replace(/\/$/, '')}/hooks/expo/${secret}`
  return c.json({
    connected: true,
    url,
    command: `eas webhook:create --event BUILD --url ${url} --secret ${secret}`,
    next: 'Run the command in the app folder. For several apps (client, provider) run it in each one.',
  })
})

bridgeRoute.get('/sprints', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.read', scope.projectId)
  if (denied) return c.json(denied, 403)
  const rows = await db.query.taskGroups.findMany({
    where: and(eq(taskGroups.projectId, scope.projectId), isNull(taskGroups.deletedAt)),
  })
  // Сколько задач внутри — чтобы было видно, что удаление расформирует, а что
  // пройдёт бесследно.
  const counts = new Map<string, number>()
  if (rows.length) {
    const grouped = await db
      .select({ groupId: tasks.groupId, n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.projectId, scope.projectId), isNull(tasks.deletedAt)))
      .groupBy(tasks.groupId)
    for (const g of grouped) if (g.groupId) counts.set(g.groupId, g.n)
  }
  return c.json({ items: rows.map((s) => ({ id: s.id, name: s.name, color: s.color, taskCount: counts.get(s.id) ?? 0 })) })
})

bridgeRoute.post('/sprints', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.create', scope.projectId)
  if (denied) return c.json(denied, 403)
  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name) return c.json({ error: 'name is required' }, 400)
  const [row] = await db
    .insert(taskGroups)
    .values({ projectId: scope.projectId, name: name.slice(0, 120), createdById: id.userId })
    .returning()
  broadcast(scope.projectId, 'tasks_changed', {})
  return c.json({ id: row!.id, name: row!.name }, 201)
})

/**
 * Переименовать спринт.
 *
 * Была только запись: опечатка в названии — и исправить её через мост нельзя,
 * оставалось идти в приложение руками. Особенно больно с не-ASCII названиями:
 * имя, побитое кодировкой при создании, чинилось только человеком.
 */
bridgeRoute.patch('/sprints/:id', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.edit', scope.projectId)
  if (denied) return c.json(denied, 403)

  const group = await db.query.taskGroups.findFirst({
    where: and(eq(taskGroups.id, c.req.param('id')), eq(taskGroups.projectId, scope.projectId), isNull(taskGroups.deletedAt)),
  })
  if (!group) return c.json({ error: 'Not found' }, 404)

  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const bad = unknownFields(b, ['name', 'color'])
  if (bad) return c.json({ error: bad }, 400)

  const patch: Partial<typeof taskGroups.$inferInsert> = {}
  if (b.name !== undefined) {
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name) return c.json({ error: 'name cannot be empty' }, 400)
    patch.name = name.slice(0, 120)
  }
  if (b.color !== undefined) {
    if (typeof b.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(b.color))
      return c.json({ error: 'color must be a hex like #64748b' }, 400)
    patch.color = b.color
  }
  if (!Object.keys(patch).length) return c.json({ error: 'Nothing to change. Allowed: name, color.' }, 400)

  const [row] = await db.update(taskGroups).set(patch).where(eq(taskGroups.id, group.id)).returning()
  broadcast(scope.projectId, 'tasks_changed', {})
  return c.json({ id: row!.id, name: row!.name, color: row!.color })
})

/**
 * Удалить спринт. Задачи остаются: у них просто пропадает группа.
 *
 * Поэтому удаление тут допустимо — в отличие от задач и проектов, стирать
 * нечего. Но непустой спринт молча не расформировываем: ассистент,
 * убирающий опечатку, обычно не подозревает, что внутри лежит работа
 * половины команды. Нужен ?force=1, и в отказе сказано, сколько задач
 * останется без группы.
 */
bridgeRoute.delete('/sprints/:id', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.edit', scope.projectId)
  if (denied) return c.json(denied, 403)

  const group = await db.query.taskGroups.findFirst({
    where: and(eq(taskGroups.id, c.req.param('id')), eq(taskGroups.projectId, scope.projectId), isNull(taskGroups.deletedAt)),
  })
  if (!group) return c.json({ error: 'Not found' }, 404)

  const [{ n }] = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.groupId, group.id), isNull(tasks.deletedAt)))) as [{ n: number }]
  if (n > 0 && c.req.query('force') !== '1') {
    return c.json(
      {
        error: `"${group.name}" holds ${n} task(s). Deleting the sprint leaves them without one — nothing is deleted, but the grouping is gone. Repeat with ?force=1 if that is what you want.`,
        taskCount: n,
      },
      409,
    )
  }

  // Жёсткое удаление: внешний ключ сам обнулит groupId у задач.
  await db.delete(taskGroups).where(eq(taskGroups.id, group.id))
  void logActivity({
    projectId: scope.projectId,
    actorId: id.userId,
    action: 'delete',
    entityType: 'task',
    entityId: group.id,
    entityLabel: `sprint ${group.name}`,
  })
  broadcast(scope.projectId, 'tasks_changed', {})
  return c.json({ ok: true, ungroupedTasks: n })
})

// --- Трекинг времени (SPEC §8.32) -------------------------------------------
// Ради того, чтобы не тыкать таймеры руками: агент в редакторе знает, когда
// работа началась и кончилась, — пусть он и записывает.

/**
 * Отметка времени из тела запроса.
 *
 * undefined — прислали мусор (вызывающий отвечает 400), null — не прислали
 * ничего. Без этого разбора `new Date('вчера')` давал Invalid Date, и запись
 * падала на вставке пятисоткой вместо внятной ошибки.
 */
function parseStamp(v: unknown): Date | null | undefined {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string') return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/**
 * Мои идущие таймеры — ВО ВСЕХ проектах, а не только в открытом.
 *
 * Человек один: уйдя в другой проект, он не перестаёт работать. Пока выборка
 * была ограничена текущим проектом, ассистент отвечал «таймер не запущен», а
 * часы в соседнем проекте продолжали капать — и человек узнавал об этом на
 * следующий день. Так же устроен и живой интерфейс.
 */
bridgeRoute.get('/time/running', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const cfg = await timeConfigForProject(scope.projectId)
  const rows = await db
    .select({ e: timeEntries, p: projects })
    .from(timeEntries)
    .leftJoin(projects, eq(projects.id, timeEntries.projectId))
    .where(and(eq(timeEntries.userId, id.userId), isNull(timeEntries.endedAt)))

  const now = Date.now()
  return c.json({
    items: rows.map((r) => ({
      id: r.e.id,
      description: r.e.description,
      taskId: r.e.taskId,
      projectId: r.e.projectId,
      project: r.p?.name ?? null,
      // Чужой проект помечаем прямо: иначе ассистент решит, что это часы
      // здесь, и предложит остановить не то.
      here: r.e.projectId === scope.projectId,
      startedAt: r.e.startedAt,
      elapsedMinutes: Math.round((now - r.e.startedAt.getTime()) / 60_000),
    })),
    maxTimers: cfg.maxTimers,
    hint: 'One entry links to ONE task at most. Two things at once means two timers, up to maxTimers. The limit counts the person, across all projects.',
  })
})

bridgeRoute.post('/time/start', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const cfg = await timeConfigForProject(scope.projectId)

  // Лимит считает ЧЕЛОВЕКА, а не проект. Пока условие включало projectId,
  // при лимите 1 можно было завести по таймеру в каждом проекте и «работать»
  // в пяти местах разом — ровно то, от чего лимит и защищает.
  const running = await db
    .select({ e: timeEntries, p: projects })
    .from(timeEntries)
    .leftJoin(projects, eq(projects.id, timeEntries.projectId))
    .where(and(eq(timeEntries.userId, id.userId), isNull(timeEntries.endedAt)))
  if (running.length >= cfg.maxTimers) {
    const elsewhere = running.find((r) => r.e.projectId !== scope.projectId)
    return c.json(
      {
        error: elsewhere
          ? `A timer is already running in "${elsewhere.p?.name ?? 'another project'}". Stop it first, or raise the parallel-timer limit.`
          : `${running.length} timer(s) already running; the limit is ${cfg.maxTimers}. Stop one first.`,
        running: running.map((r) => ({
          id: r.e.id,
          startedAt: r.e.startedAt,
          description: r.e.description,
          project: r.p?.name ?? null,
          here: r.e.projectId === scope.projectId,
        })),
      },
      409,
    )
  }

  let taskId: string | null = null
  if (typeof b.task === 'string' && b.task) {
    const found = await db.query.tasks.findFirst({
      where: and(eq(tasks.projectId, scope.projectId), eq(tasks.number, b.task.toUpperCase())),
    })
    if (!found) return c.json({ error: `Task ${b.task} not found in this project` }, 404)
    taskId = found.id
  }

  // Дата приходит строкой снаружи. Непонятную строку new Date превращает в
  // Invalid Date, и запись падала на вставке пятисоткой вместо внятного 400.
  const startedAt = parseStamp(b.startedAt)
  if (startedAt === undefined) return c.json({ error: 'startedAt must be an ISO timestamp' }, 400)
  if (startedAt && startedAt.getTime() > Date.now() + 60_000)
    return c.json({ error: 'startedAt is in the future' }, 400)

  const [row] = await db
    .insert(timeEntries)
    .values({
      projectId: scope.projectId,
      userId: id.userId,
      taskId,
      description: String(b.description ?? '').slice(0, 500),
      startedAt: startedAt ?? new Date(),
      createdVia: 'bridge',
    })
    .returning()
  broadcast(scope.projectId, 'time', { action: 'start', id: row!.id, userId: id.userId })
  // Трей живёт вне проекта, а часы — собственные: без этого панель у человека
  // до полуминуты показывала, что таймер не идёт.
  sendToUserAnywhere(id.userId, 'time', { action: 'start', id: row!.id })
  void maybeTranslate(scope.projectId, row!.id, row!.description).catch(() => {})
  return c.json({ id: row!.id, startedAt: row!.startedAt }, 201)
})

bridgeRoute.post('/time/stop', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  // Свой таймер ищем во всех проектах: забытый в соседнем проекте иначе не
  // остановить — ассистент получал «таймер не запущен», а часы шли.
  const running = await db
    .select({ e: timeEntries, p: projects })
    .from(timeEntries)
    .leftJoin(projects, eq(projects.id, timeEntries.projectId))
    .where(and(eq(timeEntries.userId, id.userId), isNull(timeEntries.endedAt)))
  if (!running.length) return c.json({ error: 'No timer is running' }, 404)

  const entry = typeof b.id === 'string' ? running.find((r) => r.e.id === b.id)?.e : running[0]!.e
  if (!entry) return c.json({ error: 'That timer is not running' }, 404)
  if (running.length > 1 && typeof b.id !== 'string') {
    return c.json(
      {
        error: 'Several timers are running — pass the id',
        running: running.map((r) => ({
          id: r.e.id,
          description: r.e.description,
          project: r.p?.name ?? null,
          here: r.e.projectId === scope.projectId,
        })),
      },
      400,
    )
  }

  const endedAt = new Date()
  // меньше секунды — двойной клик, а не работа
  if (endedAt.getTime() - entry.startedAt.getTime() < 1_000) {
    await db.delete(timeEntries).where(eq(timeEntries.id, entry.id))
    broadcast(entry.projectId, 'time', { action: 'delete', id: entry.id, userId: id.userId })
    sendToUserAnywhere(id.userId, 'time', { action: 'delete', id: entry.id })
    return c.json({ discarded: true, reason: 'Stopped within a second — nothing recorded.' })
  }
  await db.update(timeEntries).set({ endedAt, updatedAt: endedAt }).where(eq(timeEntries.id, entry.id))
  // Оповещаем проект, где таймер шёл, а не тот, откуда пришёл запрос.
  broadcast(entry.projectId, 'time', { action: 'stop', id: entry.id, userId: id.userId })
  sendToUserAnywhere(id.userId, 'time', { action: 'stop', id: entry.id })
  return c.json({
    id: entry.id,
    minutes: Math.round((endedAt.getTime() - entry.startedAt.getTime()) / 60_000),
    ...(entry.projectId === scope.projectId ? {} : { stoppedInAnotherProject: true }),
  })
})

bridgeRoute.post('/time', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const started = new Date(String(b.startedAt ?? ''))
  let ended = new Date(String(b.endedAt ?? ''))
  if (Number.isNaN(started.getTime()) || Number.isNaN(ended.getTime())) {
    return c.json({ error: 'startedAt and endedAt are required ISO timestamps' }, 400)
  }
  // конец раньше начала — смена через полночь
  if (ended.getTime() <= started.getTime()) ended = new Date(ended.getTime() + 86_400_000)

  let taskId: string | null = null
  if (typeof b.task === 'string' && b.task) {
    const found = await db.query.tasks.findFirst({
      where: and(eq(tasks.projectId, scope.projectId), eq(tasks.number, b.task.toUpperCase())),
    })
    if (!found) return c.json({ error: `Task ${b.task} not found in this project` }, 404)
    taskId = found.id
  }

  const [row] = await db
    .insert(timeEntries)
    .values({
      projectId: scope.projectId,
      userId: id.userId,
      taskId,
      description: String(b.description ?? '').slice(0, 500),
      startedAt: started,
      endedAt: ended,
      createdVia: 'bridge',
    })
    .returning()
  broadcast(scope.projectId, 'time', { action: 'create', id: row!.id, userId: id.userId })
  sendToUserAnywhere(id.userId, 'time', { action: 'create', id: row!.id })
  void maybeTranslate(scope.projectId, row!.id, row!.description).catch(() => {})
  return c.json({ id: row!.id, minutes: Math.round((ended.getTime() - started.getTime()) / 60_000) }, 201)
})

/**
 * Отдельные записи, а не сводка.
 *
 * Отчёт складывает часы по людям и задачам — по нему нельзя ни увидеть, что
 * записано за вчера построчно, ни взять id записи, чтобы её поправить. Из-за
 * этого через мост нельзя было исправить ошибочную запись вообще.
 */
bridgeRoute.get('/time', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  // Чужие часы — только руководству проекта, как и в отчёте.
  const privileged = await hasPermission(scope.projectId, id.userId, 'tasks.edit')
  const q = c.req.query()
  const conds = [eq(timeEntries.projectId, scope.projectId)]
  if (!privileged || q.mine === '1') conds.push(eq(timeEntries.userId, id.userId))
  const from = parseStamp(q.from)
  const to = parseStamp(q.to)
  if (from === undefined || to === undefined) return c.json({ error: 'from/to must be ISO dates' }, 400)
  if (from) conds.push(gte(timeEntries.startedAt, from))
  if (to) {
    const end = new Date(to)
    if (!q.to!.includes('T')) end.setHours(23, 59, 59, 999)
    conds.push(lte(timeEntries.startedAt, end))
  }
  if (q.task?.trim()) {
    const found = await db.query.tasks.findFirst({
      where: and(eq(tasks.projectId, scope.projectId), eq(tasks.number, q.task.trim().toUpperCase())),
    })
    if (!found) return c.json({ error: `Task ${q.task} not found in this project` }, 404)
    conds.push(eq(timeEntries.taskId, found.id))
  }
  if (q.q?.trim()) conds.push(ilike(timeEntries.description, `%${q.q.trim()}%`))

  const limit = Math.min(500, Math.max(1, Number(q.limit) || 100))
  const rows = await db
    .select({ e: timeEntries, u: users, t: tasks })
    .from(timeEntries)
    .leftJoin(users, eq(users.id, timeEntries.userId))
    .leftJoin(tasks, eq(tasks.id, timeEntries.taskId))
    .where(and(...conds))
    .orderBy(desc(timeEntries.startedAt))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const items = rows.slice(0, limit)
  const now = Date.now()
  return c.json({
    items: items.map((r) => ({
      id: r.e.id,
      description: r.e.description,
      task: r.t ? { number: r.t.number, title: r.t.title } : null,
      author: r.u?.name ?? null,
      mine: r.e.userId === id.userId,
      startedAt: r.e.startedAt,
      endedAt: r.e.endedAt,
      running: !r.e.endedAt,
      minutes: Math.round(((r.e.endedAt?.getTime() ?? now) - r.e.startedAt.getTime()) / 60_000),
    })),
    scope: privileged && q.mine !== '1' ? 'everyone' : 'you only',
    hasMore,
    ...(hasMore ? { hint: 'Truncated — narrow from/to or raise limit (max 500).' } : {}),
  })
})

const TIME_PATCH_FIELDS = ['description', 'startedAt', 'endedAt', 'task', 'project'] as const

/**
 * Поправить запись: не тот текст, не та задача, забыли включить таймер вовремя.
 *
 * Свою — всегда, чужую — только руководству проекта и только в этом проекте.
 * Удаления через мост нет: стереть чужие часы куда хуже, чем поправить их.
 */
bridgeRoute.patch('/time/:id', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const entry = await db.query.timeEntries.findFirst({
    where: and(eq(timeEntries.id, c.req.param('id')), eq(timeEntries.projectId, scope.projectId)),
  })
  if (!entry) return c.json({ error: 'Not found' }, 404)
  if (entry.userId !== id.userId && !(await hasPermission(scope.projectId, id.userId, 'tasks.edit')))
    return c.json({ error: 'That entry belongs to someone else' }, 403)

  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const bad = unknownFields(b, TIME_PATCH_FIELDS)
  if (bad) return c.json({ error: bad }, 400)

  const patch: Partial<typeof timeEntries.$inferInsert> = { updatedAt: new Date() }

  if (b.description !== undefined) {
    if (typeof b.description !== 'string') return c.json({ error: 'description must be a string' }, 400)
    patch.description = b.description.slice(0, 500)
  }

  // Перенос в другой проект — часы уехали не туда, обычное дело. Переносить
  // можно только туда, где человек действительно состоит, иначе через мост
  // получилось бы завести часы в чужом проекте.
  let targetProject = entry.projectId
  if (b.project !== undefined) {
    if (typeof b.project !== 'string' || !b.project) return c.json({ error: 'project must be a project id' }, 400)
    if (b.project !== entry.projectId) {
      const membership = await projectRoleOf(b.project, id.userId)
      if (!membership) return c.json({ error: 'You are not a member of that project' }, 403)
      patch.projectId = b.project
      targetProject = b.project
      // Задача осталась в прежнем проекте — связь рвём, иначе запись ссылалась
      // бы на задачу, которой в новом проекте нет.
      patch.taskId = null
    }
  }

  if (b.task !== undefined) {
    if (b.task === null || b.task === '') patch.taskId = null
    else if (typeof b.task !== 'string') return c.json({ error: 'task must be a task number or null' }, 400)
    else {
      const found = await db.query.tasks.findFirst({
        where: and(eq(tasks.projectId, targetProject), eq(tasks.number, b.task.toUpperCase())),
      })
      if (!found) return c.json({ error: `Task ${b.task} not found in that project` }, 404)
      patch.taskId = found.id
    }
  }

  const startedAt = parseStamp(b.startedAt)
  const endedAt = parseStamp(b.endedAt)
  if (startedAt === undefined && b.startedAt !== undefined) return c.json({ error: 'startedAt must be an ISO timestamp' }, 400)
  if (endedAt === undefined && b.endedAt !== undefined) return c.json({ error: 'endedAt must be an ISO timestamp' }, 400)
  if (startedAt) patch.startedAt = startedAt
  // endedAt: null явно означает «снова идёт», это не то же самое, что «не трогай».
  if (b.endedAt !== undefined) patch.endedAt = endedAt

  const from = patch.startedAt ?? entry.startedAt
  const till = b.endedAt !== undefined ? endedAt : entry.endedAt
  if (till && till.getTime() <= from.getTime())
    return c.json({ error: 'endedAt must be later than startedAt' }, 400)

  if (Object.keys(patch).length === 1) return c.json({ error: `Nothing to change. Allowed: ${TIME_PATCH_FIELDS.join(', ')}.` }, 400)

  const [row] = await db.update(timeEntries).set(patch).where(eq(timeEntries.id, entry.id)).returning()
  // Оба проекта: часы исчезли из одного и появились в другом, и обе страницы
  // должны это увидеть.
  broadcast(scope.projectId, 'time', { action: 'update', id: row!.id, userId: entry.userId })
  if (targetProject !== entry.projectId) broadcast(targetProject, 'time', { action: 'update', id: row!.id, userId: entry.userId })
  sendToUserAnywhere(entry.userId, 'time', { action: 'update', id: row!.id })
  if (b.description !== undefined) void maybeTranslate(targetProject, row!.id, row!.description).catch(() => {})
  return c.json({
    id: row!.id,
    description: row!.description,
    projectId: row!.projectId,
    startedAt: row!.startedAt,
    endedAt: row!.endedAt,
    running: !row!.endedAt,
    minutes: row!.endedAt ? Math.round((row!.endedAt.getTime() - row!.startedAt.getTime()) / 60_000) : null,
  })
})

/**
 * Продолжить работу: пауза — это остановка, а возобновление — новая запись.
 *
 * Отдельных полей «пауза» у записи нет: перерыв не должен попадать в часы.
 * Поэтому «поставил на паузу» = POST /x/time/stop, «продолжил» = сюда. Без
 * этой ручки ассистенту пришлось бы вручную вычитывать прошлую запись, чтобы
 * не потерять описание и задачу, — и он бы их терял.
 */
bridgeRoute.post('/time/resume', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const cfg = await timeConfigForProject(scope.projectId)

  const running = await db
    .select({ e: timeEntries, p: projects })
    .from(timeEntries)
    .leftJoin(projects, eq(projects.id, timeEntries.projectId))
    .where(and(eq(timeEntries.userId, id.userId), isNull(timeEntries.endedAt)))
  if (running.length >= cfg.maxTimers) {
    const elsewhere = running.find((r) => r.e.projectId !== scope.projectId)
    return c.json(
      {
        error: elsewhere
          ? `A timer is already running in "${elsewhere.p?.name ?? 'another project'}". Stop it first.`
          : 'A timer is already running. Stop it first.',
        running: running.map((r) => ({ id: r.e.id, description: r.e.description, project: r.p?.name ?? null })),
      },
      409,
    )
  }

  // По умолчанию продолжаем последнее, что закончили в этом проекте.
  const source = typeof b.id === 'string' && b.id
    ? await db.query.timeEntries.findFirst({
        where: and(eq(timeEntries.id, b.id), eq(timeEntries.projectId, scope.projectId), eq(timeEntries.userId, id.userId)),
      })
    : await db.query.timeEntries.findFirst({
        where: and(eq(timeEntries.projectId, scope.projectId), eq(timeEntries.userId, id.userId), sql`${timeEntries.endedAt} is not null`),
        orderBy: desc(timeEntries.endedAt),
      })
  if (!source) return c.json({ error: 'Nothing to resume — no finished entry of yours in this project' }, 404)

  const [row] = await db
    .insert(timeEntries)
    .values({
      projectId: scope.projectId,
      userId: id.userId,
      taskId: source.taskId,
      description: source.description,
      startedAt: new Date(),
      createdVia: 'bridge',
    })
    .returning()
  broadcast(scope.projectId, 'time', { action: 'start', id: row!.id, userId: id.userId })
  sendToUserAnywhere(id.userId, 'time', { action: 'start', id: row!.id })
  return c.json({ id: row!.id, description: row!.description, taskId: row!.taskId, startedAt: row!.startedAt, resumedFrom: source.id }, 201)
})

bridgeRoute.get('/time/report', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  // чужие часы — только руководству проекта
  const privileged = await hasPermission(scope.projectId, id.userId, 'tasks.edit')
  const conds = [eq(timeEntries.projectId, scope.projectId), sql`${timeEntries.endedAt} is not null`]
  if (!privileged) conds.push(eq(timeEntries.userId, id.userId))
  const from = c.req.query('from')
  const to = c.req.query('to')
  if (from) conds.push(sql`${timeEntries.startedAt} >= ${new Date(from).toISOString()}::timestamptz`)
  if (to) {
    const end = new Date(to)
    end.setHours(23, 59, 59, 999)
    conds.push(sql`${timeEntries.startedAt} <= ${end.toISOString()}::timestamptz`)
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

  return c.json({
    byUser: byUser.sort((a, b) => b.minutes - a.minutes),
    byTask: byTask.sort((a, b) => b.minutes - a.minutes),
    totalMinutes: byUser.reduce((sum, r) => sum + r.minutes, 0),
    scope: privileged ? 'everyone' : 'you only',
  })
})

// --- Заметки (SPEC §8.31) ----------------------------------------------------
// Ради двух сценариев: «сохрани это решение на будущее» из редактора и
// «зафиксируй, что тут противоречие» из чата. Второй берёт цитаты копией.

bridgeRoute.get('/notes', async (c) => {
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  // База знаний принадлежит КОМПАНИИ: доступ даёт членство в ней, а не права
  // в проекте. Знание про Cardcom нужно всем, кто с ним столкнётся.
  const kbCompany = await companyOf(scope.projectId)
  if (!kbCompany || !(await canUseKnowledge(kbCompany, auth(c as never).userId))) {
    return c.json({ error: 'You are not a member of this company' }, 403)
  }

  const q = c.req.query('q')?.trim()
  const conds = [isNull(notes.deletedAt)]

  /**
   * По умолчанию — ВСЯ КОМПАНИЯ. Сузить до проекта можно явно.
   *
   * Раньше было наоборот, и это осталось от времён, когда заметки были
   * журналом проекта. Теперь они принадлежат компании, и умолчание «только
   * этот проект» прятало ровно то, ради чего база заводилась: решение,
   * найденное в соседнем проекте.
   *
   * Условие по notes.scope убрано: поле осталось от прежнего устройства и
   * больше ничего не значит. Пока оно стояло в отборе, запись, созданная из
   * проекта (scope='project'), не находилась НИКОГДА — даже с ?scope=company.
   */
  conds.push(eq(notes.companyId, kbCompany))
  if (c.req.query('scope') === 'project') conds.push(eq(notes.projectId, scope.projectId))

  const types = (c.req.query('type') ?? '').split(',').map((t) => t.trim()).filter(Boolean)
  if (types.length) conds.push(inArray(notes.type, types))
  for (const tag of (c.req.query('tag') ?? '').split(',').map((t) => t.trim()).filter(Boolean)) {
    conds.push(sql`${notes.tags}::jsonb ? ${tag}`)
  }
  // Поиск по СМЫСЛУ, а не только по словам.
  //
  // «Не проходит оплата» и «Cardcom отклоняет платежи» — один вопрос и ни
  // одного общего слова. Для иврита это единственный путь: словаря иврита в
  // Postgres нет, и ilike найдёт только точную форму слова.
  //
  // Слова остаются: «Cardcom» надёжнее искать дословно, чем через модель.
  // Гибрид — сначала точные совпадения, потом смысловые.
  let semanticOrder: string[] | null = null
  const semanticSet = new Set<string>()
  if (q) {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, scope.projectId) })
    const hybrid = await searchNoteIds({
      query: q,
      projectId: scope.projectId,
      companyId: project?.companyId ?? null,
      // По умолчанию вся компания: сузить до проекта — явно.
      companyWide: c.req.query('scope') !== 'project',
      limit: Math.min(100, Math.max(1, Number(c.req.query('limit')) || 50)),
    })
    if (hybrid.ids.length) {
      semanticOrder = hybrid.ids
      for (const id of hybrid.semanticIds) semanticSet.add(id)
      conds.push(inArray(notes.id, hybrid.ids))
    } else {
      // Ничего не нашли — так и говорим. Прежний ilike в этом месте просто
      // не добавлял условия и возвращал ВСЕ заметки: ассистент получал
      // полный список и считал его результатом поиска.
      conds.push(sql`false`)
    }
  }

  const rows = await db
    .select({ n: notes, author: users, project: projects })
    .from(notes)
    .leftJoin(users, eq(users.id, notes.authorId))
    .leftJoin(projects, eq(projects.id, notes.projectId))
    .where(and(...conds))
    .orderBy(desc(notes.createdAt))
    .limit(Math.min(100, Math.max(1, Number(c.req.query('limit')) || 50)))

  // Порядок из гибридного поиска сильнее сортировки по дате: точные
  // совпадения идут первыми, смысловые следом. Без этого самое близкое по
  // смыслу тонуло бы среди свежих, но неподходящих.
  const ordered = semanticOrder
    ? [...rows].sort((a, b) => semanticOrder!.indexOf(a.n.id) - semanticOrder!.indexOf(b.n.id))
    : rows

  return c.json({
    items: ordered.map((r) => ({
      id: r.n.id,
      type: r.n.type,
      title: r.n.title,
      preview: htmlToText(r.n.body).slice(0, 200),
      tags: JSON.parse(r.n.tags) as string[],
      scope: r.n.scope,
      project: { id: r.n.projectId, name: r.project?.name ?? '' },
      author: r.author ? { id: r.author.id, name: r.author.name } : null,
      sourceCount: (JSON.parse(r.n.sources) as unknown[]).length,
      // Найдено по смыслу, а не по слову: общих слов с запросом может не быть
      // вовсе, и без пометки такой ответ выглядит случайным.
      ...(semanticSet.has(r.n.id) ? { matchedBy: 'meaning' as const } : {}),
      createdAt: r.n.createdAt,
    })),
    hint:
      'Search here understands MEANING, not just words: "payment fails" finds "Cardcom rejects foreign cards" with no shared word, and it works the same in Hebrew. Items marked matchedBy="meaning" were found that way. Add ?scope=company to search notes shared across every project of this company — that is where reusable technical solutions live. GET /x/notes/<id> returns the full body and the quoted sources.',
  })
})

bridgeRoute.get('/notes/:id', async (c) => {
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  // База знаний принадлежит КОМПАНИИ: доступ даёт членство в ней, а не права
  // в проекте. Знание про Cardcom нужно всем, кто с ним столкнётся.
  const kbCompany = await companyOf(scope.projectId)
  if (!kbCompany || !(await canUseKnowledge(kbCompany, auth(c as never).userId))) {
    return c.json({ error: 'You are not a member of this company' }, 403)
  }

  const row = await db.query.notes.findFirst({
    where: and(eq(notes.id, c.req.param('id')), isNull(notes.deletedAt)),
  })
  if (!row) return c.json({ error: 'Note not found' }, 404)

  // чужой проект — только если заметка помечена как company-видимая
  if (row.projectId !== scope.projectId) {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, scope.projectId) })
    if (!(row.scope === 'company' && row.companyId && row.companyId === project?.companyId)) {
      return c.json({ error: 'Note not found' }, 404)
    }
  }

  const author = row.authorId ? await db.query.users.findFirst({ where: eq(users.id, row.authorId) }) : null
  return c.json({
    id: row.id,
    type: row.type,
    title: row.title,
    body: htmlToText(row.body),
    html: row.body,
    attachments: await inlineAttachments(row.body, scope.projectId),
    tags: JSON.parse(row.tags) as string[],
    scope: row.scope,
    projectId: row.projectId,
    sources: JSON.parse(row.sources) as unknown[],
    mentionedIds: JSON.parse(row.mentionedIds) as string[],
    remindAt: row.remindAt,
    taskId: row.taskId, // задача, выросшая из этой заметки
    createdVia: row.createdVia, // ui | bridge | ai — видно, чьей рукой заведена
    author: author ? { id: author.id, name: author.name } : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
})

bridgeRoute.post('/notes', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  // База знаний принадлежит КОМПАНИИ: доступ даёт членство в ней, а не права
  // в проекте. Знание про Cardcom нужно всем, кто с ним столкнётся.
  const kbCompany = await companyOf(scope.projectId)
  if (!kbCompany || !(await canUseKnowledge(kbCompany, auth(c as never).userId))) {
    return c.json({ error: 'You are not a member of this company' }, 403)
  }

  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const type = String(b.type ?? 'note')
  if (!(NOTE_TYPES as readonly string[]).includes(type)) {
    return c.json({ error: `type must be one of: ${NOTE_TYPES.join(', ')}` }, 400)
  }
  if (!String(b.title ?? '').trim() && !String(b.body ?? '').trim()) {
    return c.json({ error: 'Provide at least title or body' }, 400)
  }

  const row = await createNote(
    scope.projectId,
    id.userId,
    {
      type: type as NoteType,
      title: String(b.title ?? '').slice(0, 300),
      body: richText(String(b.body ?? '')),
      tags: Array.isArray(b.tags) ? (b.tags as unknown[]).map(String).slice(0, 20) : [],
      scope: b.scope === 'company' ? 'company' : 'project',
      sources: Array.isArray(b.sources) ? (b.sources as never[]).slice(0, 50) : [],
      mentionedIds: Array.isArray(b.mentionedIds) ? (b.mentionedIds as unknown[]).map(String) : [],
      remindAt: typeof b.remindAt === 'string' ? b.remindAt : null,
      sourceMessageIds: Array.isArray(b.sourceMessageIds)
        ? (b.sourceMessageIds as unknown[]).map(String).slice(0, 50)
        : [],
    },
    'bridge',
  )
  return c.json({ id: row.id, type: row.type, title: row.title, scope: row.scope }, 201)
})

bridgeRoute.patch('/notes/:id', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  // База знаний принадлежит КОМПАНИИ: доступ даёт членство в ней, а не права
  // в проекте. Знание про Cardcom нужно всем, кто с ним столкнётся.
  const kbCompany = await companyOf(scope.projectId)
  if (!kbCompany || !(await canUseKnowledge(kbCompany, auth(c as never).userId))) {
    return c.json({ error: 'You are not a member of this company' }, 403)
  }

  const existing = await db.query.notes.findFirst({
    where: and(eq(notes.id, c.req.param('id')), eq(notes.companyId, kbCompany), isNull(notes.deletedAt)),
  })
  if (!existing) return c.json({ error: 'Note not found' }, 404)
  // Своё правит автор, чужое — админ компании. Роль в ПРОЕКТЕ здесь не
  // подходит: у записи общего правила проекта нет вовсе, и спрашивать роль в
  // нём было бы не у чего.
  if (!(await canEditKnowledge(kbCompany, id.userId, existing.authorId))) {
    return c.json({ error: 'Forbidden: you can only edit entries you wrote' }, 403)
  }

  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const patch: Partial<typeof notes.$inferInsert> = { updatedAt: new Date() }
  if (typeof b.type === 'string') {
    if (!(NOTE_TYPES as readonly string[]).includes(b.type)) {
      return c.json({ error: `type must be one of: ${NOTE_TYPES.join(', ')}` }, 400)
    }
    patch.type = b.type
  }
  if (typeof b.title === 'string') patch.title = b.title.slice(0, 300)
  if (typeof b.body === 'string') patch.body = richText(b.body)
  if (Array.isArray(b.tags)) patch.tags = JSON.stringify((b.tags as unknown[]).map((t) => String(t).toLowerCase()))
  if (b.scope === 'company' || b.scope === 'project') patch.scope = b.scope
  if (typeof b.remindAt === 'string' || b.remindAt === null) {
    patch.remindAt = b.remindAt ? new Date(b.remindAt as string) : null
    patch.remindedAt = null
  }
  // дописать цитаты, не потеряв уже сохранённые
  if (Array.isArray(b.sourceMessageIds) && b.sourceMessageIds.length) {
    const ids = (b.sourceMessageIds as unknown[]).map(String)
    const rows = await db
      .select({ m: messages, u: users })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.authorId))
      .where(and(eq(messages.projectId, scope.projectId), inArray(messages.id, ids)))
    const byId = new Map(rows.map((r) => [r.m.id, r]))
    const added = ids
      .map((mid) => byId.get(mid))
      .filter(Boolean)
      .map((r) => ({
        messageId: r!.m.id,
        text: r!.m.text,
        authorName: r!.u?.name ?? 'AI',
        sentAt: r!.m.createdAt.toISOString(),
      }))
    patch.sources = JSON.stringify([...(JSON.parse(existing.sources) as unknown[]), ...added])
  }

  const [row] = await db.update(notes).set(patch).where(eq(notes.id, existing.id)).returning()
  // Поиск по смыслу: пересчёт фоном. Правка через мост — такая же правка.
  void enqueueEmbedding('note', row!.id, scope.projectId)
  void logActivity({
    projectId: scope.projectId,
    actorId: id.userId,
    action: 'update',
    entityType: 'note',
    entityId: row!.id,
    entityLabel: row!.title,
  })
  broadcast(scope.projectId, 'notes', { action: 'update', id: row!.id })
  return c.json({ id: row!.id, title: row!.title, type: row!.type })
})

bridgeRoute.post('/notes/:id/task', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  // Читать запись — по членству в компании; создавать задачу — по правам
  // ПРОЕКТА: задача рождается в проекте, и это его правила.
  const kbCompany = await companyOf(scope.projectId)
  if (!kbCompany || !(await canUseKnowledge(kbCompany, id.userId))) {
    return c.json({ error: 'You are not a member of this company' }, 403)
  }
  const denied = await require(c as never, 'tasks.create', scope.projectId)
  if (denied) return c.json(denied, 403)

  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const res = await noteToTask(scope.projectId, id.userId, c.req.param('id'), {
    title: typeof b.title === 'string' ? b.title : undefined,
    assigneeId: typeof b.assigneeId === 'string' ? b.assigneeId : null,
    priority: typeof b.priority === 'string' ? b.priority : undefined,
    // noteToTask принимает строку, parseDue отдаёт Date — приводим здесь, а не
    // расширяем чужую сигнатуру ради одного вызова.
    dueDate: parseDue(b.dueDate)?.toISOString() ?? null,
  })
  if ('error' in res) return c.json({ error: res.error }, res.status)
  return c.json({ id: res.task.id, number: res.task.number, title: res.task.title, alreadyExisted: res.already })
})

bridgeRoute.delete('/notes/:id', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const kbCompany = await companyOf(scope.projectId)
  if (!kbCompany) return c.json({ error: 'You are not a member of this company' }, 403)
  const existing = await db.query.notes.findFirst({
    where: and(eq(notes.id, c.req.param('id')), eq(notes.companyId, kbCompany), isNull(notes.deletedAt)),
  })
  if (!existing) return c.json({ error: 'Note not found' }, 404)

  // Своё убирает автор, чужое — админ компании: стереть чужое знание
  // необратимо, и решение это не рядовое.
  if (!(await canEditKnowledge(kbCompany, id.userId, existing.authorId))) {
    return c.json({ error: 'Forbidden: only the author or a company admin can delete an entry' }, 403)
  }
  await db.update(notes).set({ deletedAt: new Date(), deletedById: id.userId }).where(eq(notes.id, existing.id))
  void logActivity({
    projectId: scope.projectId,
    actorId: id.userId,
    action: 'delete',
    entityType: 'note',
    entityId: existing.id,
    entityLabel: existing.title,
  })
  broadcast(scope.projectId, 'notes', { action: 'delete', id: existing.id })
  return c.json({ ok: true })
})

// --- Документы --------------------------------------------------------------

bridgeRoute.get('/documents', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'documents.read', scope.projectId)
  if (denied) return c.json(denied, 403)
  const q = c.req.query('q')?.trim()
  const base = and(eq(documents.projectId, scope.projectId), isNull(documents.deletedAt))
  const rows = await db.query.documents.findMany({
    // Ищем и по содержимому, а не только по заголовку: «в каком документе
    // вообще про это написано» — самый частый вопрос, а угадать заголовок
    // по памяти получается редко.
    where: q ? and(base, or(ilike(documents.title, `%${q}%`), ilike(documents.content, `%${q}%`))) : base,
    orderBy: desc(documents.updatedAt),
    limit: 100,
  })
  return c.json({
    items: rows.map((d) => {
      const text = htmlToText(d.content)
      // При поиске показываем НАЙДЕННОЕ место, а не первые 160 символов:
      // начало документа обычно одинаковое у всех и ничего не говорит о том,
      // почему он попал в выдачу.
      const hit = q ? searchInText(text, q, 120).matches[0] : null
      return {
        id: d.id,
        title: d.title || '—',
        chars: text.length,
        preview: hit ? hit.text : text.slice(0, 160),
        // Совпадение в тексте или только в заголовке — разные вещи: во втором
        // случае открывать документ, может, и незачем.
        ...(q ? { matchedIn: hit ? 'content' : 'title' } : {}),
        updatedAt: d.updatedAt,
      }
    }),
  })
})

bridgeRoute.get('/documents/:id', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'documents.read', scope.projectId)
  if (denied) return c.json(denied, 403)
  const d = await db.query.documents.findFirst({
    where: and(eq(documents.id, c.req.param('id')), eq(documents.projectId, scope.projectId), isNull(documents.deletedAt)),
  })
  if (!d) return c.json({ error: 'Not found' }, 404)

  // Поиск ВНУТРИ документа: отвечает на «где здесь про авторизацию», тогда
  // как offset отвечает лишь на «дай кусок номер N». Спецификация в 32 тысячи
  // символов — это восемь чтений подряд ради одного абзаца.
  //
  // Идёт до чтения кусками и заменяет его: содержимое целиком тут не нужно,
  // нужны совпадения. offset у них тот же, что у обычного чтения текстом, —
  // дочитать вокруг найденного можно сразу.
  const q = c.req.query('q')?.trim()
  if (q) {
    const found = searchInDocument(d.content, q, Number(c.req.query('context')) || DEFAULT_CONTEXT)
    return c.json({
      id: d.id,
      title: d.title,
      query: q,
      totalChars: found.total,
      matches: found.matches,
      // Совпадений больше потолка — молча показанные двадцать из сорока
      // читаются как «больше нигде не упоминается».
      truncated: found.truncated,
      hint: found.matches.length
        ? 'Read around a match with ?offset=<its offset> (text format).'
        : 'Nothing found. Try a shorter query — the search is literal, not fuzzy.',
    })
  }

  const asHtml = c.req.query('format') === 'html'
  const body = asHtml ? d.content : htmlToText(d.content)
  const offset = Math.max(0, Number(c.req.query('offset')) || 0)
  const limit = Math.min(20000, Math.max(200, Number(c.req.query('limit')) || 4000))
  const chunk = body.slice(offset, offset + limit)
  const end = offset + chunk.length
  return c.json({
    id: d.id,
    title: d.title,
    // Картинки, вшитые в документ: как и в задачах, полем они ни с чем не
    // связаны, и без этого списка ассистент их не найдёт.
    attachments: await inlineAttachments(d.content, scope.projectId),
    format: asHtml ? 'html' : 'text',
    totalChars: body.length,
    offset,
    returned: chunk.length,
    hasMore: end < body.length,
    nextOffset: end < body.length ? end : null,
    content: chunk,
  })
})

bridgeRoute.post('/documents', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'documents.write', scope.projectId)
  if (denied) return c.json(denied, 403)
  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const title = typeof b.title === 'string' ? b.title.trim() : ''
  if (!title) return c.json({ error: 'title is required' }, 400)
  const [row] = await db
    .insert(documents)
    .values({
      projectId: scope.projectId,
      title: title.slice(0, 300),
      content: typeof b.content === 'string' ? richText(b.content).slice(0, 500_000) : '',
      createdById: id.userId,
      updatedById: id.userId,
    })
    .returning()
  void logActivity({
    projectId: scope.projectId,
    actorId: id.userId,
    action: 'create',
    entityType: 'document',
    entityId: row!.id,
    entityLabel: row!.title,
  })
  broadcast(scope.projectId, 'documents_changed', {})
  return c.json({ id: row!.id, title: row!.title, totalChars: row!.content.length }, 201)
})

bridgeRoute.patch('/documents/:id', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'documents.write', scope.projectId)
  if (denied) return c.json(denied, 403)
  const docId = c.req.param('id')
  const d = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.projectId, scope.projectId), isNull(documents.deletedAt)),
  })
  if (!d) return c.json({ error: 'Not found' }, 404)

  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const patch: Record<string, unknown> = { updatedById: id.userId }
  if (typeof b.title === 'string') patch.title = b.title.slice(0, 300)
  if (typeof b.content === 'string') patch.content = richText(b.content).slice(0, 500_000)
  if (Object.keys(patch).length === 1) return c.json({ error: 'Nothing to update' }, 400)

  // версия перед перезаписью — правка ИИ должна быть обратима
  const { snapshot } = await import('./documents.js')
  await snapshot(docId, d.title, d.content, id.userId, 'before AI bridge edit').catch(() => {})

  const [row] = await db.update(documents).set(patch).where(eq(documents.id, docId)).returning()
  void logActivity({
    projectId: scope.projectId,
    actorId: id.userId,
    action: 'update',
    entityType: 'document',
    entityId: docId,
    entityLabel: row!.title,
  })
  broadcast(scope.projectId, 'documents_changed', { id: docId })
  // totalChars, как и в /append: без него ответ «id + title» выглядит успехом
  // при любом исходе, и записался ли текст на самом деле, узнать нечем —
  // отдельным GET и то не сразу. Ассистент докладывает о сохранённом
  // документе, а там прежнее содержимое.
  return c.json({ id: row!.id, title: row!.title, totalChars: row!.content.length })
})

bridgeRoute.post('/documents/:id/append', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'documents.write', scope.projectId)
  if (denied) return c.json(denied, 403)
  const docId = c.req.param('id')
  const d = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.projectId, scope.projectId), isNull(documents.deletedAt)),
  })
  if (!d) return c.json({ error: 'Not found' }, 404)
  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const add = typeof b.content === 'string' ? richText(b.content) : ''
  if (!add) return c.json({ error: 'content is required' }, 400)

  const { snapshot } = await import('./documents.js')
  await snapshot(docId, d.title, d.content, id.userId, 'before AI bridge append').catch(() => {})
  const next = `${d.content}${add}`.slice(0, 500_000)
  await db.update(documents).set({ content: next, updatedById: id.userId }).where(eq(documents.id, docId))
  broadcast(scope.projectId, 'documents_changed', { id: docId })
  return c.json({ ok: true, totalChars: next.length })
})

// --- версии документа --------------------------------------------------------
//
// Каждая правка документа снимает снимок предыдущего состояния — и мост эти
// снимки создавал, но не показывал. Ассистент, переписавший документ не так,
// откатить его не мог: оставалось звать человека в приложение. При том что
// именно ассистент переписывает документы чаще всех.

bridgeRoute.get('/documents/:id/versions', async (c) => {
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'documents.read', scope.projectId)
  if (denied) return c.json(denied, 403)

  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, c.req.param('id')), eq(documents.projectId, scope.projectId), isNull(documents.deletedAt)),
  })
  if (!doc) return c.json({ error: 'Not found' }, 404)

  const rows = await db
    .select({ v: documentVersions, u: users })
    .from(documentVersions)
    .leftJoin(users, eq(users.id, documentVersions.authorId))
    .where(eq(documentVersions.documentId, doc.id))
    .orderBy(desc(documentVersions.version))
    .limit(50)

  return c.json({
    items: rows.map((r) => ({
      id: r.v.id,
      version: r.v.version,
      title: r.v.title,
      note: r.v.note || undefined,
      author: r.u?.name ?? null,
      chars: r.v.content.length,
      createdAt: r.v.createdAt,
    })),
    hint: 'Read one with ?version=<id> on GET /x/documents/<id>, restore with POST /x/documents/<id>/versions/<versionId>/restore.',
  })
})

bridgeRoute.post('/documents/:id/versions/:versionId/restore', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'documents.write', scope.projectId)
  if (denied) return c.json(denied, 403)

  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, c.req.param('id')), eq(documents.projectId, scope.projectId), isNull(documents.deletedAt)),
  })
  if (!doc) return c.json({ error: 'Not found' }, 404)
  const v = await db.query.documentVersions.findFirst({
    where: and(eq(documentVersions.id, c.req.param('versionId')), eq(documentVersions.documentId, doc.id)),
  })
  if (!v) return c.json({ error: 'No such version of this document' }, 404)

  // Текущее состояние тоже в историю: откат должен быть обратим.
  const { snapshot } = await import('./documents.js')
  await snapshot(doc.id, doc.title, doc.content, id.userId, `before restore to v${v.version}`).catch(() => {})
  const [row] = await db
    .update(documents)
    .set({ title: v.title, content: v.content, updatedById: id.userId })
    .where(eq(documents.id, doc.id))
    .returning()
  void logActivity({
    projectId: scope.projectId,
    actorId: id.userId,
    action: 'update',
    entityType: 'document',
    entityId: doc.id,
    entityLabel: `${row!.title || '—'} → v${v.version}`,
  })
  broadcast(scope.projectId, 'documents_changed', { id: doc.id })
  return c.json({ ok: true, id: row!.id, title: row!.title, restoredVersion: v.version, chars: row!.content.length })
})

bridgeRoute.delete('/documents/:id', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'documents.delete', scope.projectId)
  if (denied) return c.json(denied, 403)
  const docId = c.req.param('id')
  const d = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.projectId, scope.projectId), isNull(documents.deletedAt)),
  })
  if (!d) return c.json({ error: 'Not found' }, 404)
  await db.update(documents).set({ deletedAt: new Date(), deletedById: id.userId }).where(eq(documents.id, docId))
  void logActivity({
    projectId: scope.projectId,
    actorId: id.userId,
    action: 'delete',
    entityType: 'document',
    entityId: docId,
    entityLabel: d.title,
  })
  broadcast(scope.projectId, 'documents_changed', {})
  return c.json({ ok: true, restorableForDays: 7 })
})

// --- Чат --------------------------------------------------------------------

bridgeRoute.get('/messages', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50))
  const before = c.req.query('before')
  const conds = [eq(messages.projectId, scope.projectId), eq(messages.mode, 'group' as const), visibleInChat(id.userId)]
  if (before && !isNaN(Date.parse(before))) conds.push(lt(messages.createdAt, new Date(before)))
  const rows = await db
    .select({ m: messages, u: users })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorId))
    .where(and(...conds))
    .orderBy(desc(messages.createdAt))
    .limit(limit)
  // Вложения сообщений: скриншот бага, присланный в чат, ассистент раньше
  // просто не видел — в ответе был только текст.
  const ordered = rows.reverse()
  const byMessage = await attachmentsFor(
    files.messageId,
    ordered.map((r) => r.m.id),
    scope.projectId,
    new Map(ordered.map((r) => [r.m.id, r.m.text])),
  )
  return c.json({
    items: ordered.map((r) => ({
      id: r.m.id,
      text: r.m.text,
      author: r.u ? { id: r.u.id, name: r.u.name } : { id: 'ai', name: 'AI' },
      // Без этого ветка не видна: ответить мост умеет, а понять, кому
      // отвечали до него, — нет.
      replyTo: r.m.replyToId || undefined,
      attachments: byMessage.get(r.m.id) ?? [],
      createdAt: r.m.createdAt,
    })),
  })
})

// --- сжатая история чата ----------------------------------------------------
//
// Переписка живёт вечно и целиком, но читать её подряд бессмысленно: тысячи
// строк не влезут в контекст, а нужное в них не найти. Поэтому дни свёрнуты
// в саммари, и ассистент идёт по ним сверху вниз: список → нужный период →
// сырые сообщения этого периода.
//
// Связь через ДАТЫ, а не через список id: границы уже записаны в саммари,
// работают на всей старой истории и не ломаются, если сообщения дописали
// задним числом. Ничего при этом не удаляется — саммари лишь надстройка.

bridgeRoute.get('/chat/summaries', async (c) => {
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const q = c.req.query()
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 30))
  const conds = [eq(chatSummaries.projectId, scope.projectId)]
  if (q.q?.trim()) {
    conds.push(or(ilike(chatSummaries.name, `%${q.q.trim()}%`), ilike(chatSummaries.content, `%${q.q.trim()}%`))!)
  }
  if (q.from && !isNaN(Date.parse(q.from))) conds.push(gte(chatSummaries.toAt, new Date(q.from)))
  if (q.to && !isNaN(Date.parse(q.to))) conds.push(lte(chatSummaries.fromAt, new Date(q.to + 'T23:59:59')))

  const rows = await db
    .select()
    .from(chatSummaries)
    .where(and(...conds))
    .orderBy(desc(chatSummaries.toAt))
    .limit(limit)

  // full=1 — сразу с текстом: при поиске ассистенту нужен не список заголовков,
  // а понимание, тот ли это период.
  const full = q.full === '1' || q.full === 'true'
  return c.json({
    items: rows.map((s) => ({
      id: s.id,
      name: s.name,
      from: s.fromAt,
      to: s.toAt,
      messageCount: Number(s.messageCount),
      content: full ? s.content : s.content.slice(0, 300),
      // Готовый вызов за сырыми сообщениями этого периода: чтобы не собирать
      // его вручную и не промахнуться мимо границ.
      messagesUrl: `/x/chat/messages?from=${s.fromAt.toISOString()}&to=${s.toAt.toISOString()}`,
    })),
    count: rows.length,
  })
})

bridgeRoute.get('/chat/summaries/:id', async (c) => {
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const s = await db.query.chatSummaries.findFirst({
    where: and(eq(chatSummaries.id, c.req.param('id')), eq(chatSummaries.projectId, scope.projectId)),
  })
  if (!s) return c.json({ error: 'Summary not found' }, 404)
  return c.json({
    id: s.id,
    name: s.name,
    from: s.fromAt,
    to: s.toAt,
    messageCount: Number(s.messageCount),
    content: s.content,
    messagesUrl: `/x/chat/messages?from=${s.fromAt.toISOString()}&to=${s.toAt.toISOString()}`,
  })
})

// Сырые сообщения за период — то, ради чего и нужна выжимка: прочитал саммари,
// понял «это оно», забрал точные слова и процитировал.
bridgeRoute.get('/chat/messages', async (c) => {
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const q = c.req.query()
  const from = q.from && !isNaN(Date.parse(q.from)) ? new Date(q.from) : null
  const to = q.to && !isNaN(Date.parse(q.to)) ? new Date(q.to.length <= 10 ? q.to + 'T23:59:59' : q.to) : null
  // Слова достаточно без дат: «где мы обсуждали X» — обычный вопрос, а когда
  // это было, спрашивающий как раз и не знает. Раньше поиск требовал period,
  // и ассистенту приходилось идти через саммари даже за одним словом.
  if (!from && !to && !q.q?.trim())
    return c.json({ error: 'Pass q (word to find) and/or from/to (ISO dates). Get dates from /x/chat/summaries.' }, 400)

  const limit = Math.min(500, Math.max(1, Number(q.limit) || 200))
  const conds = [
    eq(messages.projectId, scope.projectId),
    eq(messages.mode, 'group' as const),
    eq(messages.status, 'delivered' as const),
  ]
  if (from) conds.push(gte(messages.createdAt, from))
  if (to) conds.push(lte(messages.createdAt, to))
  if (q.q?.trim()) conds.push(ilike(messages.text, `%${q.q.trim()}%`))

  // Период читают сверху вниз — по возрастанию. Но поиск без периода идёт по
  // всей истории, и первые 200 совпадений оказались бы самыми древними: на
  // вопрос «где мы это обсуждали» ответом стал бы позапрошлый год. Поэтому
  // берём свежие, а отдаём всё равно по возрастанию.
  const newestFirst = !from && !to
  const rows = await db
    .select({ m: messages, u: users })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorId))
    .where(and(...conds))
    .orderBy(newestFirst ? desc(messages.createdAt) : asc(messages.createdAt))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const items = rows.slice(0, limit)
  if (newestFirst) items.reverse()
  return c.json({
    items: items.map((r) => ({
      id: r.m.id,
      text: r.m.text,
      author: r.u ? r.u.name || r.u.email : 'AI',
      replyTo: r.m.replyToId || undefined,
      at: r.m.createdAt,
    })),
    count: items.length,
    // Молча обрезать нельзя: ассистент решит, что прочитал весь период.
    hasMore,
    ...(hasMore
      ? {
          hint: newestFirst
            ? 'Truncated — these are the most recent matches. Add from/to to search an older period, or raise limit (max 500).'
            : 'Truncated. Narrow the range or raise limit (max 500).',
        }
      : {}),
  })
})

bridgeRoute.post('/messages', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const text = typeof b.text === 'string' ? b.text.trim() : ''
  // вложения: как в задачах — сначала POST /x/files, потом их id сюда
  const attachmentIds = Array.isArray(b.attachmentIds)
    ? (b.attachmentIds as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 10)
    : []
  // ответ на конкретное сообщение — так видно, на какую просьбу это реакция
  const replyToId = typeof b.replyToId === 'string' ? b.replyToId : null
  if (!text && !attachmentIds.length) {
    return c.json({ error: 'text or attachmentIds is required' }, 400)
  }
  // Раньше длинный текст молча резался до 4000 знаков: ассистент отправлял
  // разбор, получал 201 и был уверен, что команда прочла целиком. Лучше
  // отказать — и предел тот же, что у композера.
  if (text.length > 20_000) {
    return c.json({ error: `text is too long: ${text.length} characters, max 20000. Split it into several messages.` }, 400)
  }
  if (replyToId) {
    const parent = await db.query.messages.findFirst({
      where: and(eq(messages.id, replyToId), eq(messages.projectId, scope.projectId)),
    })
    if (!parent) return c.json({ error: 'replyToId: message not found in this project' }, 404)
    // Отвечать на чужой неподтверждённый черновик нельзя — его ещё нет в чате.
    if (parent.status !== 'delivered' && parent.authorId !== id.userId)
      return c.json({ error: 'replyToId: message not found in this project' }, 404)
  }

  const [row] = await db
    .insert(messages)
    .values({
      projectId: scope.projectId,
      authorId: id.userId,
      mode: 'group',
      status: 'delivered',
      rawSend: true, // минуя диспетчер: это уже осмысленное сообщение
      text: text || '📎',
      replyToId,
    })
    .returning()

  // Упоминание должно уведомлять одинаково, откуда бы сообщение ни пришло:
  // агент часто пишет человеку именно затем, чтобы тот увидел (SPEC §8.30).
  {
    const author = await db.query.users.findFirst({ where: eq(users.id, id.userId) })
    void notifyChatMentions(scope.projectId, row!.id, row!.text, author ?? null, row!.replyToId)
  }

  // Привязываем только свои файлы этого проекта и снимаем временный флаг —
  // файл становится постоянным, как и при отправке из композера (SPEC §8.17).
  let attachments: { id: string; name: string; mime: string; size: number }[] = []
  if (attachmentIds.length) {
    await db
      .update(files)
      .set({ messageId: row!.id, pendingUntil: null })
      .where(
        and(
          inArray(files.id, attachmentIds),
          eq(files.projectId, scope.projectId),
          eq(files.uploadedById, id.userId),
        ),
      )
    const rows = await db.select().from(files).where(eq(files.messageId, row!.id))
    attachments = rows.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: Number(f.size) }))
  }

  broadcast(scope.projectId, 'message', {
    id: row!.id,
    mode: 'group',
    status: 'delivered',
    text: row!.text,
    replyToId,
    createdAt: row!.createdAt,
    attachments,
    authorId: id.userId,
    author: { id: id.user.id, name: id.user.name, avatarUrl: null },
  })
  return c.json({ id: row!.id, attachments }, 201)
})

/**
 * Удалить сообщение из общего чата: своё — автор, любое — админ.
 *
 * Правило и последствия те же, что в интерфейсе: сообщение исчезает у всех
 * насовсем, корзины для него нет. Файлы при этом остаются в проекте —
 * отвязываем их от сообщения, а не стираем: вложение часто нужнее реплики,
 * с которой его прислали.
 *
 * Правки сообщений нет и здесь — её нет нигде: ни в интерфейсе, ни в REST,
 * ни в схеме (отметки «изменено» у сообщения не существует). Мост не может
 * дать то, чего в продукте нет; молча переписать чужую реплику задним числом
 * он тем более не должен.
 */
bridgeRoute.delete('/messages/:id', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const messageId = c.req.param('id')
  const msg = await db.query.messages.findFirst({
    // Только общий чат: личный диалог с ассистентом чистится своей ручкой, а
    // чужую переписку мост не трогает вовсе.
    where: and(eq(messages.id, messageId), eq(messages.projectId, scope.projectId), eq(messages.mode, 'group')),
  })
  if (!msg) return c.json({ error: 'Not found' }, 404)

  if (!(await ownerOrAdmin(scope.projectId, id.userId, msg.authorId))) {
    return c.json({ error: 'Forbidden: you can delete only your own messages unless you are an admin' }, 403)
  }

  await db.update(files).set({ messageId: null }).where(eq(files.messageId, msg.id))
  await db.delete(messages).where(eq(messages.id, msg.id))
  broadcast(scope.projectId, 'message_deleted', { messageId })
  return c.json({ ok: true })
})

// --- Ресурсы (только метаданные: значения секретов через мост не отдаём) -----

bridgeRoute.get('/resources', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'resources.read', scope.projectId)
  if (denied) return c.json(denied, 403)
  const rows = await db.query.credentials.findMany({
    where: and(eq(credentials.projectId, scope.projectId), isNull(credentials.deletedAt)),
  })
  // Открыты ли мне секреты каждого ресурса — одним запросом на весь список,
  // а не по одному на строку.
  const ids = rows.map((r: typeof credentials.$inferSelect) => r.id)
  const shared = new Set(
    ids.length
      ? (
          await db
            .select({ resourceId: resourceViewers.resourceId })
            .from(resourceViewers)
            .where(and(inArray(resourceViewers.resourceId, ids), eq(resourceViewers.userId, id.userId)))
        ).map((r) => r.resourceId)
      : [],
  )

  return c.json({
    items: rows.map((r: typeof credentials.$inferSelect) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      description: r.description,
      // Секреты под ресурсом открыты не всем: автору — всегда, остальным — по
      // списку. Ассистент должен видеть это ДО того, как пообещает человеку
      // доступ, которого у того нет.
      canSeeSecrets: r.createdById === id.userId || shared.has(r.id),
    })),
    note: 'Secret values are read one at a time and only by people the resource is shared with.',
  })
})

const RESOURCE_FIELDS = ['name', 'url', 'description', 'secrets', 'viewers', 'project'] as const

/**
 * Значок сайта — фоном, как и в интерфейсе: чужая сеть может думать
 * секундами, а ответ ассистенту ждать этого не должен.
 */
function grabIcon(resourceId: string, url: string) {
  void fetchSiteIcon(url)
    .then((icon) => (icon ? db.update(credentials).set({ icon }).where(eq(credentials.id, resourceId)) : null))
    .catch(() => {})
}

/**
 * Завести ресурс.
 *
 * Ссылки на макеты, панели и репозитории всплывают в разговоре постоянно, и
 * без этой ручки ассистент клал их в заметки — то есть в другое место, где их
 * потом никто не искал. Секреты сюда не принимаем намеренно: значение прошло
 * бы через внешнюю модель и осело в её истории. Их по-прежнему заводит человек
 * руками — мост даже на чтение их не отдаёт.
 */
bridgeRoute.post('/resources', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'resources.manage', scope.projectId)
  if (denied) return c.json(denied, 403)

  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const bad = unknownFields(b, RESOURCE_FIELDS)
  if (bad) return c.json({ error: bad }, 400)

  const link = typeof b.url === 'string' && b.url.trim() ? b.url.trim().slice(0, 2000) : null
  // Имя из домена, если своего не дали: «figma.com/board» понятнее пустой
  // строки, а придумывать название ради галочки никто не станет.
  const name = (typeof b.name === 'string' ? b.name.trim().slice(0, 200) : '') || (link ? nameFromUrl(link) : '')
  if (!name && !link) return c.json({ error: 'Provide a link or a name' }, 400)

  const [row] = await db
    .insert(credentials)
    .values({
      projectId: scope.projectId,
      name,
      url: link,
      description: typeof b.description === 'string' ? b.description.slice(0, 5000) : '',
      source: 'chat',
      createdById: id.userId,
    })
    .returning()

  // Секреты под ресурсом. Значения шифруются тем же ключом, что и введённые
  // человеком, — хранилище одно, разницы между источниками нет.
  const incoming = Array.isArray(b.secrets) ? (b.secrets as unknown[]).slice(0, 20) : []
  const secrets = incoming
    .map((x) => (x as { label?: unknown; value?: unknown }))
    .filter((x) => typeof x.value === 'string' && (x.value as string).length)
    .map((x) => ({
      resourceId: row!.id,
      label: typeof x.label === 'string' ? x.label.slice(0, 120) : '',
      valueEncrypted: encrypt((x.value as string).slice(0, 10_000)),
    }))
  if (secrets.length) await db.insert(resourceSecrets).values(secrets)

  /**
   * Кто видит секреты. Через мост — НИКТО, кроме автора, пока ассистент не
   * назовёт людей явно.
   *
   * Умолчание здесь обратное интерфейсу намеренно: человек в приложении видит
   * форму с тегами команды и снимает лишних глазами, а ассистент отдаёт запрос
   * вслепую. Тихо раздать пароль всему проекту, потому что поле забыли, —
   * ровно та ошибка, которую нельзя отменить.
   */
  const viewers = Array.isArray(b.viewers)
    ? (b.viewers as unknown[]).filter((x): x is string => typeof x === 'string' && x !== id.userId).slice(0, 200)
    : []
  if (viewers.length) {
    // Только участники этого проекта: чужой id доступа не даёт.
    const inProject = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, scope.projectId), inArray(projectMembers.userId, viewers)))
    if (inProject.length) {
      await db
        .insert(resourceViewers)
        .values(inProject.map((m) => ({ resourceId: row!.id, userId: m.userId })))
        .onConflictDoNothing()
    }
  }

  if (link) grabIcon(row!.id, link)
  await db.insert(credentialAccessLog).values({
    projectId: scope.projectId,
    userId: id.userId,
    action: 'create',
    credentialId: row!.id,
    credentialName: name,
  })
  return c.json(
    {
      id: row!.id,
      name: row!.name,
      url: row!.url,
      secrets: secrets.length,
      // Возвращаем список явно: ассистент должен видеть, что доступ узкий, и
      // сказать об этом человеку, а не решить, что «сохранил — значит доступно».
      viewers: await db
        .select({ userId: resourceViewers.userId })
        .from(resourceViewers)
        .where(eq(resourceViewers.resourceId, row!.id))
        .then((rows) => rows.map((r) => r.userId)),
    },
    201,
  )
})

bridgeRoute.patch('/resources/:id', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'resources.manage', scope.projectId)
  if (denied) return c.json(denied, 403)

  const existing = await db.query.credentials.findFirst({
    where: and(eq(credentials.id, c.req.param('id')), eq(credentials.projectId, scope.projectId), isNull(credentials.deletedAt)),
  })
  if (!existing) return c.json({ error: 'Resource not found' }, 404)

  const parsed_b = await readJson(c as never)
  if ('error' in parsed_b) return c.json(parsed_b, 400)
  const b = parsed_b.body as Record<string, unknown>
  const bad = unknownFields(b, RESOURCE_FIELDS)
  if (bad) return c.json({ error: bad }, 400)

  /**
   * Список зрителей меняет только автор — тот, кто эти секреты положил.
   *
   * Права resources.manage тут мало: администратор ведает ресурсами проекта,
   * но раздавать чужой пароль от имени владельца он не должен. Правило то же,
   * что и в приложении, и держится оно здесь отдельно: мост и REST — разные
   * двери к одной комнате.
   */
  if (b.viewers !== undefined) {
    if (existing.createdById !== id.userId) {
      return c.json({ error: 'Only the person who created the resource can change who sees its secrets' }, 403)
    }
    const wanted = Array.isArray(b.viewers)
      ? (b.viewers as unknown[]).filter((x): x is string => typeof x === 'string' && x !== id.userId).slice(0, 200)
      : []
    // Только участники этого проекта: чужой id доступа не даёт.
    const inProject = wanted.length
      ? await db
          .select({ userId: projectMembers.userId })
          .from(projectMembers)
          .where(and(eq(projectMembers.projectId, scope.projectId), inArray(projectMembers.userId, wanted)))
      : []
    await db.delete(resourceViewers).where(eq(resourceViewers.resourceId, existing.id))
    if (inProject.length) {
      await db
        .insert(resourceViewers)
        .values(inProject.map((m) => ({ resourceId: existing.id, userId: m.userId })))
        .onConflictDoNothing()
    }
  }

  // Новые секреты ДОБАВЛЯЮТСЯ, а не заменяют прежние: PATCH со списком легко
  // отправить неполным, и тихо стереть чужой ключ — не та цена за опечатку.
  // Удаление отдельной ручкой, осознанным действием.
  const incoming = Array.isArray(b.secrets) ? (b.secrets as unknown[]).slice(0, 20) : []
  const newSecrets = incoming
    .map((x) => x as { label?: unknown; value?: unknown })
    .filter((x) => typeof x.value === 'string' && (x.value as string).length)
    .map((x) => ({
      resourceId: existing.id,
      label: typeof x.label === 'string' ? x.label.slice(0, 120) : '',
      valueEncrypted: encrypt((x.value as string).slice(0, 10_000)),
    }))
  if (newSecrets.length) await db.insert(resourceSecrets).values(newSecrets)

  const patch: Partial<typeof credentials.$inferInsert> = {}
  const link = b.url === undefined ? existing.url : typeof b.url === 'string' && b.url.trim() ? b.url.trim().slice(0, 2000) : null
  if (typeof b.name === 'string') patch.name = b.name.trim().slice(0, 200)
  if (b.url !== undefined) patch.url = link
  if (typeof b.description === 'string') patch.description = b.description.slice(0, 5000)
  // Правка одних зрителей или добавление секрета — тоже изменение: без этой
  // оговорки запрос «дай Талю доступ» падал бы с «Nothing to change».
  if (!Object.keys(patch).length && b.viewers === undefined && !newSecrets.length) {
    return c.json({ error: `Nothing to change. Allowed: ${RESOURCE_FIELDS.join(', ')}.` }, 400)
  }

  // Имя стёрли или его и не было — берём из ссылки.
  const nextName = patch.name ?? existing.name
  if (!nextName && link) patch.name = nameFromUrl(link)
  if (!(patch.name ?? existing.name) && !link) return c.json({ error: 'Provide a link or a name' }, 400)

  // Ссылка сменилась — прежний значок теперь не про этот ресурс.
  if (b.url !== undefined && link !== existing.url) {
    patch.icon = null
    if (link) grabIcon(existing.id, link)
  }

  // Пустой set() — ошибка драйвера, а не безобидный no-op: запрос «дай Талю
  // доступ» не меняет полей самого ресурса, и обновлять там нечего.
  if (Object.keys(patch).length) {
    await db.update(credentials).set(patch).where(eq(credentials.id, existing.id))
  }
  await db.insert(credentialAccessLog).values({
    projectId: scope.projectId,
    userId: id.userId,
    action: 'update',
    credentialId: existing.id,
    credentialName: patch.name ?? existing.name,
  })
  return c.json({
    ok: true,
    id: existing.id,
    ...(newSecrets.length ? { secretsAdded: newSecrets.length } : {}),
    // Возвращаем список всегда: ассистент должен видеть, кому открыт доступ,
    // и сказать это человеку, а не решить, что «сохранил — значит доступно».
    viewers: await db
      .select({ userId: resourceViewers.userId })
      .from(resourceViewers)
      .where(eq(resourceViewers.resourceId, existing.id))
      .then((rows) => rows.map((r) => r.userId)),
  })
})

/**
 * Убрать один секрет из ресурса.
 *
 * PATCH секреты только ДОБАВЛЯЕТ — чтобы неполный список не стёр чужой ключ.
 * Из-за этого ассистент, ошибившийся меткой или значением, не мог исправить
 * собственную ошибку: добавить второй умел, убрать первый — нет. Ресурс
 * обрастал мусором, а человеку оставалось чистить руками.
 *
 * Удаляется ровно один названный секрет: ни списком, ни «всё сразу». Сам
 * ресурс остаётся — его удаление по-прежнему решение человека.
 */
bridgeRoute.delete('/resources/:id/secrets/:secretId', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'resources.manage', scope.projectId)
  if (denied) return c.json(denied, 403)

  const existing = await db.query.credentials.findFirst({
    where: and(eq(credentials.id, c.req.param('id')), eq(credentials.projectId, scope.projectId), isNull(credentials.deletedAt)),
  })
  if (!existing) return c.json({ error: 'Resource not found' }, 404)

  const secretId = c.req.param('secretId')
  const secret = await db.query.resourceSecrets.findFirst({
    where: and(eq(resourceSecrets.id, secretId), eq(resourceSecrets.resourceId, existing.id)),
    columns: { id: true, label: true },
  })
  if (!secret) return c.json({ error: 'Secret not found on this resource' }, 404)

  await db.delete(resourceSecrets).where(eq(resourceSecrets.id, secret.id))
  await db.insert(credentialAccessLog).values({
    projectId: scope.projectId,
    userId: id.userId,
    action: 'update',
    credentialId: existing.id,
    credentialName: existing.name,
  })
  return c.json({ ok: true, removed: { id: secret.id, label: secret.label } })
})

// --- Файлы ------------------------------------------------------------------

bridgeRoute.get('/files', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'files.read', scope.projectId)
  if (denied) return c.json(denied, 403)
  const conds = [eq(files.projectId, scope.projectId), isNull(files.deletedAt), isNull(files.pendingUntil)]
  const taskId = c.req.query('taskId')
  if (taskId) conds.push(eq(files.taskId, taskId))
  const q = c.req.query('q')?.trim()
  if (q) conds.push(ilike(files.name, `%${q}%`))
  const type = c.req.query('type')
  if (type === 'image') conds.push(ilike(files.mime, 'image/%'))

  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50))
  const rows = await db
    .select()
    .from(files)
    .where(and(...conds))
    .orderBy(desc(files.createdAt))
    .limit(limit)
  // Через ту же fileView, что и вложения: два ручных описания одного ответа
  // разошлись — ext добавили в одно место и забыли про другое.
  return c.json({
    items: rows.map((f) => ({ ...fileView(f), taskId: f.taskId, createdAt: f.createdAt })),
  })
})

// Загрузка и отдача файлов проксируются на основной files-роут: там уже есть
// оптимизация картинок, лимиты хранилища и выбор S3/R2 проекта. Дублировать
// эту логику в мосте — гарантированный рассинхрон.
bridgeRoute.post('/files', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'files.upload', scope.projectId)
  if (denied) return c.json(denied, 403)

  const { filesRoute } = await import('./files.js')
  const { signProjectToken } = await import('../auth.js')
  const token = await signProjectToken({
    sub: id.userId,
    email: id.user.email,
    projectId: scope.projectId,
    role: 'member',
  })

  const form = await c.req.formData()
  // Несколько file= в одном запросе — обычное дело: четыре скриншота одним
  // вызовом. Раньше бралось только поле 'file' целиком, то есть ПОСЛЕДНЕЕ
  // значение, и три файла терялись молча — с ответом 201 и без предупреждения.
  // Теперь каждый уходит своим подзапросом, и в ответе видно судьбу каждого.
  const parts = form.getAll('file').filter((f) => typeof f !== 'string')
  if (!parts.length) return c.json({ error: 'file field is required' }, 400)

  const upload = async (file: (typeof parts)[number]) => {
    const one = new FormData()
    // Остальные поля (taskId, keepOriginal) повторяем для каждого файла.
    for (const [k, v] of form.entries()) if (k !== 'file') one.append(k, v)
    one.set('file', file)
    // manager=1 — файл сразу постоянный, не временный
    if (!one.get('taskId')) one.set('manager', '1')

    const res = await filesRoute.request('/', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: one,
    })
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.ok && payload.id) {
      void logActivity({
        projectId: scope.projectId,
        actorId: id.userId,
        action: 'create',
        entityType: 'file',
        entityId: String(payload.id),
        entityLabel: String(payload.name ?? ''),
      })
    }
    return { res, payload }
  }

  // Один файл — ответ ровно прежний: вызывающие разбирают объект, а не список.
  if (parts.length === 1) {
    const { res, payload } = await upload(parts[0]!)
    return c.json(payload, res.status as 200)
  }

  // Несколько — по очереди, чтобы не выбрать лимит хранилища параллельными
  // записями и чтобы отказ по одному файлу не ронял остальные.
  const items: Record<string, unknown>[] = []
  for (const file of parts) {
    const { res, payload } = await upload(file)
    items.push(res.ok ? payload : { name: file.name, error: payload.error ?? 'Upload failed', status: res.status })
  }
  const failed = items.filter((i) => i.error).length
  return c.json({
    items,
    uploaded: items.length - failed,
    failed,
    ...(failed ? { hint: 'Some files did not upload — see error on each item.' } : {}),
  })
})

bridgeRoute.get('/files/:id/content', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'files.read', scope.projectId)
  if (denied) return c.json(denied, 403)

  const file = await db.query.files.findFirst({
    where: and(eq(files.id, c.req.param('id')), eq(files.projectId, scope.projectId)),
  })
  if (!file || file.deletedAt) return c.json({ error: 'Not found' }, 404)

  const { resolveStorage, getObjectStream } = await import('../lib/s3.js')
  const { Readable } = await import('node:stream')
  try {
    const store = await resolveStorage(file.projectId)
    const { body, contentType, contentLength } = await getObjectStream(store, file.key)
    c.header('Content-Type', contentType || file.mime)
    c.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`)
    if (contentLength) c.header('Content-Length', String(contentLength))
    return c.body(Readable.toWeb(body) as ReadableStream)
  } catch (e) {
    console.error('[bridge] file read failed:', e)
    return c.json({ error: 'Read failed' }, 500)
  }
})

bridgeRoute.delete('/files/:id', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'files.delete', scope.projectId)
  if (denied) return c.json(denied, 403)
  const file = await db.query.files.findFirst({
    where: and(eq(files.id, c.req.param('id')), eq(files.projectId, scope.projectId)),
  })
  if (!file || file.deletedAt) return c.json({ error: 'Not found' }, 404)
  await db.update(files).set({ deletedAt: new Date(), deletedById: id.userId }).where(eq(files.id, file.id))
  void logActivity({
    projectId: scope.projectId,
    actorId: id.userId,
    action: 'delete',
    entityType: 'file',
    entityId: file.id,
    entityLabel: file.name,
  })
  return c.json({ ok: true, restorableForDays: 7 })
})

// Закрыть туннель может и сам ИИ — по завершении работы это правильный тон.
bridgeRoute.post('/disconnect', async (c) => {
  const id = auth(c as never)
  await closeSession(id.sessionId, id.userId)
  return c.json({ ok: true, message: 'Tunnel closed. The token is now dead.' })
})

export default bridgeRoute
