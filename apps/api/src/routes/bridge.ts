import { Hono } from 'hono'
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  companies,
  companyInvites,
  companyMembers,
  credentials,
  documents,
  files,
  messages,
  notes,
  notifications,
  projectMembers,
  projects,
  taskChecklist,
  taskComments,
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
import { authenticateBridge, closeSession, startDeviceAuth, pollDeviceAuth, type BridgeIdentity } from '../lib/bridge-auth.js'
import { connectDoc, guideDoc } from '../lib/bridge-docs.js'
import { logActivity } from '../lib/audit.js'
import { sendAddedToProjectMail } from '../lib/mails.js'
import { sendInviteMail } from '../lib/mail-invite.js'
import { createNote, noteToTask, NOTE_TYPES, type NoteType } from './notes.js'
import { readTimeConfig } from './time.js'
import { readPresence } from './auth.js'
import { createShare, revokeShare, type ShareEntityType } from './shares.js'
import { notifyChatMentions } from './messages.js'
import { htmlToText, sanitizeHtml } from '../lib/sanitize-html.js'
import { broadcast, sendToUserAnywhere, tasksChanged } from '../ws.js'
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
  return next()
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
  const rows = id.scopeAll
    ? (
        await db
          .select({ p: projects })
          .from(projectMembers)
          .innerJoin(projects, eq(projects.id, projectMembers.projectId))
          .where(eq(projectMembers.userId, id.userId))
      ).map((r) => r.p)
    : id.companyId
      ? await db.query.projects.findMany({ where: eq(projects.companyId, id.companyId) })
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

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
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

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
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

  // Публикуют наружу владелец и админ проекта — то же правило, что в интерфейсе.
  const member = await projectRoleOf(scope.projectId, id.userId)
  if (!(member?.role === 'owner' || member?.role === 'admin')) {
    return c.json({ error: 'Only project owners and admins can publish links' }, 403)
  }

  const share = await createShare(type as ShareEntityType, entityId, scope.projectId, id.userId)
  if (!share) return c.json({ error: 'Not found' }, 404)

  const app = APP()
  return c.json({
    // Ссылка для команды: откроется у того, кто в проекте. Публичная работает
    // без входа — её отдаём отдельно, чтобы ассистент не путал их местами.
    appUrl: `${app}/#${appPathOf(type, scope.projectId, entityId)}`,
    publicUrl: `${app}/#/s/${share.slug}`,
    slug: share.slug,
  })
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

/** Внутренний адрес сущности — тот же, что открывается в приложении. */
function appPathOf(type: string, projectId: string, id: string): string {
  if (type === 'message') return `/p/${projectId}/chat?msg=${id}`
  const tab = type === 'file' ? 'files' : type === 'note' ? 'notes' : type === 'resource' ? 'resources' : 'tasks'
  return `/p/${projectId}/${tab}/${id}`
}

// --- Контекст проекта -------------------------------------------------------

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

bridgeRoute.get('/inbox', async (c) => {
  const id = auth(c as never)
  const onlyUnread = c.req.query('unread') !== '0'
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 30))

  // company-туннель видит все проекты человека, проектный — только свой
  const conds = [eq(notifications.userId, id.userId)]
  if (id.projectId) conds.push(eq(notifications.projectId, id.projectId))
  if (onlyUnread) conds.push(isNull(notifications.readAt))

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
      // чего от человека хотят, словами ИИ — главное поле для агента
      whatIsAsked: r.n.summary,
      body: r.n.body,
      from: r.actor ? { id: r.actor.id, name: r.actor.name } : { id: 'ai', name: 'AI' },
      project: { id: r.project.id, name: r.project.name },
      // по этим полям агент дотягивается до сути: сообщение, задача, комментарий
      entityType: r.n.entityType,
      entityId: r.n.entityId,
      unread: !r.n.readAt,
      createdAt: r.n.createdAt,
    })),
    hint:
      'For entityType="message" call GET /x/messages/<entityId>/context to see the surrounding conversation, then reply with POST /x/messages (replyToId=<entityId>). Mark handled ones read with POST /x/inbox/read.',
  })
})

bridgeRoute.post('/inbox/read', async (c) => {
  const id = auth(c as never)
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const ids = Array.isArray(b.ids) ? (b.ids as unknown[]).map(String) : []
  const all = b.all === true

  if (!ids.length && !all) return c.json({ error: 'Pass ids[] or all=true' }, 400)
  const conds = [eq(notifications.userId, id.userId), isNull(notifications.readAt)]
  if (!all) conds.push(inArray(notifications.id, ids))
  if (id.projectId) conds.push(eq(notifications.projectId, id.projectId))

  await db.update(notifications).set({ readAt: new Date() }).where(and(...conds))
  sendToUserAnywhere(id.userId, 'notification', {})
  return c.json({ ok: true })
})

/** Окно переписки вокруг сообщения: без него агент не поймёт, о чём просят. */
bridgeRoute.get('/messages/:id/context', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const target = await db.query.messages.findFirst({
    where: and(eq(messages.id, c.req.param('id')), eq(messages.projectId, scope.projectId)),
  })
  if (!target) return c.json({ error: 'Message not found' }, 404)

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
function parseDue(value: unknown): Date | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string' || !value.trim()) return undefined
  const v = value.trim().toLowerCase()
  const day = 86400_000
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0)

  if (v === 'today') return startOfDay(new Date())
  if (v === 'tomorrow') return startOfDay(new Date(Date.now() + day))
  const inDays = v.match(/^in (\d+) days?$/)
  if (inDays) return startOfDay(new Date(Date.now() + Number(inDays[1]) * day))
  const weekday = v.match(/^next (monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/)
  if (weekday) {
    const target = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(weekday[1]!)
    const now = new Date()
    const delta = ((target - now.getDay() + 7) % 7) || 7
    return startOfDay(new Date(Date.now() + delta * day))
  }
  const parsed = Date.parse(value)
  return isNaN(parsed) ? undefined : new Date(parsed)
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
) => ({
  id: t.id,
  number: t.number,
  title: t.title,
  description: t.description,
  status: t.status,
  priority: t.priority,
  estimateMinutes: t.estimateMinutes ? Number(t.estimateMinutes) : null,
  dueDate: t.dueDate,
  sprintId: t.groupId,
  assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
  // Файлы, приложенные к задаче. Раньше их не было в ответе вовсе: ассистент
  // видел задачу, но не знал, что к ней приложен макет, и узнать это мог
  // только перебрав все файлы проекта.
  attachments: attachments ?? [],
  updatedAt: t.updatedAt,
})

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
    const list = status.split(',').filter(Boolean) as ('todo' | 'in_progress' | 'review' | 'done')[]
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

  const byTask = await attachmentsFor(
    files.taskId,
    rows.map((r) => r.t.id),
    scope.projectId,
    new Map(rows.map((r) => [r.t.id, r.t.description])),
  )
  return c.json({
    items: rows.map((r) => taskView(r.t, r.u, byTask.get(r.t.id))),
    count: rows.length,
  })
})

bridgeRoute.get('/tasks/:id', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.read', scope.projectId)
  if (denied) return c.json(denied, 403)
  const row = await db
    .select({ t: tasks, u: users })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .where(and(eq(tasks.id, c.req.param('id')), eq(tasks.projectId, scope.projectId), isNull(tasks.deletedAt)))
    .limit(1)
  if (!row.length) return c.json({ error: 'Not found' }, 404)
  const attached = await attachmentsFor(
    files.taskId,
    [row[0]!.t.id],
    scope.projectId,
    new Map([[row[0]!.t.id, row[0]!.t.description]]),
  )
  return c.json(taskView(row[0]!.t, row[0]!.u, attached.get(row[0]!.t.id)))
})

bridgeRoute.post('/tasks', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.create', scope.projectId)
  if (denied) return c.json(denied, 403)

  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const title = typeof b.title === 'string' ? b.title.trim() : ''
  if (!title) return c.json({ error: 'title is required' }, 400)

  const assigneeId = await resolveAssignee(id, scope.projectId, b.assignee)
  if (b.assignee !== undefined && assigneeId === undefined) return c.json({ error: `Unknown assignee: ${String(b.assignee)}` }, 400)
  const dueDate = parseDue(b.dueDate)

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
      description: typeof b.description === 'string' ? b.description : '',
      status: (['todo', 'in_progress', 'review', 'done'] as const).includes(b.status as never)
        ? (b.status as 'todo')
        : 'todo',
      priority: (['low', 'normal', 'high', 'urgent'] as const).includes(b.priority as never)
        ? (b.priority as 'normal')
        : 'normal',
      assigneeId: assigneeId ?? null,
      dueDate: dueDate ?? null,
      estimateMinutes: b.estimateMinutes != null ? String(b.estimateMinutes) : null,
      groupId: typeof b.sprintId === 'string' ? b.sprintId : null,
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
  tasksChanged(scope.projectId, [row!.assigneeId, row!.createdById])
  // подтягиваем исполнителя, чтобы агент сразу видел, на кого задача ушла
  const who = row!.assigneeId ? await db.query.users.findFirst({ where: eq(users.id, row!.assigneeId) }) : null
  return c.json(taskView(row!, who), 201)
})

bridgeRoute.patch('/tasks/:id', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const taskId = c.req.param('id')
  const existing = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.projectId, scope.projectId), isNull(tasks.deletedAt)),
  })
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  if (typeof b.title === 'string') patch.title = b.title.slice(0, 300)
  if (typeof b.description === 'string') patch.description = b.description
  if ((['todo', 'in_progress', 'review', 'done'] as const).includes(b.status as never)) patch.status = b.status
  if ((['low', 'normal', 'high', 'urgent'] as const).includes(b.priority as never)) patch.priority = b.priority
  if (b.estimateMinutes !== undefined) patch.estimateMinutes = b.estimateMinutes == null ? null : String(b.estimateMinutes)
  if (b.sprintId !== undefined) patch.groupId = b.sprintId ?? null
  if (b.assignee !== undefined) {
    const resolved = await resolveAssignee(id, scope.projectId, b.assignee)
    if (resolved === undefined) return c.json({ error: `Unknown assignee: ${String(b.assignee)}` }, 400)
    patch.assigneeId = resolved
  }

  if (b.dueDate !== undefined) {
    const due = parseDue(b.dueDate)
    if (due === undefined) return c.json({ error: `Cannot parse dueDate: ${String(b.dueDate)}` }, 400)
    patch.dueDate = due
  }
  if (!Object.keys(patch).length) return c.json({ error: 'Nothing to update' }, 400)

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

  const [row] = await db.update(tasks).set(patch).where(eq(tasks.id, taskId)).returning()
  void logActivity({
    projectId: scope.projectId,
    actorId: id.userId,
    action: 'update',
    entityType: 'task',
    entityId: taskId,
    entityLabel: `${row!.number} ${row!.title}`,
  })
  tasksChanged(scope.projectId, [row!.assigneeId, row!.createdById, existing.assigneeId, existing.createdById])
  const who = row!.assigneeId ? await db.query.users.findFirst({ where: eq(users.id, row!.assigneeId) }) : null
  return c.json(taskView(row!, who))
})

bridgeRoute.delete('/tasks/:id', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const taskId = c.req.param('id')
  const existing = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.projectId, scope.projectId), isNull(tasks.deletedAt)),
  })
  if (!existing) return c.json({ error: 'Not found' }, 404)

  // Свою задачу удаляет и участник; чужую — только с tasks.delete. То же
  // правило, что в интерфейсе: удаление мягкое, восстановимо 7 дней.
  const own = await ownsOrManages(scope.projectId, id.userId, [existing.createdById, existing.assigneeId])
  const denied = await require(c as never, own ? 'tasks.create' : 'tasks.delete', scope.projectId)
  if (denied) return c.json(denied, 403)

  await db.update(tasks).set({ deletedAt: new Date(), deletedById: id.userId }).where(eq(tasks.id, taskId))
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

// --- Комментарии к задаче ---------------------------------------------------

// --- чек-лист задачи --------------------------------------------------------
//
// Ассистент и задаёт вопросы по задаче, и закрывает пункты, когда сделал.
// Права те же, что у человека, от чьего имени он работает.

bridgeRoute.get('/tasks/:id/checklist', async (c) => {
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.read', scope.projectId)
  if (denied) return c.json(denied, 403)

  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, c.req.param('id')), eq(tasks.projectId, scope.projectId), isNull(tasks.deletedAt)),
  })
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
    note: r.item.note || undefined,
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

  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, c.req.param('id')), eq(tasks.projectId, scope.projectId), isNull(tasks.deletedAt)),
  })
  if (!task) return c.json({ error: 'Task not found' }, 404)
  if (!(await ownsOrManages(scope.projectId, id.userId, [task.createdById, task.assigneeId]))) {
    return c.json({ error: 'Forbidden: you can only edit tasks you created or that are assigned to you' }, 403)
  }

  const body = (await c.req.json().catch(() => ({}))) as { items?: unknown; text?: unknown; note?: unknown }
  // Списком за раз: вопросы к задаче обычно задают пачкой, а не по одному.
  const incoming = Array.isArray(body.items)
    ? body.items
    : typeof body.text === 'string'
      ? [{ text: body.text, note: body.note }]
      : []
  const parsed = incoming
    .map((x) => (typeof x === 'string' ? { text: x, note: '' } : (x as { text?: unknown; note?: unknown })))
    .filter((x) => typeof x.text === 'string' && (x.text as string).trim())
    .map((x) => ({ text: (x.text as string).trim().slice(0, 500), note: typeof x.note === 'string' ? x.note.slice(0, 4000) : '' }))

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

  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, c.req.param('id')), eq(tasks.projectId, scope.projectId), isNull(tasks.deletedAt)),
  })
  if (!task) return c.json({ error: 'Task not found' }, 404)
  if (!(await ownsOrManages(scope.projectId, id.userId, [task.createdById, task.assigneeId]))) {
    return c.json({ error: 'Forbidden: you can only edit tasks you created or that are assigned to you' }, 403)
  }

  const existing = await db.query.taskChecklist.findFirst({
    where: and(eq(taskChecklist.id, c.req.param('itemId')), eq(taskChecklist.taskId, task.id)),
  })
  if (!existing) return c.json({ error: 'Checklist item not found' }, 404)

  const b = (await c.req.json().catch(() => ({}))) as { text?: unknown; note?: unknown; done?: unknown }
  const patch: Record<string, unknown> = { updatedAt: new Date() }
  if (typeof b.text === 'string' && b.text.trim()) patch.text = b.text.trim().slice(0, 500)
  if (typeof b.note === 'string') patch.note = b.note.slice(0, 4000)
  if (typeof b.done === 'boolean') {
    patch.done = b.done
    patch.doneById = b.done ? id.userId : null
    patch.doneAt = b.done ? new Date() : null
  }
  if (Object.keys(patch).length === 1) return c.json({ error: 'Nothing to change. Supported: text, note, done.' }, 400)

  const [row] = await db.update(taskChecklist).set(patch).where(eq(taskChecklist.id, existing.id)).returning()
  tasksChanged(scope.projectId, [task.assigneeId, task.createdById])
  return c.json({ id: row!.id, text: row!.text, note: row!.note || undefined, done: row!.done })
})

bridgeRoute.get('/tasks/:id/comments', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.read', scope.projectId)
  if (denied) return c.json(denied, 403)
  const rows = await db
    .select({ c: taskComments, u: users })
    .from(taskComments)
    .leftJoin(users, eq(users.id, taskComments.authorId))
    .where(eq(taskComments.taskId, c.req.param('id')))
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
      attachments: byComment.get(r.c.id) ?? [],
      createdAt: r.c.createdAt,
    })),
  })
})

bridgeRoute.post('/tasks/:id/comments', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.read', scope.projectId)
  if (denied) return c.json(denied, 403)
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const text = typeof b.text === 'string' ? b.text.trim() : ''
  if (!text) return c.json({ error: 'text is required' }, 400)

  const taskId = c.req.param('id')
  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.projectId, scope.projectId), isNull(tasks.deletedAt)),
  })
  if (!task) return c.json({ error: 'Not found' }, 404)

  const [row] = await db.insert(taskComments).values({ taskId, projectId: scope.projectId, authorId: id.userId, body: text }).returning()
  broadcast(scope.projectId, 'task_comments_changed', { taskId })
  return c.json({ id: row!.id, createdAt: row!.createdAt }, 201)
})

// --- Спринты ----------------------------------------------------------------

// --- команда проекта -------------------------------------------------------
// Управлять командой из редактора: посмотреть, кто есть, позвать человека,
// сменить роль и уровни доступа. Исключение намеренно оставлено интерфейсу:
// оно необратимо (уходит письмо, рвутся туннели), а цена ошибки ассистента
// здесь выше, чем удобство. Понизить до «только чтение» мост может — это
// откатывается одной строкой.

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

  return c.json({
    canManage: await managesTeam(scope.projectId, id.userId),
    members: rows.map((r) => ({
      userId: r.u.id,
      name: r.u.name,
      email: r.u.email,
      role: r.m.role,
      jobTitle: r.m.jobTitle || undefined,
      responsibility: r.m.responsibility || undefined,
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
  const project = await db.query.projects.findFirst({ where: eq(projects.id, scope.projectId) })
  if (!project) return c.json({ error: 'Project not found' }, 404)

  const body = (await c.req.json().catch(() => ({}))) as {
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

  const body = (await c.req.json().catch(() => ({}))) as {
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

bridgeRoute.get('/sprints', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.read', scope.projectId)
  if (denied) return c.json(denied, 403)
  const rows = await db.query.taskGroups.findMany({
    where: and(eq(taskGroups.projectId, scope.projectId), isNull(taskGroups.deletedAt)),
  })
  return c.json({ items: rows.map((s) => ({ id: s.id, name: s.name })) })
})

bridgeRoute.post('/sprints', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'tasks.create', scope.projectId)
  if (denied) return c.json(denied, 403)
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name) return c.json({ error: 'name is required' }, 400)
  const [row] = await db
    .insert(taskGroups)
    .values({ projectId: scope.projectId, name: name.slice(0, 120), createdById: id.userId })
    .returning()
  broadcast(scope.projectId, 'tasks_changed', {})
  return c.json({ id: row!.id, name: row!.name }, 201)
})

// --- Трекинг времени (SPEC §8.32) -------------------------------------------
// Ради того, чтобы не тыкать таймеры руками: агент в редакторе знает, когда
// работа началась и кончилась, — пусть он и записывает.

bridgeRoute.get('/time/running', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const project = await db.query.projects.findFirst({ where: eq(projects.id, scope.projectId) })
  const cfg = readTimeConfig(project?.timeConfig)
  const rows = await db
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.projectId, scope.projectId), eq(timeEntries.userId, id.userId), isNull(timeEntries.endedAt)))

  const now = Date.now()
  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      description: r.description,
      taskId: r.taskId,
      startedAt: r.startedAt,
      elapsedMinutes: Math.round((now - r.startedAt.getTime()) / 60_000),
    })),
    maxTimers: cfg.maxTimers,
    hint: 'One entry links to ONE task at most. Two things at once means two timers, up to maxTimers.',
  })
})

bridgeRoute.post('/time/start', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const project = await db.query.projects.findFirst({ where: eq(projects.id, scope.projectId) })
  const cfg = readTimeConfig(project?.timeConfig)

  const running = await db
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.projectId, scope.projectId), eq(timeEntries.userId, id.userId), isNull(timeEntries.endedAt)))
  if (running.length >= cfg.maxTimers) {
    return c.json(
      {
        error: `${running.length} timer(s) already running; this project allows ${cfg.maxTimers} at once. Stop one first.`,
        running: running.map((r) => ({ id: r.id, startedAt: r.startedAt, description: r.description })),
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

  const [row] = await db
    .insert(timeEntries)
    .values({
      projectId: scope.projectId,
      userId: id.userId,
      taskId,
      description: String(b.description ?? '').slice(0, 500),
      startedAt: typeof b.startedAt === 'string' ? new Date(b.startedAt) : new Date(),
      createdVia: 'bridge',
    })
    .returning()
  broadcast(scope.projectId, 'time', { action: 'start', id: row!.id, userId: id.userId })
  return c.json({ id: row!.id, startedAt: row!.startedAt }, 201)
})

bridgeRoute.post('/time/stop', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const running = await db
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.projectId, scope.projectId), eq(timeEntries.userId, id.userId), isNull(timeEntries.endedAt)))
  if (!running.length) return c.json({ error: 'No timer is running' }, 404)

  const entry = typeof b.id === 'string' ? running.find((r) => r.id === b.id) : running[0]
  if (!entry) return c.json({ error: 'That timer is not running' }, 404)
  if (running.length > 1 && typeof b.id !== 'string') {
    return c.json(
      { error: 'Several timers are running — pass the id', running: running.map((r) => ({ id: r.id, description: r.description })) },
      400,
    )
  }

  const endedAt = new Date()
  // меньше секунды — двойной клик, а не работа
  if (endedAt.getTime() - entry.startedAt.getTime() < 1_000) {
    await db.delete(timeEntries).where(eq(timeEntries.id, entry.id))
    broadcast(scope.projectId, 'time', { action: 'delete', id: entry.id, userId: id.userId })
    return c.json({ discarded: true, reason: 'Stopped within a second — nothing recorded.' })
  }
  await db.update(timeEntries).set({ endedAt, updatedAt: endedAt }).where(eq(timeEntries.id, entry.id))
  broadcast(scope.projectId, 'time', { action: 'stop', id: entry.id, userId: id.userId })
  return c.json({ id: entry.id, minutes: Math.round((endedAt.getTime() - entry.startedAt.getTime()) / 60_000) })
})

bridgeRoute.post('/time', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)

  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
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
  return c.json({ id: row!.id, minutes: Math.round((ended.getTime() - started.getTime()) / 60_000) }, 201)
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
  const denied = await require(c as never, 'notes.read', scope.projectId)
  if (denied) return c.json(denied, 403)

  const q = c.req.query('q')?.trim()
  const conds = [isNull(notes.deletedAt)]

  // company-поиск существует ради «в прошлом проекте это уже решали»
  if (c.req.query('scope') === 'company') {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, scope.projectId) })
    conds.push(
      project?.companyId
        ? or(eq(notes.projectId, scope.projectId), and(eq(notes.companyId, project.companyId), eq(notes.scope, 'company')))!
        : eq(notes.projectId, scope.projectId),
    )
  } else {
    conds.push(eq(notes.projectId, scope.projectId))
  }

  const types = (c.req.query('type') ?? '').split(',').map((t) => t.trim()).filter(Boolean)
  if (types.length) conds.push(inArray(notes.type, types))
  for (const tag of (c.req.query('tag') ?? '').split(',').map((t) => t.trim()).filter(Boolean)) {
    conds.push(sql`${notes.tags}::jsonb ? ${tag}`)
  }
  if (q) {
    const like = `%${q}%`
    conds.push(or(sql`${notes.title} ilike ${like}`, sql`${notes.body} ilike ${like}`, sql`${notes.tags} ilike ${like}`)!)
  }

  const rows = await db
    .select({ n: notes, author: users, project: projects })
    .from(notes)
    .leftJoin(users, eq(users.id, notes.authorId))
    .leftJoin(projects, eq(projects.id, notes.projectId))
    .where(and(...conds))
    .orderBy(desc(notes.createdAt))
    .limit(Math.min(100, Math.max(1, Number(c.req.query('limit')) || 50)))

  return c.json({
    items: rows.map((r) => ({
      id: r.n.id,
      type: r.n.type,
      title: r.n.title,
      preview: htmlToText(r.n.body).slice(0, 200),
      tags: JSON.parse(r.n.tags) as string[],
      scope: r.n.scope,
      project: { id: r.n.projectId, name: r.project?.name ?? '' },
      author: r.author ? { id: r.author.id, name: r.author.name } : null,
      sourceCount: (JSON.parse(r.n.sources) as unknown[]).length,
      createdAt: r.n.createdAt,
    })),
    hint:
      'Add ?scope=company to search notes shared across every project of this company — that is where reusable technical solutions live. GET /x/notes/<id> returns the full body and the quoted sources.',
  })
})

bridgeRoute.get('/notes/:id', async (c) => {
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const denied = await require(c as never, 'notes.read', scope.projectId)
  if (denied) return c.json(denied, 403)

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
  const denied = await require(c as never, 'notes.write', scope.projectId)
  if (denied) return c.json(denied, 403)

  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
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
      body: String(b.body ?? ''),
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
  const denied = await require(c as never, 'notes.write', scope.projectId)
  if (denied) return c.json(denied, 403)

  const existing = await db.query.notes.findFirst({
    where: and(eq(notes.id, c.req.param('id')), eq(notes.projectId, scope.projectId), isNull(notes.deletedAt)),
  })
  if (!existing) return c.json({ error: 'Note not found' }, 404)
  // Чужую заметку не переписываем — как в интерфейсе
  if (!(await ownsOrManages(scope.projectId, id.userId, [existing.authorId]))) {
    return c.json({ error: 'Forbidden: you can only edit notes you wrote' }, 403)
  }

  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const patch: Partial<typeof notes.$inferInsert> = { updatedAt: new Date() }
  if (typeof b.type === 'string') {
    if (!(NOTE_TYPES as readonly string[]).includes(b.type)) {
      return c.json({ error: `type must be one of: ${NOTE_TYPES.join(', ')}` }, 400)
    }
    patch.type = b.type
  }
  if (typeof b.title === 'string') patch.title = b.title.slice(0, 300)
  if (typeof b.body === 'string') patch.body = sanitizeHtml(b.body)
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
  const denied = (await require(c as never, 'notes.read', scope.projectId)) ?? (await require(c as never, 'tasks.create', scope.projectId))
  if (denied) return c.json(denied, 403)

  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const res = await noteToTask(scope.projectId, id.userId, c.req.param('id'), {
    title: typeof b.title === 'string' ? b.title : undefined,
    assigneeId: typeof b.assigneeId === 'string' ? b.assigneeId : null,
    priority: typeof b.priority === 'string' ? b.priority : undefined,
    dueDate: typeof b.dueDate === 'string' ? b.dueDate : null,
  })
  if ('error' in res) return c.json({ error: res.error }, res.status)
  return c.json({ id: res.task.id, number: res.task.number, title: res.task.title, alreadyExisted: res.already })
})

bridgeRoute.delete('/notes/:id', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const existing = await db.query.notes.findFirst({
    where: and(eq(notes.id, c.req.param('id')), eq(notes.projectId, scope.projectId), isNull(notes.deletedAt)),
  })
  if (!existing) return c.json({ error: 'Note not found' }, 404)

  // Свою заметку убирает и участник; чужую — только с notes.delete
  const own = await ownsOrManages(scope.projectId, id.userId, [existing.authorId])
  const denied = await require(c as never, own ? 'notes.write' : 'notes.delete', scope.projectId)
  if (denied) return c.json(denied, 403)
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
    where: q ? and(base, ilike(documents.title, `%${q}%`)) : base,
    orderBy: desc(documents.updatedAt),
    limit: 100,
  })
  return c.json({
    items: rows.map((d) => {
      const text = htmlToText(d.content)
      return { id: d.id, title: d.title || '—', chars: text.length, preview: text.slice(0, 160), updatedAt: d.updatedAt }
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
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const title = typeof b.title === 'string' ? b.title.trim() : ''
  if (!title) return c.json({ error: 'title is required' }, 400)
  const [row] = await db
    .insert(documents)
    .values({
      projectId: scope.projectId,
      title: title.slice(0, 300),
      content: typeof b.content === 'string' ? b.content.slice(0, 500_000) : '',
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
  return c.json({ id: row!.id, title: row!.title }, 201)
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

  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const patch: Record<string, unknown> = { updatedById: id.userId }
  if (typeof b.title === 'string') patch.title = b.title.slice(0, 300)
  if (typeof b.content === 'string') patch.content = b.content.slice(0, 500_000)
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
  return c.json({ id: row!.id, title: row!.title })
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
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const add = typeof b.content === 'string' ? b.content : ''
  if (!add) return c.json({ error: 'content is required' }, 400)

  const { snapshot } = await import('./documents.js')
  await snapshot(docId, d.title, d.content, id.userId, 'before AI bridge append').catch(() => {})
  const next = `${d.content}${add}`.slice(0, 500_000)
  await db.update(documents).set({ content: next, updatedById: id.userId }).where(eq(documents.id, docId))
  broadcast(scope.projectId, 'documents_changed', { id: docId })
  return c.json({ ok: true, totalChars: next.length })
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
  const conds = [eq(messages.projectId, scope.projectId), eq(messages.mode, 'group' as const)]
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
      attachments: byMessage.get(r.m.id) ?? [],
      createdAt: r.m.createdAt,
    })),
  })
})

bridgeRoute.post('/messages', async (c) => {
  const id = auth(c as never)
  const scope = await resolveProject(c as never)
  if ('error' in scope) return c.json({ error: scope.error }, scope.status)
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
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
  if (replyToId) {
    const parent = await db.query.messages.findFirst({
      where: and(eq(messages.id, replyToId), eq(messages.projectId, scope.projectId)),
    })
    if (!parent) return c.json({ error: 'replyToId: message not found in this project' }, 404)
  }

  const [row] = await db
    .insert(messages)
    .values({
      projectId: scope.projectId,
      authorId: id.userId,
      mode: 'group',
      status: 'delivered',
      rawSend: true, // минуя диспетчер: это уже осмысленное сообщение
      text: (text || '📎').slice(0, 4000),
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
  return c.json({
    items: rows.map((r: typeof credentials.$inferSelect) => ({ id: r.id, name: r.name, url: r.url, description: r.description })),
    note: 'Secret values are never exposed through the bridge.',
  })
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

  // тело пересылаем как есть; manager=1 — файл сразу постоянный, не временный
  const form = await c.req.formData()
  if (!form.get('taskId')) form.set('manager', '1')

  const res = await filesRoute.request('/', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
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
  return c.json(payload, res.status as 200)
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
