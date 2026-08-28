import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import sharp from 'sharp'
import { db } from '../db/client.js'
import { env } from '../env.js'
import { companyTrialSpendUsd } from '../lib/ai-usage.js'
import { companies, companyInvites, companyMembers, files, FREE_STORAGE_BYTES, messages, notifications, projects, projectMembers, projectStorage, tasks, timeEntries, users, projectAi } from '../db/schema.js'
import { encrypt } from '../lib/crypto.js'
import { membersLockedForCompany, membersLockedForProject, MEMBERS_LOCKED } from '../lib/members-locked.js'
import { logActivity } from '../lib/audit.js'
import { PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { requireSession, requireProject, signProjectToken, type SessionEnv, type ProjectEnv } from '../auth.js'
import { sendAddedToProjectMail, sendDeletedMail, sendRemovedFromProjectMail } from '../lib/mails.js'
import { companyLlm } from '../lib/llm.js'
import { stripMentions } from '../lib/notify.js'
import { profilesForProject } from '../lib/job-title.js'
import { s3Client, s3Bucket, getObjectStream, deleteObject, isCustomStorage, resolveStorage, S3_KEY_PREFIX } from '../lib/s3.js'

/**
 * Логотипы проектов — публично, ДО проверки сессии: <img> не умеет слать
 * заголовок авторизации, и под общей проверкой картинка отдавала 401.
 * Так же решены аватары и логотипы компаний.
 */
export const projectLogoRoute = new Hono()

projectLogoRoute.get('/:projectId/logo', async (c) => {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, c.req.param('projectId')) })
  if (!project?.logoKey) return c.json({ error: 'Not found' }, 404)
  try {
    const { body, contentType } = await getObjectStream(
      { client: s3Client(), bucket: s3Bucket(), keyPrefix: S3_KEY_PREFIX, isCustom: false, publicUrl: null },
      project.logoKey,
    )
    c.header('Content-Type', contentType || 'image/webp')
    c.header('Cache-Control', 'public, max-age=86400')
    const { Readable } = await import('node:stream')
    return c.body(Readable.toWeb(body) as ReadableStream)
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
})

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
  autoPostTaskEvents: z.boolean().default(false),
})

/**
 * Настройки учёта времени (SPEC §8.36).
 *
 * Один валидатор на компанию и на проект: настройки живут на компании, а
 * проектное поле осталось под возможное переопределение. Разъехавшись, эти два
 * места приняли бы разные значения одного и того же.
 *
 * Рабочие часы — минуты от полуночи: 9:00 = 540. Так их не надо разбирать из
 * строки при каждом сравнении, а часовой пояс к ним отношения не имеет — это
 * распорядок дня, а не момент времени.
 */
export const timeConfigSchema = z.object({
  maxTimers: z.number().int().min(1).max(20),
  idleAction: z.enum(['remind', 'stop']),
  idleHours: z.number().int().min(1).max(48),
  repeatHours: z.number().int().min(1).max(48),
  country: z.string().max(2),
  timezone: z.string().max(64),
  weekStart: z.number().int().min(0).max(6),
  translate: z.boolean(),
  workDayStart: z.number().int().min(0).max(24 * 60),
  workDayEnd: z.number().int().min(0).max(24 * 60),
})

// SPEC §4.3 / §8: доменная модель прав. Каждый домен получает УРОВЕНЬ доступа,
// а конкретные булевы действия (tasks.create и т.п.) выводятся из уровня.
// Это питает и ручной CRUD, и ИИ-инструменты (Фаза 10) — единая проверка.
/**
 * Палитра для случайного цвета нового проекта. Тона подобраны так, чтобы белая
 * буква на них читалась и в светлой, и в тёмной теме.
 */
export const PROJECT_COLORS = [
  '#6366f1', // indigo
  '#0ea5e9', // sky
  '#14b8a6', // teal
  '#22c55e', // green
  '#eab308', // yellow
  '#f97316', // orange
  '#ef4444', // red
  '#ec4899', // pink
  '#a855f7', // purple
  '#64748b', // slate
] as const

export const PERMISSION_DOMAINS = ['tasks', 'files', 'resources', 'documents', 'notes', 'releases'] as const
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
  'releases.read', // видеть вкладку и сводку «что сейчас в проде»
  'releases.manage', // заводить версии и двигать стадии
  // legacy-алиасы (совместимость со старым кодом/данными)
  'credentials.read',
  'credentials.manage',
] as const
export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number]

// действие → [домен, минимальный уровень]
const ACTION_REQUIREMENT: Record<ProjectPermission, [PermissionDomain, PermissionLevel]> = {
  'releases.read': ['releases', 'read'],
  'releases.manage': ['releases', 'write'],
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
/**
 * Схема собирается ИЗ списка доменов, а не повторяет его руками.
 *
 * Ровно на этом уже споткнулись: домен releases появился в PERMISSION_DOMAINS
 * и в правах по умолчанию, а здесь его забыли — zod молча выбрасывал
 * незнакомое поле, ручка отвечала ok:true, и уровень не менялся. Сбой без
 * единой ошибки: интерфейс показывал успех, база оставалась прежней.
 */
const domainPermissionsSchema = z.object(
  Object.fromEntries(PERMISSION_DOMAINS.map((d) => [d, levelSchema])) as Record<PermissionDomain, typeof levelSchema>,
)
// PATCH принимает частичный набор доменных уровней
const permissionsSchema = domainPermissionsSchema.partial()

export function defaultDomainPermissions(role: 'owner' | 'admin' | 'member'): DomainPermissions {
  // Заметки участник пишет наравне с документами: журнал ценен, только если
  // его ведут все, кто видит проблему, а не один админ.
  // Участник — полноценный член команды, а не гость: он заводит задачи,
  // пишет документы и заметки. Прежнее tasks: 'read' означало, что человек не
  // может создать задачу даже себе, хотя ИИ в чате делает это от его имени.
  //
  // Уровень write даёт править ЛЮБУЮ задачу проекта; ограничение «чужое не
  // трогать» живёт отдельно, в canManageOwn: право и владение — разные вещи.
  //
  // ЗАПИСЬ во всех областях, включая ресурсы и версии.
  //
  // Раньше ресурсы и версии стояли на чтении: «секреты заводит начальство»,
  // «выкатка — ответственность». На деле это упиралось в того же человека,
  // который и делает работу: разработчик, добавивший интеграцию, не мог
  // записать её ключ и шёл просить админа. Просьба — не защита, а задержка:
  // ключ всё равно появится, просто позже и чужими руками.
  //
  // Удаление по-прежнему за админами (crud), и это настоящая граница: стереть
  // чужой секрет или релиз необратимо, а создать — нет.
  //
  // Кому нужно иначе, ставит уровни руками: они на то и есть.
  if (role === 'member')
    return { tasks: 'write', files: 'write', resources: 'write', documents: 'write', notes: 'write', releases: 'write' }
  return { tasks: 'crud', files: 'crud', resources: 'crud', documents: 'crud', notes: 'crud', releases: 'crud' }
}

/**
 * Может ли человек распоряжаться конкретной сущностью, а не просто «сущностями
 * такого рода».
 *
 * Разделение простое: со СВОИМ — созданным им или назначенным на него — он
 * делает что угодно; чужое читает и, для задач, переводит по статусам.
 * Владельцы и админы проекта не ограничены ничем.
 *
 * Без этого правила приходилось выбирать между «участник ничего не может» и
 * «любой переписывает чужую задачу», и оба варианта плохи.
 */
export async function ownsOrManages(
  projectId: string,
  userId: string,
  owners: (string | null | undefined)[],
): Promise<boolean> {
  if (owners.some((o) => o && o === userId)) return true
  const m = await projectRoleOf(projectId, userId)
  return m?.role === 'owner' || m?.role === 'admin'
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
export function resolveDomains(role: 'owner' | 'admin' | 'member', raw: string | null): DomainPermissions {
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

export async function companyRoleOf(companyId: string, userId: string) {
  const m = await db.query.companyMembers.findFirst({
    where: and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId)),
  })
  return m?.role ?? null
}

export const canCreateProjects = (role: string | null) => role === 'admin' || role === 'manager'

// Список проектов компании, где юзер участник (или все — для admin/manager)
projectsRoute.get(
  '/',
  zValidator(
    'query',
    z.object({
      companyId: z.string().min(1),
      /**
       * Показать архив вместо живых проектов.
       *
       * Именно вместо, а не вдобавок: список один и кормит сайдбар, дашборд и
       * переключатель проектов. Подмешивать туда законченные значило бы
       * вернуть ровно ту кашу, из-за которой архив и понадобился.
       */
      archived: z.enum(['1']).optional(),
    }),
  ),
  async (c) => {
  const { sub } = c.get('session')
  const { companyId, archived } = c.req.valid('query')
  const role = await companyRoleOf(companyId, sub)
  if (!role) return c.json({ error: 'Forbidden' }, 403)

  const all = await db.query.projects.findMany({
    where: and(
      eq(projects.companyId, companyId),
      archived === '1' ? isNotNull(projects.archivedAt) : isNull(projects.archivedAt),
    ),
  })
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
        verified: sql<number>`count(*) filter (where ${tasks.status} = 'verified')::int`,
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
    // Объявления компании проекта не имеют — в счётчик по проектам не идут.
    for (const r of notifRows) if (r.projectId) unread.set(r.projectId, r.count)

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
        // в превью показываем «@Имя», а не разметку редактора
        text: stripMentions(r.text ?? '').slice(0, 140),
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
      color: p.color,
      logoUrl: p.logoUrl,
      chatRules: p.chatRules,
      isMember: myByProject.has(p.id),
      myRole: myByProject.get(p.id)?.role ?? null,
      // Список запрашивается либо живой, либо архивный, но признак нужен
      // самой карточке: по нему она решает, что предложить — убрать или вернуть.
      archived: Boolean(p.archivedAt),
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

    // Компания решила, что проекты приходят только из внешней системы.
    // Проверяем на сервере, а не прячем кнопку: иначе проект всё равно можно
    // создать запросом, и списки разъедутся молча.
    const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) })
    if (company?.projectsViaApiOnly) {
      return c.json(
        {
          error: 'Projects are created in the external system',
          hint: `Create it in ${company.externalSystemName || 'your system'} — it will appear here automatically.`,
        },
        403,
      )
    }
    if (await projectNameTaken(companyId, name)) {
      return c.json({ error: 'A project with this name already exists in this company', field: 'name' }, 409)
    }

    const slug = `${name.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project'}-${nanoid(6)}`
    const [project] = await db
      .insert(projects)
      .values({
        companyId,
        name,
        about,
        slug,
        chatRules,
        // Язык не прислали — берём у компании, а не оставляем умолчание.
        // Интерфейс его передаёт, но любой другой вызывающий (мост, скрипт,
        // интеграция) о поле не знает, и проект молча заводился английским.
        aiConfig: JSON.stringify({ language: company?.locale || 'en', ...aiConfig }),
        // цвет раздаём сразу: в свёрнутом сайдбаре проекты различают по нему,
        // и заставлять человека выбирать его вручную незачем
        color: PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)]!,
      })
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

/**
 * Занято ли название проекта в этой компании.
 *
 * Люди в компании общие, и два «Редизайна» превращают любую просьбу «сделай в
 * Редизайне» в загадку — особенно для ИИ, который выбирает проект по названию
 * из разговора. В базе есть уникальный индекс; эта проверка нужна, чтобы
 * человек получил внятный ответ, а не ошибку постгреса.
 */
export async function projectNameTaken(companyId: string, name: string, exceptId?: string): Promise<boolean> {
  const rows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.companyId, companyId))
  const needle = name.trim().toLowerCase()
  return rows.some((p) => p.name.trim().toLowerCase() === needle && p.id !== exceptId)
}

export async function projectRoleOf(projectId: string, userId: string) {
  const m = await db.query.projectMembers.findFirst({
    where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)),
  })
  return m ?? null
}

// Детали проекта (участник или company admin/manager)
/**
 * Что включено в проекте. Читают все участники: интерфейс по этому списку
 * решает, показывать ли вкладку.
 */
projectsRoute.get('/:projectId/features', async (c) => {
  const { sub } = c.get('session')
  const projectId = c.req.param('projectId')
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return c.json({ error: 'Not found' }, 404)

  const membership = await projectRoleOf(projectId, sub)
  const companyRole = await companyRoleOf(project.companyId, sub)
  if (!membership && !canCreateProjects(companyRole)) return c.json({ error: 'Forbidden' }, 403)

  const { enabledFeatures } = await import('../lib/features.js')
  // canManage отдаём отдельно: список бывает пустым ровно тогда, когда кнопка
  // и нужна, и по одному списку интерфейс не понял бы, показывать ли тумблер.
  const canManage =
    membership?.role === 'owner' || membership?.role === 'admin' || canCreateProjects(companyRole)
  return c.json({ features: await enabledFeatures(projectId), canManage })
})

/** Включить или выключить функцию. Решение о составе проекта — за его начальством. */
projectsRoute.post('/:projectId/features', async (c) => {
  const { sub } = c.get('session')
  const projectId = c.req.param('projectId')
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return c.json({ error: 'Not found' }, 404)

  // Та же тройка, что и везде: начальство проекта либо админ компании —
  // роль в проекте не вся правда о человеке.
  const membership = await projectRoleOf(projectId, sub)
  const companyRole = await companyRoleOf(project.companyId, sub)
  const allowed = membership?.role === 'owner' || membership?.role === 'admin' || canCreateProjects(companyRole)
  if (!allowed) return c.json({ error: 'Only project owners and admins can change features' }, 403)

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const feature = String(body.feature ?? '')
  if (feature !== 'releases') return c.json({ error: 'Unknown feature' }, 400)

  const { setFeature, enabledFeatures } = await import('../lib/features.js')
  await setFeature(projectId, 'releases', body.enabled === true, sub)
  return c.json({ features: await enabledFeatures(projectId) })
})

projectsRoute.get('/:projectId', async (c) => {
  const { sub } = c.get('session')
  const projectId = c.req.param('projectId')
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return c.json({ error: 'Not found' }, 404)

  const membership = await projectRoleOf(projectId, sub)
  const companyRole = await companyRoleOf(project.companyId, sub)
  if (!membership && !canCreateProjects(companyRole)) return c.json({ error: 'Forbidden' }, 403)

  // Обратная ссылка «во внешнюю систему» — собираем здесь, а не на клиенте:
  // шаблон живёт у компании, и тянуть её ради этого отдельным запросом было бы
  // лишним. Ссылки нет, если интеграция не настроена или у проекта нет
  // внешнего идентификатора — вести в никуда хуже, чем не показывать кнопку.
  const company = await db.query.companies.findFirst({ where: eq(companies.id, project.companyId) })
  const externalLink =
    company?.externalProjectUrl && project.externalId
      ? {
          name: company.externalSystemName || 'External system',
          url: company.externalProjectUrl.replace('{externalId}', encodeURIComponent(project.externalId)),
        }
      : null

  return c.json({
    ...project,
    aiConfig: JSON.parse(project.aiConfig || '{}'),
    myRole: membership?.role ?? null,
    rulesAccepted: Boolean(membership?.rulesAcceptedAt),
    // Состав ведётся снаружи — интерфейсу нужно знать, чтобы не показывать
    // кнопки, на которые сервер всё равно ответит отказом (SPEC §8.42).
    membersViaApiOnly: Boolean(company?.membersViaApiOnly),
    externalLink,
  })
})

/**
 * Сводка проекта: план, факт, срок.
 *
 * Считается на сервере, а не на клиенте, по одной причине: часы из трекера
 * клиенту целиком не отдаются. Непривилегированный участник видит только свои
 * записи, а «сколько всего наработано в проекте» — это сумма по всем, и
 * собрать её из того, что ему видно, нельзя.
 *
 * Ничего не прогнозируем. Только четыре числа и дата: сколько запланировано,
 * сколько из этого уже закрыто, сколько осталось и сколько ушло на самом деле.
 * Задачи без оценки в суммы не входят — их отдаём отдельным счётчиком, чтобы
 * «осталось 12 часов» не читалось как «осталось всего ничего», когда рядом
 * висят семь задач, которые никто не оценивал.
 */
projectsRoute.get('/:projectId/summary', async (c) => {
  const { sub } = c.get('session')
  const projectId = c.req.param('projectId')
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return c.json({ error: 'Not found' }, 404)

  const membership = await projectRoleOf(projectId, sub)
  const companyRole = await companyRoleOf(project.companyId, sub)
  if (!membership && !canCreateProjects(companyRole)) return c.json({ error: 'Forbidden' }, 403)

  // estimate_minutes хранится строкой — приводим в SQL, иначе sum() сложит
  // текст и упадёт. Пустая строка и мусор дают NULL и в сумму не попадают.
  const est = sql<number>`coalesce(sum(nullif(${tasks.estimateMinutes}, '')::int), 0)::int`
  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      done: sql<number>`count(*) filter (where ${tasks.status} = 'done')::int`,
      planned: est,
      plannedDone: sql<number>`coalesce(sum(nullif(${tasks.estimateMinutes}, '')::int) filter (where ${tasks.status} = 'done'), 0)::int`,
      noEstimate: sql<number>`count(*) filter (where ${tasks.estimateMinutes} is null or ${tasks.estimateMinutes} = '')::int`,
      noEstimateOpen: sql<number>`count(*) filter (where (${tasks.estimateMinutes} is null or ${tasks.estimateMinutes} = '') and ${tasks.status} <> 'done')::int`,
    })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)))

  // Идущие таймеры не считаем: у них нет конца, и «потрачено» скакало бы от
  // запроса к запросу.
  const [spent] = await db
    .select({
      minutes: sql<number>`coalesce(sum(extract(epoch from (${timeEntries.endedAt} - ${timeEntries.startedAt})) / 60), 0)::int`,
    })
    .from(timeEntries)
    .where(and(eq(timeEntries.projectId, projectId), sql`${timeEntries.endedAt} is not null`))

  const planned = totals?.planned ?? 0
  const plannedDone = totals?.plannedDone ?? 0
  return c.json({
    deadline: project.deadline,
    tasks: {
      total: totals?.total ?? 0,
      done: totals?.done ?? 0,
      noEstimate: totals?.noEstimate ?? 0,
      noEstimateOpen: totals?.noEstimateOpen ?? 0,
    },
    minutes: {
      planned,
      plannedDone,
      // Остаток по оценкам открытых задач, а не «план минус факт»: переработка
      // по одной задаче не уменьшает того, что осталось сделать по другим.
      plannedLeft: planned - plannedDone,
      spent: spent?.minutes ?? 0,
    },
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
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      timeConfig: timeConfigSchema.partial().optional(),
      // Срок сдачи: дата или null — «срока нет». Пустая строка сюда не
      // приходит: её от «не трогать» уже не отличить.
      deadline: z.string().datetime({ offset: true }).nullable().optional(),
      storageLimit: z.number().int().min(0).nullable().optional(), // байты; null = наследовать компанию, 0 = без override (безлимит в рамках компании)
      // Язык проекта для писем. null = наследовать компанию: команда одного
      // проекта может говорить не на языке всей фирмы.
      locale: z.enum(['en', 'ru', 'he']).nullable().optional(),
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

    const { name, about, aiConfig, chatRules, color, timeConfig, storageLimit, locale, deadline } = c.req.valid('json')
    const patch: Record<string, unknown> = {}
    if (name !== undefined) patch.name = name
    if (deadline !== undefined) patch.deadline = deadline ? new Date(deadline) : null
    if (about !== undefined) patch.about = about
    if (chatRules !== undefined) patch.chatRules = chatRules
    if (color !== undefined) patch.color = color
    // null — осознанный выбор «как в компании», а не «не трогать».
    if (locale !== undefined) patch.locale = locale
    if (timeConfig !== undefined) {
      const current = JSON.parse(project.timeConfig || '{}')
      patch.timeConfig = JSON.stringify({ ...current, ...timeConfig })
    }
    if (storageLimit !== undefined) {
      // Выше бесплатного пула компании ставить нечего: эффективный лимит всё
      // равно считается как минимум из проектного и остатка компании, а
      // цифра «50 ГБ» в настройках была бы обещанием, которого никто не даёт.
      // На своём хранилище лимит вообще не применяется — там платит клиент.
      const custom = await isCustomStorage(projectId)
      const capped =
        storageLimit === null || custom ? storageLimit : Math.min(storageLimit, FREE_STORAGE_BYTES)
      patch.storageLimit = capped === null ? null : String(capped)
    }
    if (aiConfig !== undefined) {
      const current = JSON.parse(project.aiConfig || '{}')
      patch.aiConfig = JSON.stringify({ ...current, ...aiConfig })
    }

    if (typeof patch.name === 'string' && (await projectNameTaken(project.companyId, patch.name, projectId))) {
      return c.json({ error: 'A project with this name already exists in this company', field: 'name' }, 409)
    }

    const [updated] = await db.update(projects).set(patch).where(eq(projects.id, projectId)).returning()
    return c.json({ ...updated, aiConfig: JSON.parse(updated!.aiConfig || '{}') })
  },
)

// POST /:projectId/logo — логотип проекта (webp, приватный бакет; раздаём
// через GET /:projectId/logo). В свёрнутом сайдбаре он заменяет букву.
projectsRoute.post('/:projectId/logo', async (c) => {
  const { sub } = c.get('session')
  const projectId = c.req.param('projectId')
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return c.json({ error: 'Not found' }, 404)

  const membership = await projectRoleOf(projectId, sub)
  const companyRole = await companyRoleOf(project.companyId, sub)
  if (!(membership?.role === 'owner' || membership?.role === 'admin' || companyRole === 'admin')) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const body = await c.req.parseBody()
  const file = body['file']
  if (!(file instanceof File)) return c.json({ error: 'file field is required' }, 400)
  if (file.size > 5 * 1024 * 1024) return c.json({ error: 'File too large (max 5MB)' }, 413)

  try {
    const buffer = await sharp(Buffer.from(await file.arrayBuffer()), { failOn: 'none' })
      .rotate()
      .resize(256, 256, { fit: 'cover' })
      .webp({ quality: 85 })
      .toBuffer()
    const key = `${S3_KEY_PREFIX}/project-logos/${projectId}-${nanoid(6)}.webp`
    await s3Client().send(new PutObjectCommand({ Bucket: s3Bucket(), Key: key, Body: buffer, ContentType: 'image/webp' }))
    // версия в URL, чтобы кэш не отдавал старый логотип после замены
    const url = `${process.env.API_PUBLIC_URL || 'https://api.chatick.com'}/api/v1/projects/${projectId}/logo?v=${Date.now()}`
    await db.update(projects).set({ logoUrl: url, logoKey: key }).where(eq(projects.id, projectId))
    return c.json({ logoUrl: url })
  } catch (e) {
    console.error('[project logo] upload failed:', e)
    return c.json({ error: 'Failed to process image' }, 500)
  }
})

// Отдача логотипа. Публично по id: логотип не секрет, а требовать токен —
// значит не показать его в <img> без ухищрений.

projectsRoute.delete('/:projectId/logo', async (c) => {
  const { sub } = c.get('session')
  const projectId = c.req.param('projectId')
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return c.json({ error: 'Not found' }, 404)
  const membership = await projectRoleOf(projectId, sub)
  const companyRole = await companyRoleOf(project.companyId, sub)
  if (!(membership?.role === 'owner' || membership?.role === 'admin' || companyRole === 'admin')) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await db.update(projects).set({ logoUrl: null, logoKey: null }).where(eq(projects.id, projectId))
  return c.json({ ok: true })
})

/**
 * Удаление проекта (SPEC §4.2).
 *
 * Необратимо и уносит всё: задачи, переписку, документы, заметки, историю
 * времени и файлы. Поэтому три рубежа:
 *   1. только владелец проекта или админ компании;
 *   2. подтверждение вводом названия (проверяем и на сервере — клиент можно
 *      обойти);
 *   3. файлы вычищаются из хранилища, иначе они переживут проект и продолжат
 *      занимать место.
 *
 * Ассистенту через мост эта операция НЕ доступна намеренно.
 */
/**
 * Кто распоряжается архивом: начальство проекта либо админ компании.
 *
 * Та же тройка, что и у правки настроек проекта. Архив обратим, но список
 * проектов — общий, и убирать оттуда чужую работу рядовой участник не должен.
 */
async function mayArchive(projectId: string, userId: string): Promise<{ ok: false; status: 403 | 404 } | { ok: true; project: typeof projects.$inferSelect }> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return { ok: false, status: 404 }
  const membership = await projectRoleOf(projectId, userId)
  const companyRole = await companyRoleOf(project.companyId, userId)
  const allowed = membership?.role === 'owner' || membership?.role === 'admin' || canCreateProjects(companyRole)
  return allowed ? { ok: true, project } : { ok: false, status: 403 }
}

/**
 * Убрать проект с глаз. Ничего не удаляет.
 *
 * Задачи, переписка, файлы и часы остаются нетронутыми — проект просто
 * перестаёт занимать место там, где смотрят на текущую работу. Открыть его
 * по прямой ссылке можно как раньше.
 */
projectsRoute.post('/:projectId/archive', async (c) => {
  const { sub } = c.get('session')
  const projectId = c.req.param('projectId')
  const check = await mayArchive(projectId, sub)
  if (!check.ok) return c.json({ error: check.status === 404 ? 'Not found' : 'Forbidden' }, check.status)

  // Повторный вызов не сдвигает дату: «когда убрали» — это факт, и
  // переписывать его вторым нажатием незачем.
  if (!check.project.archivedAt) {
    await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, projectId))
  }
  await logActivity({
    projectId,
    actorId: sub,
    action: 'update',
    entityType: 'project',
    entityId: projectId,
    entityLabel: check.project.name,
    meta: { archived: true },
  })
  return c.json({ ok: true, archived: true })
})

/** Вернуть проект в работу. */
projectsRoute.delete('/:projectId/archive', async (c) => {
  const { sub } = c.get('session')
  const projectId = c.req.param('projectId')
  const check = await mayArchive(projectId, sub)
  if (!check.ok) return c.json({ error: check.status === 404 ? 'Not found' : 'Forbidden' }, check.status)

  await db.update(projects).set({ archivedAt: null }).where(eq(projects.id, projectId))
  await logActivity({
    projectId,
    actorId: sub,
    action: 'update',
    entityType: 'project',
    entityId: projectId,
    entityLabel: check.project.name,
    meta: { archived: false },
  })
  return c.json({ ok: true, archived: false })
})

projectsRoute.delete('/:projectId', async (c) => {
  const { sub } = c.get('session')
  const projectId = c.req.param('projectId')

  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return c.json({ error: 'Not found' }, 404)

  const membership = await projectRoleOf(projectId, sub)
  const companyRole = await companyRoleOf(project.companyId, sub)
  if (!(membership?.role === 'owner' || companyRole === 'admin')) {
    return c.json({ error: 'Only the project owner or a company admin can delete a project' }, 403)
  }

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  if (typeof body.confirm !== 'string' || body.confirm.trim() !== project.name) {
    return c.json({ error: 'Confirmation does not match the project name', expected: project.name }, 400)
  }

  // Список участников собираем ДО удаления: после каскада писать будет некому.
  // Себя исключаем — тот, кто удалил, и так знает.
  const recipients = await db
    .select({ email: users.email, locale: users.locale })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(and(eq(projectMembers.projectId, projectId), sql`${projectMembers.userId} <> ${sub}`))
  const actor = await db.query.users.findFirst({ where: eq(users.id, sub) })

  // Сначала файлы: если упадём на них, проект ещё цел и можно повторить.
  // Наоборот — остались бы объекты, к которым уже никто не знает пути.
  const rows = await db.select({ key: files.key, originalKey: files.originalKey }).from(files).where(eq(files.projectId, projectId))
  if (rows.length) {
    try {
      const store = await resolveStorage(projectId)
      for (const r of rows) {
        for (const key of [r.key, r.originalKey].filter(Boolean) as string[]) {
          await deleteObject(store, key).catch(() => {
            // один непослушный объект не должен блокировать удаление проекта
          })
        }
      }
    } catch (err) {
      console.error('[projects] storage cleanup failed:', err)
    }
  }

  // Остальное уносит каскад: 24 таблицы ссылаются на проект с on delete cascade.
  await db.delete(projects).where(eq(projects.id, projectId))

  // Письма в фоне: ответ не должен ждать почтовый сервер.
  for (const r of recipients) {
    void sendDeletedMail({
      to: r.email,
      locale: r.locale,
      kind: 'project',
      name: project.name,
      actorName: actor?.name || actor?.email || '—',
    })
  }

  return c.json({ ok: true, deletedFiles: rows.length, notified: recipients.length })
})

// Участники проекта
/**
 * Приглашённые в этот проект, но ещё не принявшие.
 *
 * Отдельной ручкой, а не в списке участников: тот отдаёт строки таблицы
 * участников, у приглашённого её ещё нет — он существует только как адрес
 * почты. Смешивать их в одном ответе значило бы выдумывать половину полей.
 *
 * Без этого списка приглашение выглядело как «ничего не произошло»:
 * человек нажал «пригласить», а команда осталась прежней.
 */
projectsRoute.get('/:projectId/invites', async (c) => {
  const { sub } = c.get('session')
  const projectId = c.req.param('projectId')
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return c.json({ error: 'Not found' }, 404)
  const membership = await projectRoleOf(projectId, sub)
  if (!membership && !canCreateProjects(await companyRoleOf(project.companyId, sub)))
    return c.json({ error: 'Forbidden' }, 403)

  const rows = await db
    .select({ id: companyInvites.id, email: companyInvites.email, role: companyInvites.role, createdAt: companyInvites.createdAt })
    .from(companyInvites)
    .where(
      and(
        eq(companyInvites.projectId, projectId),
        eq(companyInvites.status, 'pending'),
      ),
    )
  return c.json(rows)
})

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
  /**
   * Должность — РАЗРЕШЁННАЯ, с наследованием от компании.
   *
   * Читали сырое поле проекта, и список показывал пусто у всех, кому
   * должность задали на уровне компании. Ассистент при этом её знал: мост и
   * контекст ИИ давно зовут profilesForProject. Одни и те же данные,
   * разный ответ — а человек видит «не сохранилось» и вбивает должность
   * заново, уже в проект. С этого мгновения наследование для него мертво:
   * проектное значение сильнее, и смена в компании его больше не догонит.
   *
   * ownJobTitle отдаём отдельно — это то, что записано у САМОГО проекта.
   * Форме правки нужно именно оно: подставив унаследованное, она сохранила
   * бы его как собственное и оборвала наследование тем же способом, только
   * руками человека, который ничего не менял.
   */
  const profiles = await profilesForProject(projectId)
  return c.json(
    rows.map((r) => {
      const domains = resolveDomains(r.role, r.permissions)
      const profile = profiles.get(r.user.id)
      return {
        id: r.id,
        role: r.role,
        domains, // {tasks,files,resources}: уровень — основной формат для UI
        permissions: expandPermissions(domains), // плоские булевы — совместимость
        jobTitle: profile?.jobTitle || '',
        responsibility: profile?.responsibility || '',
        ownJobTitle: r.jobTitle,
        ownResponsibility: r.responsibility,
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

// Роль участника в проекте — owner/admin проекта или company admin.
// Раньше роль назначалась один раз, при добавлении, и больше не менялась:
// чтобы сделать человека админом, его приходилось исключать и звать заново,
// теряя должность и зону ответственности.
projectsRoute.patch(
  '/:projectId/members/:userId/role',
  zValidator('json', z.object({ role: z.enum(['admin', 'member']) })),
  async (c) => {
    const { sub } = c.get('session')
    const { projectId, userId } = c.req.param()
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
    if (!project) return c.json({ error: 'Not found' }, 404)

    const me = await projectRoleOf(projectId, sub)
    const companyRole = await companyRoleOf(project.companyId, sub)
    if (!(me?.role === 'owner' || me?.role === 'admin' || companyRole === 'admin')) {
      return c.json({ error: 'Forbidden' }, 403)
    }


    const target = await projectRoleOf(projectId, userId)
    if (!target) return c.json({ error: 'Not a project member' }, 404)

    // Владелец — это тот, кто завёл проект; роль не передаётся и не снимается,
    // иначе проект может остаться без хозяина.
    if (target.role === 'owner') return c.json({ error: 'Project owner role cannot be changed' }, 400)

    const { role } = c.req.valid('json')
    if (role === target.role) return c.json({ ok: true, role })

    // Персональные права сбрасываем на умолчания новой роли. Иначе понижение
    // выходит показным: ярлык сменился, а выставленные вручную crud-уровни
    // остались, и человек по-прежнему всё удаляет.
    await db
      .update(projectMembers)
      .set({ role, permissions: JSON.stringify(defaultDomainPermissions(role)) })
      .where(eq(projectMembers.id, target.id))

    await logActivity({
      projectId,
      actorId: sub,
      action: 'update',
      entityType: 'member',
      entityId: userId,
      entityLabel: role === 'admin' ? 'назначен админом проекта' : 'переведён в участники',
    })

    return c.json({ ok: true, role, domains: defaultDomainPermissions(role) })
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
    // Состав команды ведётся во внешней системе — правка запрещена (SPEC §8.42).
    if (await membersLockedForProject(projectId)) return c.json(MEMBERS_LOCKED, 403)
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

  // Состав команды ведётся во внешней системе (SPEC §8.42).
  if (project.companyId && (await membersLockedForCompany(project.companyId))) return c.json(MEMBERS_LOCKED, 403)

  const me = await projectRoleOf(projectId, sub)
  const companyRole = await companyRoleOf(project.companyId, sub)
  const allowed = me?.role === 'owner' || me?.role === 'admin' || canCreateProjects(companyRole)
  if (!allowed) return c.json({ error: 'Forbidden' }, 403)

  /**
   * Владельца проекта убрать нельзя.
   *
   * У каждого проекта он ровно один, и во многих он единственное
   * начальство: удалив его, проект остаётся без того, кто может вернуть
   * людей и раздать права. Мост это уже запрещал при смене роли, а здесь
   * дыра оставалась открытой.
   */
  const victim = await projectRoleOf(projectId, userId)
  if (victim?.role === 'owner') return c.json({ error: 'Project owner cannot be removed' }, 400)

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
  if (llm) return c.json({ configured: true, source: 'company', companyId: project.companyId })

  // Пробный ИИ — тоже рабочий ИИ. Раньше здесь отвечали «не настроен», и
  // человек видел заглушку с просьбой подключить ключ, хотя чат работал.
  // Умолчание — пробный, как и в projectLlm: настройка и действительность
  // должны совпадать, иначе заглушка врёт про рабочий чат.
  const ai = await db.query.projectAi.findFirst({ where: eq(projectAi.projectId, projectId) })
  const source = ai?.source ?? 'trial'
  if (source === 'trial' && env.AI_TRIAL_KEY) {
    const spent = await companyTrialSpendUsd(project.companyId)
    if (spent < env.AI_TRIAL_BUDGET_USD) {
      return c.json({
        configured: true,
        source: 'trial',
        companyId: project.companyId,
        trialSpent: spent,
        trialBudget: env.AI_TRIAL_BUDGET_USD,
      })
    }
    // Бюджет исчерпан — это отдельный случай: не «настройте ИИ», а
    // «пробный кончился». Разница важна: человек уже видел, как это работает.
    return c.json({
      configured: false,
      source: 'trial_exhausted',
      companyId: project.companyId,
      trialSpent: spent,
      trialBudget: env.AI_TRIAL_BUDGET_USD,
    })
  }

  return c.json({ configured: false, source: 'none', companyId: project.companyId })
})

// --- Хранилище проекта (SPEC §8.10) — только owner/admin проекта / company admin ---

/**
 * Разорвать связь с внешней системой изнутри Chatick (SPEC §8.46).
 *
 * Снаружи это умеет DELETE /ext/projects/:externalId, но у человека внутри
 * такой возможности не было вовсе: связь создавалась снаружи и снаружи же
 * только и рвалась. Если доступ к той системе потерян — например, интеграцию
 * отключили, — проект оставался помеченным навсегда.
 *
 * Содержимое не трогаем: уходит только пометка о чужой системе.
 */
projectsRoute.post('/:projectId/unlink-external', async (c) => {
  const { sub } = c.get('session')
  const projectId = c.req.param('projectId')
  if (!(await canManageProject(projectId, sub))) return c.json({ error: 'Forbidden' }, 403)

  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return c.json({ error: 'Not found' }, 404)
  if (!project.externalId) return c.json({ error: 'This project is not linked to an external system' }, 400)

  await db.update(projects).set({ externalId: null, externalName: null }).where(eq(projects.id, projectId))

  void logActivity({
    projectId,
    actorId: sub,
    action: 'update',
    entityType: 'project',
    entityId: projectId,
    entityLabel: `unlinked from external system (${project.externalId})`,
  })
  return c.json({ ok: true })
})

async function canManageProject(projectId: string, userId: string): Promise<boolean> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return false
  const me = await projectRoleOf(projectId, userId)
  const companyRole = await companyRoleOf(project.companyId, userId)
  return me?.role === 'owner' || me?.role === 'admin' || companyRole === 'admin'
}

// Конфиг хранилища — БЕЗ ключей (метаданные + флаг «ключи заданы»)
// Хранилище настраивается на КОМПАНИИ (SPEC §8.47), а не на проекте.
//
// Уровень проекта убран намеренно: два места с одинаковыми полями и неочевидным
// приоритетом расходились — часть проектов оказывалась в одном бакете, часть в
// другом, и найти файл становилось нечем. Компания одна на всех, и настройка
// у неё одна.

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
