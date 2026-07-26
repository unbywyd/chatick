import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../db/client.js'
import { companies, companyMembers, messages, notifications, projects, projectMembers, projectStorage, tasks, users } from '../db/schema.js'
import { encrypt } from '../lib/crypto.js'
import { PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { requireSession, requireProject, signProjectToken, type SessionEnv, type ProjectEnv } from '../auth.js'
import { sendAddedToProjectMail, sendRemovedFromProjectMail } from '../lib/mails.js'
import { companyLlm } from '../lib/llm.js'

export const projectsRoute = new Hono<SessionEnv>()
projectsRoute.use('*', requireSession)

const CHAT_RULES_MAX = 300 // SPEC §4.2 — попадает в каждый промпт ИИ

// SPEC §4.1: каждый параметр = конкретное действие диспетчера
const aiConfigSchema = z.object({
  mode: z.enum(['observer', 'assistant', 'moderator']).default('assistant'),
  // ЯЗЫК ПРОЕКТА: задачи, документы и чат ведутся на нём; сообщения на других языках ИИ придерживает и переводит
  language: z.string().min(2).max(8).default('en'),
  autoTranslate: z.boolean().default(true),
  answerRepeats: z.boolean().default(true),
  // при создании задачи ИИ адаптирует её под язык проекта и слегка улучшает формулировку
  improveTasks: z.boolean().default(false),
  // при создании задачи ИИ генерирует заметки (факты/проблемы/рекомендации/опровержения) — SPEC §8.14
  generateTaskNotes: z.boolean().default(false),
  // автопубликация в чат системных сообщений о задачах (завершил / назначил) — SPEC §8.23
  autoPostTaskEvents: z.boolean().default(true),
})

// SPEC §4.3 / §8: доменная модель прав. Каждый домен получает УРОВЕНЬ доступа,
// а конкретные булевы действия (tasks.create и т.п.) выводятся из уровня.
// Это питает и ручной CRUD, и ИИ-инструменты (Фаза 10) — единая проверка.
export const PERMISSION_DOMAINS = ['tasks', 'files', 'resources', 'documents', 'notes'] as const
export type PermissionDomain = (typeof PERMISSION_DOMAINS)[number]

// none < read < write < crud. write = создавать/менять свои, crud = + удалять/чужое.
export const PERMISSION_LEVELS = ['none', 'read', 'write', 'crud'] as const
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number]
const LEVEL_RANK: Record<PermissionLevel, number> = { none: 0, read: 1, write: 2, crud: 3 }

export type DomainPermissions = Record<PermissionDomain, PermissionLevel>

// Гранулярные действия, которые проверяет код. Каждое требует минимального уровня в своём домене.
export const PROJECT_PERMISSIONS = [
  'tasks.read',
  'tasks.create',
  'tasks.edit',
  'tasks.delete',
  'tasks.changeStatus',
  'files.read',
  'files.upload',
  'files.delete',
  'resources.read', // видеть ресурсы и раскрывать секреты
  'resources.manage', // создавать/менять/удалять ресурсы и секреты
  'documents.read',
  'documents.write',
  'documents.delete',
  'notes.read',
  'notes.write',
  'notes.delete',
  // legacy-алиасы (совместимость со старым кодом/данными)
  'credentials.read',
  'credentials.manage',
] as const
export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number]

// действие → [домен, минимальный уровень]
const ACTION_REQUIREMENT: Record<ProjectPermission, [PermissionDomain, PermissionLevel]> = {
  'tasks.read': ['tasks', 'read'],
  'tasks.changeStatus': ['tasks', 'read'], // менять статус может любой с доступом на чтение задач
  'tasks.create': ['tasks', 'write'],
  'tasks.edit': ['tasks', 'write'],
  'tasks.delete': ['tasks', 'crud'],
  'files.read': ['files', 'read'],
  'files.upload': ['files', 'write'],
  'files.delete': ['files', 'crud'],
  'resources.read': ['resources', 'read'],
  'resources.manage': ['resources', 'write'],
  'documents.read': ['documents', 'read'],
  'documents.write': ['documents', 'write'],
  'documents.delete': ['documents', 'crud'],
  'notes.read': ['notes', 'read'],
  'notes.write': ['notes', 'write'],
  'notes.delete': ['notes', 'crud'],
  'credentials.read': ['resources', 'read'],
  'credentials.manage': ['resources', 'write'],
}

const levelSchema = z.enum(PERMISSION_LEVELS)
const domainPermissionsSchema = z.object({
  tasks: levelSchema,
  files: levelSchema,
  resources: levelSchema,
  documents: levelSchema,
  notes: levelSchema,
})
// PATCH принимает частичный набор доменных уровней
const permissionsSchema = domainPermissionsSchema.partial()

export function defaultDomainPermissions(role: 'owner' | 'admin' | 'member'): DomainPermissions {
  // Заметки участник пишет наравне с документами: журнал ценен, только если
  // его ведут все, кто видит проблему, а не один админ.
  if (role === 'member') return { tasks: 'read', files: 'write', resources: 'read', documents: 'write', notes: 'write' }
  return { tasks: 'crud', files: 'crud', resources: 'crud', documents: 'crud', notes: 'crud' }
}

/** Разворачивает доменные уровни в плоский набор булевых действий (для UI и legacy). */
export function expandPermissions(domains: DomainPermissions): Record<ProjectPermission, boolean> {
  const out = {} as Record<ProjectPermission, boolean>
  for (const action of PROJECT_PERMISSIONS) {
    const [domain, min] = ACTION_REQUIREMENT[action]
    out[action] = LEVEL_RANK[domains[domain]] >= LEVEL_RANK[min]
  }
  return out
}

/**
 * Читает сохранённые права участника. Поддерживает и НОВЫЙ формат
 * ({tasks,files,resources}: уровень), и СТАРЫЙ (плоские булевы оверрайды).
 */
function resolveDomains(role: 'owner' | 'admin' | 'member', raw: string | null): DomainPermissions {
  const base = defaultDomainPermissions(role)
  if (!raw) return base
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(raw)
  } catch {
    return base
  }
  // Новый формат: значения-строки уровней
  const out = { ...base }
  for (const d of PERMISSION_DOMAINS) {
    const v = parsed[d]
    if (typeof v === 'string' && (PERMISSION_LEVELS as readonly string[]).includes(v)) {
      out[d] = v as PermissionLevel
    }
  }
  // Старый формат: булевы оверрайды повышают уровень, если явно true
  if (parsed['tasks.delete'] === true) out.tasks = 'crud'
  else if (parsed['tasks.create'] === true || parsed['tasks.edit'] === true)
    out.tasks = LEVEL_RANK[out.tasks] < LEVEL_RANK.write ? 'write' : out.tasks
  if (parsed['credentials.manage'] === true) out.resources = LEVEL_RANK[out.resources] < LEVEL_RANK.write ? 'write' : out.resources
  else if (parsed['credentials.read'] === true) out.resources = LEVEL_RANK[out.resources] < LEVEL_RANK.read ? 'read' : out.resources
  return out
}

/** Эффективные доменные уровни участника. */
export async function memberDomains(projectId: string, userId: string): Promise<DomainPermissions | null> {
  const m = await db.query.projectMembers.findFirst({
    where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)),
  })
  if (!m) return null
  return resolveDomains(m.role, m.permissions)
}

/** Эффективный плоский пермишен участника (для существующих проверок в коде). */
export async function hasPermission(projectId: string, userId: string, perm: ProjectPermission): Promise<boolean> {
  const domains = await memberDomains(projectId, userId)
  if (!domains) return false
  return expandPermissions(domains)[perm]
}

// Обратная совместимость: старое имя ещё используется в коде.
export function defaultPermissions(role: 'owner' | 'admin' | 'member'): Record<ProjectPermission, boolean> {
  return expandPermissions(defaultDomainPermissions(role))
}

async function companyRoleOf(companyId: string, userId: string) {
  const m = await db.query.companyMembers.findFirst({
    where: and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId)),
  })
  return m?.role ?? null
}

const canCreateProjects = (role: string | null) => role === 'admin' || role === 'manager'

// Список проектов компании, где юзер участник (или все — для admin/manager)
projectsRoute.get('/', zValidator('query', z.object({ companyId: z.string().min(1) })), async (c) => {
  const { sub } = c.get('session')
  const { companyId } = c.req.valid('query')
  const role = await companyRoleOf(companyId, sub)
  if (!role) return c.json({ error: 'Forbidden' }, 403)

  const all = await db.query.projects.findMany({ where: eq(projects.companyId, companyId) })
  const my = await db.query.projectMembers.findMany({ where: eq(projectMembers.userId, sub) })
  const myByProject = new Map(my.map((m) => [m.projectId, m]))

  const visible = canCreateProjects(role) ? all : all.filter((p) => myByProject.has(p.id))
  const ids = visible.map((p) => p.id)

  // Обзор по проектам (SPEC §8.26): прогресс общий и по моим задачам + мои
  // непрочитанные уведомления. Три агрегирующих запроса вместо N на проект.
  type Counts = { total: number; done: number; inProgress?: number; review?: number; todo?: number }
  const overall = new Map<string, Counts>()
  const mine = new Map<string, Counts>()
  const unread = new Map<string, number>()
  const membersByProject = new Map<string, { id: string; name: string; avatarUrl: string | null }[]>()
  const lastMessage = new Map<string, { text: string; author: string; at: string }>()

  if (ids.length) {
    const notDeleted = sql`${tasks.deletedAt} is null`
    const rows = await db
      .select({
        projectId: tasks.projectId,
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) filter (where ${tasks.status} = 'done')::int`,
        // разбивка по статусам: менеджеру важно видеть не только «сделано»,
        // но и сколько в работе / на ревью / ещё не начато
        inProgress: sql<number>`count(*) filter (where ${tasks.status} = 'in_progress')::int`,
        review: sql<number>`count(*) filter (where ${tasks.status} = 'review')::int`,
        todo: sql<number>`count(*) filter (where ${tasks.status} = 'todo')::int`,
      })
      .from(tasks)
      .where(and(inArray(tasks.projectId, ids), notDeleted))
      .groupBy(tasks.projectId)
    for (const r of rows)
      overall.set(r.projectId, {
        total: r.total,
        done: r.done,
        inProgress: r.inProgress,
        review: r.review,
        todo: r.todo,
      })

    const myRows = await db
      .select({
        projectId: tasks.projectId,
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) filter (where ${tasks.status} = 'done')::int`,
      })
      .from(tasks)
      .where(and(inArray(tasks.projectId, ids), eq(tasks.assigneeId, sub), notDeleted))
      .groupBy(tasks.projectId)
    for (const r of myRows) mine.set(r.projectId, { total: r.total, done: r.done })

    const notifRows = await db
      .select({ projectId: notifications.projectId, count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(inArray(notifications.projectId, ids), eq(notifications.userId, sub), isNull(notifications.readAt)))
      .groupBy(notifications.projectId)
    for (const r of notifRows) unread.set(r.projectId, r.count)

    // участники проектов — для аватарок на карточке
    const memberRows = await db
      .select({ projectId: projectMembers.projectId, user: users })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(inArray(projectMembers.projectId, ids))
    for (const r of memberRows) {
      const arr = membersByProject.get(r.projectId) ?? []
      arr.push({ id: r.user.id, name: r.user.name, avatarUrl: r.user.avatarUrl })
      membersByProject.set(r.projectId, arr)
    }

    // Последнее сообщение проекта — список проектов работает как список чатов
    // (SPEC §8.29). DISTINCT ON быстрее, чем отдельный запрос на проект.
    const lastRows = await db.execute(sql`
      select distinct on (m.project_id)
        m.project_id as "projectId", m.text, m.created_at as "createdAt",
        m.system_event as "systemEvent", u.name as "authorName"
      from messages m
      left join users u on u.id = m.author_id
      where m.project_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        and m.mode = 'group' and m.status = 'delivered'
      order by m.project_id, m.created_at desc
    `)
    for (const r of lastRows as unknown as {
      projectId: string
      text: string
      createdAt: string
      authorName: string | null
    }[]) {
      lastMessage.set(r.projectId, {
        text: (r.text ?? '').slice(0, 140),
        author: r.authorName ?? 'AI',
        at: r.createdAt,
      })
    }
  }

  const pct = (c: Counts | undefined) => (c && c.total > 0 ? Math.round((c.done / c.total) * 100) : 0)

  return c.json(
    visible.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      about: p.about,
      chatRules: p.chatRules,
      isMember: myByProject.has(p.id),
      myRole: myByProject.get(p.id)?.role ?? null,
      rulesAccepted: Boolean(myByProject.get(p.id)?.rulesAcceptedAt),
      members: (membersByProject.get(p.id) ?? []).slice(0, 8),
      lastMessage: lastMessage.get(p.id) ?? null,
      memberCount: (membersByProject.get(p.id) ?? []).length,
      stats: {
        tasksTotal: overall.get(p.id)?.total ?? 0,
        tasksDone: overall.get(p.id)?.done ?? 0,
        tasksInProgress: overall.get(p.id)?.inProgress ?? 0,
        tasksReview: overall.get(p.id)?.review ?? 0,
        tasksTodo: overall.get(p.id)?.todo ?? 0,
        progress: pct(overall.get(p.id)),
        myTotal: mine.get(p.id)?.total ?? 0,
        myDone: mine.get(p.id)?.done ?? 0,
        myProgress: pct(mine.get(p.id)),
        unread: unread.get(p.id) ?? 0,
      },
    })),
  )
})

// Создать проект — company admin/manager (SPEC §2.1)
projectsRoute.post(
  '/',
  zValidator(
    'json',
    z.object({
      companyId: z.string().min(1),
      name: z.string().min(1).max(120),
      about: z.string().max(5000).default(''),
      chatRules: z.string().max(CHAT_RULES_MAX).default(''),
      aiConfig: aiConfigSchema.partial().default({}),
    }),
  ),
  async (c) => {
    const { sub } = c.get('session')
    const { companyId, name, about, chatRules, aiConfig } = c.req.valid('json')
    if (!canCreateProjects(await companyRoleOf(companyId, sub))) return c.json({ error: 'Forbidden' }, 403)

    const slug = `${name.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project'}-${nanoid(6)}`
    const [project] = await db
      .insert(projects)
      .values({ companyId, name, about, slug, chatRules, aiConfig: JSON.stringify(aiConfig) })
      .returning()
    await db.insert(projectMembers).values({
      projectId: project!.id,
      userId: sub,
      role: 'owner',
      permissions: JSON.stringify(defaultPermissions('owner')),
      rulesAcceptedAt: new Date(),
    })

    return c.json(project, 201)
  },
)

async function projectRoleOf(projectId: string, userId: string) {
  const m = await db.query.projectMembers.findFirst({
    where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)),
  })
  return m ?? null
}

// Детали проекта (участник или company admin/manager)
projectsRoute.get('/:projectId', async (c) => {
  const { sub } = c.get('session')
  const projectId = c.req.param('projectId')
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return c.json({ error: 'Not found' }, 404)

  const membership = await projectRoleOf(projectId, sub)
  const companyRole = await companyRoleOf(project.companyId, sub)
  if (!membership && !canCreateProjects(companyRole)) return c.json({ error: 'Forbidden' }, 403)

  return c.json({
    ...project,
    aiConfig: JSON.parse(project.aiConfig || '{}'),
    myRole: membership?.role ?? null,
    rulesAccepted: Boolean(membership?.rulesAcceptedAt),
  })
})

// Обновить настройки проекта: about, aiConfig, chatRules (owner/admin проекта или company admin)
projectsRoute.patch(
  '/:projectId',
  zValidator(
    'json',
    z.object({
      name: z.string().min(1).max(120).optional(),
      about: z.string().max(5000).optional(),
      aiConfig: aiConfigSchema.partial().optional(),
      chatRules: z.string().max(CHAT_RULES_MAX).optional(),
      storageLimit: z.number().int().min(0).nullable().optional(), // байты; null = наследовать компанию, 0 = без override (безлимит в рамках компании)
    }),
  ),
  async (c) => {
    const { sub } = c.get('session')
    const projectId = c.req.param('projectId')
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
    if (!project) return c.json({ error: 'Not found' }, 404)

    const membership = await projectRoleOf(projectId, sub)
    const companyRole = await companyRoleOf(project.companyId, sub)
    const allowed = membership?.role === 'owner' || membership?.role === 'admin' || companyRole === 'admin'
    if (!allowed) return c.json({ error: 'Forbidden' }, 403)

    const { name, about, aiConfig, chatRules, storageLimit } = c.req.valid('json')
    const patch: Record<string, unknown> = {}
    if (name !== undefined) patch.name = name
    if (about !== undefined) patch.about = about
    if (chatRules !== undefined) patch.chatRules = chatRules
    if (storageLimit !== undefined) patch.storageLimit = storageLimit === null ? null : String(storageLimit)
    if (aiConfig !== undefined) {
      const current = JSON.parse(project.aiConfig || '{}')
      patch.aiConfig = JSON.stringify({ ...current, ...aiConfig })
    }

    const [updated] = await db.update(projects).set(patch).where(eq(projects.id, projectId)).returning()
    return c.json({ ...updated, aiConfig: JSON.parse(updated!.aiConfig || '{}') })
  },
)

// Участники проекта
projectsRoute.get('/:projectId/members', async (c) => {
  const { sub } = c.get('session')
  const projectId = c.req.param('projectId')
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return c.json({ error: 'Not found' }, 404)
  const membership = await projectRoleOf(projectId, sub)
  if (!membership && !canCreateProjects(await companyRoleOf(project.companyId, sub)))
    return c.json({ error: 'Forbidden' }, 403)

  const rows = await db
    .select({
      id: projectMembers.id,
      role: projectMembers.role,
      permissions: projectMembers.permissions,
      jobTitle: projectMembers.jobTitle,
      responsibility: projectMembers.responsibility,
      user: users,
    })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
  return c.json(
    rows.map((r) => {
      const domains = resolveDomains(r.role, r.permissions)
      return {
        id: r.id,
        role: r.role,
        domains, // {tasks,files,resources}: уровень — основной формат для UI
        permissions: expandPermissions(domains), // плоские булевы — совместимость
        jobTitle: r.jobTitle,
        responsibility: r.responsibility,
        user: { id: r.user.id, name: r.user.name, email: r.user.email, avatarUrl: r.user.avatarUrl },
      }
    }),
  )
})

// Профиль участника в проекте: должность + зона ответственности (SPEC §8.12) — owner/admin
projectsRoute.patch(
  '/:projectId/members/:userId/profile',
  zValidator('json', z.object({ jobTitle: z.string().max(200).optional(), responsibility: z.string().max(400).optional() })),
  async (c) => {
    const { sub } = c.get('session')
    const { projectId, userId } = c.req.param()
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
    if (!project) return c.json({ error: 'Not found' }, 404)
    const me = await projectRoleOf(projectId, sub)
    const companyRole = await companyRoleOf(project.companyId, sub)
    if (!(me?.role === 'owner' || me?.role === 'admin' || companyRole === 'admin')) return c.json({ error: 'Forbidden' }, 403)
    const target = await projectRoleOf(projectId, userId)
    if (!target) return c.json({ error: 'Not a project member' }, 404)
    const b = c.req.valid('json')
    const patch: Record<string, unknown> = {}
    if (b.jobTitle !== undefined) patch.jobTitle = b.jobTitle
    if (b.responsibility !== undefined) patch.responsibility = b.responsibility
    await db.update(projectMembers).set(patch).where(eq(projectMembers.id, target.id))
    return c.json({ ok: true })
  },
)

// Пермишены участника (SPEC §4.3) — owner/admin проекта или company admin
projectsRoute.patch(
  '/:projectId/members/:userId/permissions',
  zValidator('json', permissionsSchema),
  async (c) => {
    const { sub } = c.get('session')
    const { projectId, userId } = c.req.param()
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
    if (!project) return c.json({ error: 'Not found' }, 404)

    const me = await projectRoleOf(projectId, sub)
    const companyRole = await companyRoleOf(project.companyId, sub)
    const allowed = me?.role === 'owner' || me?.role === 'admin' || companyRole === 'admin'
    if (!allowed) return c.json({ error: 'Forbidden' }, 403)

    const target = await projectRoleOf(projectId, userId)
    if (!target) return c.json({ error: 'Not a project member' }, 404)
    if (target.role === 'owner') return c.json({ error: 'Owner permissions are fixed' }, 400)

    const current = resolveDomains(target.role, target.permissions)
    const patch = c.req.valid('json')
    const next: DomainPermissions = { ...current, ...patch }
    // сохраняем ЧИСТЫЙ новый формат — уровни доменов
    await db.update(projectMembers).set({ permissions: JSON.stringify(next) }).where(eq(projectMembers.id, target.id))

    return c.json({ ok: true, domains: next, permissions: expandPermissions(next) })
  },
)

// Включить участника компании в проект — БЕЗ подтверждения, письмо постфактум (SPEC §3.2)
projectsRoute.post(
  '/:projectId/members',
  zValidator('json', z.object({ userId: z.string().min(1), role: z.enum(['admin', 'member']).default('member') })),
  async (c) => {
    const { sub } = c.get('session')
    const projectId = c.req.param('projectId')
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
    if (!project) return c.json({ error: 'Not found' }, 404)

    const me = await projectRoleOf(projectId, sub)
    const companyRole = await companyRoleOf(project.companyId, sub)
    const allowed = me?.role === 'owner' || me?.role === 'admin' || canCreateProjects(companyRole)
    if (!allowed) return c.json({ error: 'Forbidden' }, 403)

    const { userId, role } = c.req.valid('json')
    // добавляемый должен быть участником компании
    if (!(await companyRoleOf(project.companyId, userId))) return c.json({ error: 'User is not a company member' }, 400)

    const exists = await projectRoleOf(projectId, userId)
    if (exists) return c.json({ error: 'Already a member' }, 409)

    await db.insert(projectMembers).values({ projectId, userId, role, permissions: JSON.stringify(defaultPermissions(role)) })

    const target = await db.query.users.findFirst({ where: eq(users.id, userId) })
    if (target)
      await sendAddedToProjectMail({
        to: target.email,
        locale: target.locale,
        projectId,
        projectName: project.name,
      })

    return c.json({ ok: true }, 201)
  },
)

// Убрать участника — письмо постфактум
projectsRoute.delete('/:projectId/members/:userId', async (c) => {
  const { sub } = c.get('session')
  const { projectId, userId } = c.req.param()
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return c.json({ error: 'Not found' }, 404)

  const me = await projectRoleOf(projectId, sub)
  const companyRole = await companyRoleOf(project.companyId, sub)
  const allowed = me?.role === 'owner' || me?.role === 'admin' || canCreateProjects(companyRole)
  if (!allowed) return c.json({ error: 'Forbidden' }, 403)

  await db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))

  const target = await db.query.users.findFirst({ where: eq(users.id, userId) })
  if (target)
    await sendRemovedFromProjectMail({
      to: target.email,
      locale: target.locale,
      projectName: project.name,
    })

  return c.json({ ok: true })
})

// Статус LLM для чата (project-токен): подключён ли ИИ у компании проекта
projectsRoute.get('/:projectId/llm-status', requireProject, async (c) => {
  const { projectId } = (c as unknown as { get: (k: 'auth') => ProjectEnv['Variables']['auth'] }).get('auth')
  if (projectId !== c.req.param('projectId')) return c.json({ error: 'Forbidden' }, 403)
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return c.json({ error: 'Not found' }, 404)
  const llm = await companyLlm(project.companyId)
  return c.json({ configured: Boolean(llm), companyId: project.companyId })
})

// --- Хранилище проекта (SPEC §8.10) — только owner/admin проекта / company admin ---

async function canManageProject(projectId: string, userId: string): Promise<boolean> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return false
  const me = await projectRoleOf(projectId, userId)
  const companyRole = await companyRoleOf(project.companyId, userId)
  return me?.role === 'owner' || me?.role === 'admin' || companyRole === 'admin'
}

// Конфиг хранилища — БЕЗ ключей (метаданные + флаг «ключи заданы»)
projectsRoute.get('/:projectId/storage', async (c) => {
  const { sub } = c.get('session')
  const { projectId } = c.req.param()
  if (!(await canManageProject(projectId, sub))) return c.json({ error: 'Forbidden' }, 403)
  const s = await db.query.projectStorage.findFirst({ where: eq(projectStorage.projectId, projectId) })
  return c.json({
    provider: s?.provider ?? 'platform',
    endpoint: s?.endpoint ?? '',
    region: s?.region ?? 'auto',
    bucket: s?.bucket ?? '',
    publicUrl: s?.publicUrl ?? '',
    hasKeys: Boolean(s?.accessKeyEncrypted && s?.secretKeyEncrypted),
  })
})

const storageSchema = z.object({
  provider: z.enum(['platform', 'custom']),
  endpoint: z.string().max(500).optional(),
  region: z.string().max(100).optional(),
  bucket: z.string().max(200).optional(),
  publicUrl: z.string().max(500).optional(),
  accessKey: z.string().max(500).optional(), // передаётся только при смене
  secretKey: z.string().max(1000).optional(),
})

projectsRoute.put('/:projectId/storage', zValidator('json', storageSchema), async (c) => {
  const { sub } = c.get('session')
  const { projectId } = c.req.param()
  if (!(await canManageProject(projectId, sub))) return c.json({ error: 'Forbidden' }, 403)
  const b = c.req.valid('json')
  const existing = await db.query.projectStorage.findFirst({ where: eq(projectStorage.projectId, projectId) })

  if (b.provider === 'platform') {
    // вернуться на платформу: чистим кастомный конфиг
    if (existing) await db.update(projectStorage).set({ provider: 'platform' }).where(eq(projectStorage.projectId, projectId))
    else await db.insert(projectStorage).values({ projectId, provider: 'platform' })
    return c.json({ ok: true, provider: 'platform' })
  }

  // custom: требуем endpoint+bucket, ключи — при первой настройке обязательны
  if (!b.endpoint || !b.bucket) return c.json({ error: 'endpoint and bucket are required' }, 400)
  const accessKey = b.accessKey || null
  const secretKey = b.secretKey || null
  const hasExistingKeys = Boolean(existing?.accessKeyEncrypted && existing?.secretKeyEncrypted)
  if (!hasExistingKeys && (!accessKey || !secretKey)) return c.json({ error: 'access key and secret key are required' }, 400)

  // проверка соединения новыми/текущими ключами: пробный put+delete
  const testAccess = accessKey ?? (existing?.accessKeyEncrypted ? undefined : null)
  if (accessKey && secretKey) {
    try {
      const client = new S3Client({ region: b.region || 'auto', endpoint: b.endpoint, credentials: { accessKeyId: accessKey, secretAccessKey: secretKey } })
      const testKey = `chatick-connection-test/${projectId}.txt`
      await client.send(new PutObjectCommand({ Bucket: b.bucket, Key: testKey, Body: 'ok' }))
      await client.send(new DeleteObjectCommand({ Bucket: b.bucket, Key: testKey }))
    } catch (err) {
      return c.json({ error: `Connection test failed: ${err instanceof Error ? err.message : String(err)}` }, 400)
    }
  }
  void testAccess

  const values = {
    provider: 'custom' as const,
    endpoint: b.endpoint,
    region: b.region || 'auto',
    bucket: b.bucket,
    publicUrl: b.publicUrl || null,
    ...(accessKey ? { accessKeyEncrypted: encrypt(accessKey) } : {}),
    ...(secretKey ? { secretKeyEncrypted: encrypt(secretKey) } : {}),
  }
  if (existing) await db.update(projectStorage).set(values).where(eq(projectStorage.projectId, projectId))
  else await db.insert(projectStorage).values({ projectId, ...values })
  return c.json({ ok: true, provider: 'custom' })
})

// Войти в проект: подтвердить правила (если ещё нет) → получить project-JWT (SPEC §5)
projectsRoute.post(
  '/:projectId/enter',
  zValidator('json', z.object({ acceptRules: z.boolean().default(false) })),
  async (c) => {
    const { sub, email } = c.get('session')
    const projectId = c.req.param('projectId')
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
    if (!project) return c.json({ error: 'Not found' }, 404)

    const membership = await projectRoleOf(projectId, sub)
    if (!membership) return c.json({ error: 'Not a project member' }, 403)

    // правила чата подтверждаются перед первым входом (SPEC §4.2)
    if (!membership.rulesAcceptedAt) {
      const { acceptRules } = c.req.valid('json')
      if (!acceptRules) {
        return c.json({ needRulesAccept: true, chatRules: project.chatRules, projectName: project.name }, 428)
      }
      await db.update(projectMembers).set({ rulesAcceptedAt: new Date() }).where(eq(projectMembers.id, membership.id))
    }

    const token = await signProjectToken({ sub, email, projectId, role: membership.role })
    return c.json({ token, project: { id: project.id, name: project.name, slug: project.slug } })
  },
)
