import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../db/client.js'
import { companies, companyMembers, projects, projectMembers, users } from '../db/schema.js'
import { requireSession, signProjectToken, type SessionEnv } from '../auth.js'
import { sendMail } from '../lib/mail.js'

export const projectsRoute = new Hono<SessionEnv>()
projectsRoute.use('*', requireSession)

const CHAT_RULES_MAX = 300 // SPEC §4.2 — попадает в каждый промпт ИИ

// SPEC §4.1: каждый параметр = конкретное действие диспетчера
const aiConfigSchema = z.object({
  mode: z.enum(['observer', 'assistant', 'moderator']).default('assistant'),
  language: z.string().min(2).max(8).default('en'), // язык проекта
  autoTranslate: z.boolean().default(true),
  answerRepeats: z.boolean().default(true),
  offtopic: z.enum(['ignore', 'remind', 'hold']).default('remind'),
})

// SPEC §4.3: per-user пермишены; tasks.read всегда true
export const PROJECT_PERMISSIONS = [
  'tasks.create',
  'tasks.edit',
  'tasks.delete',
  'tasks.changeStatus',
  'credentials.read', // видеть и раскрывать значения
  'credentials.manage', // создавать/менять/удалять
] as const
export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number]
const permissionsSchema = z.record(z.enum(PROJECT_PERMISSIONS), z.boolean())

export function defaultPermissions(role: 'owner' | 'admin' | 'member'): Record<ProjectPermission, boolean> {
  if (role === 'member')
    return {
      'tasks.create': false,
      'tasks.edit': false,
      'tasks.delete': false,
      'tasks.changeStatus': true,
      'credentials.read': true,
      'credentials.manage': false,
    }
  return {
    'tasks.create': true,
    'tasks.edit': true,
    'tasks.delete': true,
    'tasks.changeStatus': true,
    'credentials.read': true,
    'credentials.manage': true,
  }
}

/** Эффективный пермишен участника (дефолты роли + оверрайды). */
export async function hasPermission(projectId: string, userId: string, perm: ProjectPermission): Promise<boolean> {
  const m = await db.query.projectMembers.findFirst({
    where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)),
  })
  if (!m) return false
  const effective = { ...defaultPermissions(m.role), ...JSON.parse(m.permissions || '{}') }
  return Boolean(effective[perm])
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

    const { name, about, aiConfig, chatRules } = c.req.valid('json')
    const patch: Record<string, unknown> = {}
    if (name !== undefined) patch.name = name
    if (about !== undefined) patch.about = about
    if (chatRules !== undefined) patch.chatRules = chatRules
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
    .select({ id: projectMembers.id, role: projectMembers.role, permissions: projectMembers.permissions, user: users })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
  return c.json(
    rows.map((r) => ({
      id: r.id,
      role: r.role,
      permissions: { ...defaultPermissions(r.role), ...JSON.parse(r.permissions || '{}') },
      user: { id: r.user.id, name: r.user.name, email: r.user.email, avatarUrl: r.user.avatarUrl },
    })),
  )
})

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

    const current = { ...defaultPermissions(target.role), ...JSON.parse(target.permissions || '{}') }
    const patch = c.req.valid('json')
    await db
      .update(projectMembers)
      .set({ permissions: JSON.stringify({ ...current, ...patch }) })
      .where(eq(projectMembers.id, target.id))

    return c.json({ ok: true, permissions: { ...current, ...patch } })
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
      await sendMail({
        to: target.email,
        subject: `You've been added to "${project.name}" on Chatick`,
        text: `You've been added to the project "${project.name}".\nOpen Chatick to join the conversation.`,
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
    await sendMail({
      to: target.email,
      subject: `You've been removed from "${project.name}" on Chatick`,
      text: `You've been removed from the project "${project.name}".`,
    })

  return c.json({ ok: true })
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
