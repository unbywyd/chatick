import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../db/client.js'
import { companies, companyMembers, HANDOFF_ACTIONS, notifications, projectMembers, projects, taskHandoffs, tasks, TASK_MOVES, users } from '../db/schema.js'
import { requireSession, type SessionEnv } from '../auth.js'
import { hasPermission, ownsOrManages, projectRoleOf } from './projects.js'
import { insertTask, lastReviewFrom, mayHandoff, ownerOf, planHandoff, setOnTable, TABLE_LIMIT, type Via } from '../lib/ball.js'
import { closedSql, isClosed } from '../lib/task-status.js'
import { matchPerson, matchProject, parseQuick, type Match } from '../lib/quick-task.js'
import { notifyTask } from './tasks.js'
import { postTaskAssigned } from '../lib/task-events.js'
import { logActivity } from '../lib/audit.js'
import { tasksChanged } from '../ws.js'

/**
 * Списки мяча (v2) — главный экран: «На столе», «На мне», «От меня».
 *
 * По всей компании сразу, на session-токене: человек думает не проектами, а
 * «что ждут от меня» и «что я жду от других». Обходить проекты по одному
 * клиенту пришлось бы десятки раз.
 *
 * Права не ослабляем: только проекты, где человек СОСТОИТ, и только задачи, где
 * он держатель или владелец. Архивные проекты не в счёт — их убрали с глаз,
 * чтобы не разбавляли текущую работу.
 *
 * Фильтры, сортировка и группы — здесь, а не на клиенте: список приходит
 * готовым, и у веба, трея и MCP он один и тот же.
 */
export const ballRoute = new Hono<SessionEnv>()
ballRoute.use('*', requireSession)

const owner = alias(users, 'owner')
const holder = alias(users, 'holder')

/**
 * Проекты, где человек состоит: в компании, или во всех (companyId = null —
 * мастер-подключение моста). Архивные не в счёт.
 */
export async function myProjects(companyId: string | null, userId: string) {
  return db
    .select({ id: projects.id, name: projects.name, color: projects.color, logoUrl: projects.logoUrl, companyId: projects.companyId })
    .from(projects)
    .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
    .where(
      and(
        ...(companyId ? [eq(projects.companyId, companyId)] : []),
        eq(projectMembers.userId, userId),
        isNull(projects.archivedAt),
      ),
    )
}
export type ProjectList = Awaited<ReturnType<typeof myProjects>>

export const listFilters = z.object({
  project: z.string().optional(),
  move: z.enum(TASK_MOVES).optional(),
  /** held — дольше всех у держателя сверху; due — по сроку; priority; created — новые сверху. */
  sort: z.enum(['held', 'due', 'priority', 'created']).optional(),
  group: z.enum(['move', 'project', 'holder', 'owner']).optional(),
})
export type ListQuery = z.infer<typeof listFilters>
const listQuery = listFilters.extend({ companyId: z.string().min(1) })

const PRIORITY_RANK = sql`case ${tasks.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`
/** Вопрос ждёт ответа — первым: на нём стоит чужая работа. Потом проверка, потом дело. */
const MOVE_RANK = sql`case ${tasks.move} when 'answer' then 0 when 'review' then 1 else 2 end`
const OVERDUE_FIRST = sql`case when ${tasks.dueDate} is not null and ${tasks.dueDate} < now() then 0 else 1 end`
/** «Ждём клиента» — пауза: такие задачи вниз, ход сейчас не за держателем. */
const WAITING_LAST = sql`case when ${tasks.waitingClientSince} is null then 0 else 1 end`

function orderFor(q: ListQuery, defaults: SQL[]): SQL[] {
  switch (q.sort) {
    case 'due':
      return [sql`${tasks.dueDate} asc nulls last`, sql`${tasks.heldSince} asc nulls last`]
    case 'priority':
      return [PRIORITY_RANK, OVERDUE_FIRST, sql`${tasks.heldSince} asc nulls last`]
    case 'created':
      return [sql`${tasks.createdAt} desc`]
    case 'held':
      return [WAITING_LAST, sql`${tasks.heldSince} asc nulls last`]
    default:
      return defaults
  }
}

type Person = { id: string; name: string; avatarUrl: string | null }

async function list(userId: string, q: ListQuery, where: SQL, defaults: SQL[], projectList: ProjectList) {
  const rows = await db
    .select({
      t: tasks,
      owner: { id: owner.id, name: owner.name, avatarUrl: owner.avatarUrl },
      holder: { id: holder.id, name: holder.name, avatarUrl: holder.avatarUrl },
    })
    .from(tasks)
    .leftJoin(owner, eq(owner.id, sql`coalesce(${tasks.ownerId}, ${tasks.createdById})`))
    .leftJoin(holder, eq(holder.id, tasks.assigneeId))
    .where(where)
    .orderBy(...orderFor(q, defaults))

  /**
   * Последняя передача — «почему это у меня». Одним запросом на весь список
   * (distinct on), а не по строке: список бывает в сотни задач.
   */
  const ids = rows.map((r) => r.t.id)
  const last = ids.length
    ? await db
        .selectDistinctOn([taskHandoffs.taskId], {
          taskId: taskHandoffs.taskId,
          action: taskHandoffs.action,
          note: taskHandoffs.note,
          via: taskHandoffs.via,
          createdAt: taskHandoffs.createdAt,
          actor: { id: users.id, name: users.name, avatarUrl: users.avatarUrl },
        })
        .from(taskHandoffs)
        .leftJoin(users, eq(users.id, taskHandoffs.actorId))
        .where(inArray(taskHandoffs.taskId, ids))
        .orderBy(taskHandoffs.taskId, sql`${taskHandoffs.createdAt} desc`)
    : []
  const lastBy = new Map(last.map((h) => [h.taskId, h]))
  /**
   * «Новое» — есть непрочитанное уведомление об этой задаче. Гаснет, когда
   * задачу открыли: клиент помечает прочитанным всё по задаче разом
   * (POST /inbox/read с entityId). Отдельного флага не заводим — правда уже
   * лежит в уведомлениях, и второй копии не с чем было бы расходиться.
   */
  const unread = ids.length
    ? new Set(
        (
          await db
            .selectDistinct({ id: notifications.entityId })
            .from(notifications)
            .where(
              and(
                eq(notifications.userId, userId),
                eq(notifications.entityType, 'task'),
                inArray(notifications.entityId, ids),
                isNull(notifications.readAt),
              ),
            )
        ).map((r) => r.id),
      )
    : new Set<string | null>()
  const projectBy = new Map(projectList.map(({ companyId: _c, ...p }) => [p.id, p]))
  // Левое соединение без пары отдаёт null целиком, а не объект с пустыми
  // полями: задача без держателя (бэклог в «От меня») роняла весь список.
  const person = (p: Person | { id: null } | null): Person | null => (p?.id ? (p as Person) : null)

  return rows.map(({ t, owner: o, holder: h }) => {
    const l = lastBy.get(t.id)
    return {
      id: t.id,
      number: t.number,
      title: t.title,
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate,
      createdAt: t.createdAt,
      project: projectBy.get(t.projectId) ?? null,
      owner: person(o as Person),
      holder: person(h as Person),
      ball: {
        move: t.move,
        round: t.round,
        heldSince: t.heldSince,
        waitingClientSince: t.waitingClientSince,
        onTable: t.onTable,
        askFromId: t.askFromId,
      },
      isNew: unread.has(t.id),
      last: l ? { action: l.action, note: l.note, via: l.via, at: l.createdAt, actor: l.actor?.id ? l.actor : null } : null,
    }
  })
}

type Item = Awaited<ReturnType<typeof list>>[number]

function groupBy(items: Item[], by: ListQuery['group']) {
  if (!by) return undefined
  const key = (i: Item): string =>
    by === 'move' ? i.ball.move : by === 'project' ? (i.project?.id ?? '') : by === 'holder' ? (i.holder?.id ?? '') : (i.owner?.id ?? '')
  const groups = new Map<string, string[]>()
  for (const i of items) {
    const k = key(i)
    groups.set(k, [...(groups.get(k) ?? []), i.id])
  }
  // Порядок групп — по первому появлению: внутри списка он уже правильный.
  return [...groups].map(([k, taskIds]) => ({ key: k || null, count: taskIds.length, taskIds }))
}

function filters(q: ListQuery, projectIds: string[]): SQL[] {
  const ids = q.project ? projectIds.filter((p) => p === q.project) : projectIds
  return [
    inArray(tasks.projectId, ids.length ? ids : ['-']),
    isNull(tasks.deletedAt),
    sql`${tasks.status} not in ${closedSql}`,
    ...(q.move ? [eq(tasks.move, q.move)] : []),
  ]
}

/**
 * «На мне» и «На столе»: мяч у меня.
 *
 * Стол — отдельным списком: на главном экране он сверху и всегда виден, даже
 * когда остальное отфильтровано.
 */
export async function mineList(userId: string, mine: ProjectList, q: ListQuery) {
  if (!mine.length) return { table: [], items: [], groups: undefined, tableLimit: TABLE_LIMIT }
  const items = await list(
    userId,
    q,
    and(...filters(q, mine.map((p) => p.id)), eq(tasks.assigneeId, userId))!,
    [WAITING_LAST, MOVE_RANK, OVERDUE_FIRST, sql`${tasks.heldSince} asc nulls last`],
    mine,
  )
  const table = items.filter((i) => i.ball.onTable)
  const rest = items.filter((i) => !i.ball.onTable)
  return { table, items: rest, groups: groupBy(rest, q.group), tableLimit: TABLE_LIMIT }
}

ballRoute.get('/mine', zValidator('query', listQuery), async (c) => {
  const { sub } = c.get('session')
  const q = c.req.valid('query')
  return c.json(await mineList(sub, await myProjects(q.companyId, sub), q))
})

/**
 * «От меня»: я владелец, мяч у другого. Дольше всех лежащее — сверху: это то,
 * о чём пора спросить. Без держателя (бэклог) — тоже здесь: это моё, и никто
 * над ним не работает.
 */
export async function fromMeList(userId: string, mine: ProjectList, q: ListQuery) {
  if (!mine.length) return { items: [], groups: undefined }
  const items = await list(
    userId,
    q,
    and(
      ...filters(q, mine.map((p) => p.id)),
      sql`coalesce(${tasks.ownerId}, ${tasks.createdById}) = ${userId}`,
      sql`${tasks.assigneeId} is distinct from ${userId}`,
    )!,
    [WAITING_LAST, OVERDUE_FIRST, sql`${tasks.heldSince} asc nulls last`],
    mine,
  )
  return { items, groups: groupBy(items, q.group) }
}

ballRoute.get('/from-me', zValidator('query', listQuery), async (c) => {
  const { sub } = c.get('session')
  const q = c.req.valid('query')
  return c.json(await fromMeList(sub, await myProjects(q.companyId, sub), q))
})

/**
 * Одна задача для панели веба: сама задача, мяч, люди и какие ходы человеку
 * сейчас доступны.
 *
 * Веб v2 живёт на всю компанию и открывает задачу из любого проекта — список
 * проекта ради одной строки тянуть незачем. Доступные ходы считает сервер тем
 * же планом, что и сам ход: кнопки на экране не расходятся с правилами.
 */
ballRoute.get('/task/:taskId', async (c) => {
  const { sub } = c.get('session')
  const task = await db.query.tasks.findFirst({ where: and(eq(tasks.id, c.req.param('taskId')), isNull(tasks.deletedAt)) })
  if (!task) return c.json({ error: 'Not found' }, 404)
  const role = await projectRoleOf(task.projectId, sub)
  // Задача чужого проекта не существует для того, кто его не видит.
  if (!role || !(await hasPermission(task.projectId, sub, 'tasks.read'))) return c.json({ error: 'Not found' }, 404)

  const [project, team, isManager, canEdit, returnTo, unread] = await Promise.all([
    db.query.projects.findFirst({
      where: eq(projects.id, task.projectId),
      columns: { id: true, name: true, color: true, logoUrl: true, companyId: true },
    }),
    db
      .select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, task.projectId)),
    ownsOrManages(task.projectId, sub, []),
    hasPermission(task.projectId, sub, 'tasks.edit'),
    lastReviewFrom(task.id),
    db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, sub), eq(notifications.entityType, 'task'), eq(notifications.entityId, task.id), isNull(notifications.readAt)))
      .limit(1),
  ])
  const ids = [ownerOf(task), task.assigneeId, task.askFromId, returnTo].filter((x): x is string => Boolean(x))
  const people = ids.length
    ? await db.select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl }).from(users).where(inArray(users.id, ids))
    : []
  const who = (id: string | null) => (id ? (people.find((p) => p.id === id) ?? null) : null)

  // Ход доступен, если роль в задаче позволяет и план на нынешнем состоянии
  // сложился бы. Записку и адресата подставляем заглушками: их человек
  // выберет сам, а «нужна записка» — не повод прятать кнопку.
  const can: Record<string, boolean> = {}
  for (const a of HANDOFF_ACTIONS) {
    if (a === 'create') continue
    if (a === 'take' && task.assigneeId === sub) {
      can[a] = false
      continue
    }
    can[a] = mayHandoff(a, task, sub, isManager) && planHandoff(task, a, { actorId: sub, to: '?', note: '-' }).ok
  }
  const closed = isClosed(task.status)
  can.table = !closed && Boolean(task.assigneeId) && (task.assigneeId === sub || ownerOf(task) === sub || isManager)
  can.edit = canEdit

  return c.json({
    task: {
      id: task.id,
      number: task.number,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDate,
      estimateMinutes: task.estimateMinutes ? Number(task.estimateMinutes) : null,
      // Страница задачи v2 показывает «Экраны в макете» и спринт — без этих
      // двух полей ей пришлось бы тянуть весь список задач проекта.
      refs: task.refs ?? '',
      groupId: task.groupId ?? null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      closed,
      project: project ?? null,
      owner: who(ownerOf(task)),
      holder: who(task.assigneeId),
      askFrom: who(task.askFromId),
      returnTo: who(returnTo),
      ball: {
        move: task.move,
        round: task.round,
        heldSince: task.heldSince,
        waitingClientSince: task.waitingClientSince,
        onTable: task.onTable,
      },
      isNew: unread.length > 0,
    },
    team,
    can,
  })
})

/** Положить на стол / убрать. */
ballRoute.post(
  '/table',
  zValidator('json', z.object({ taskId: z.string().min(1), on: z.boolean() })),
  async (c) => {
    const { sub } = c.get('session')
    const { taskId, on } = c.req.valid('json')
    const task = await db.query.tasks.findFirst({ where: and(eq(tasks.id, taskId), isNull(tasks.deletedAt)) })
    if (!task) return c.json({ error: 'Not found' }, 404)
    // Задача чужого проекта не существует для того, кто в нём не состоит.
    const member = await db.query.projectMembers.findFirst({
      where: and(eq(projectMembers.projectId, task.projectId), eq(projectMembers.userId, sub)),
    })
    if (!member) return c.json({ error: 'Not found' }, 404)
    const r = await tableToggle(task, on, sub)
    return c.json(r.body, r.status)
  },
)

/** Стол: общее для веба и моста. Членство в проекте проверяет вызывающий. */
export async function tableToggle(task: typeof tasks.$inferSelect, on: boolean, userId: string) {
  const r = await setOnTable(task, on, userId, await ownsOrManages(task.projectId, userId, []))
  if (!r.ok) {
    return {
      status: (r.error === 'forbidden' ? 403 : 409) as 403 | 409,
      body: { error: r.error, ...(r.error === 'table_full' ? { limit: TABLE_LIMIT } : {}) } as Record<string, unknown>,
    }
  }
  tasksChanged(task.projectId, [task.assigneeId])
  return { status: 200 as const, body: { id: r.task.id, number: r.task.number, onTable: r.task.onTable } as Record<string, unknown> }
}

/**
 * Быстрое создание: `сверстать шапку @Элиша #Atlas`.
 *
 * preview: true — только разобрать: клиент показывает, кому и куда уйдёт
 * задача, до того как она появится. Ошибки разбора — с кандидатами, чтобы
 * клиент предложил выбор, а не просто «не понял».
 */
ballRoute.post(
  '/quick',
  zValidator(
    'json',
    z.object({
      companyId: z.string().min(1),
      text: z.string().min(1).max(1000),
      preview: z.boolean().optional(),
      /** Проект по умолчанию, когда # не указан: тот, что выбран на экране. */
      projectId: z.string().optional(),
    }),
  ),
  async (c) => {
    const { sub } = c.get('session')
    const b = c.req.valid('json')
    const r = await quickTask({
      userId: sub,
      companyId: b.companyId,
      projects: await myProjects(b.companyId, sub),
      text: b.text,
      preview: b.preview,
      defaultProjectId: b.projectId,
      via: 'ui',
    })
    return c.json(r.body, r.status)
  },
)

type QuickResult = { status: 200 | 201 | 400 | 403; body: Record<string, unknown> }

/**
 * Быстрое создание — общее для веба и моста.
 *
 * projects — где искать #проект; companyId — чей основной проект брать, когда
 * # нет (null у мастер-подключения: тогда проект либо единственный, либо его
 * надо назвать).
 */
export async function quickTask(input: {
  userId: string
  companyId: string | null
  projects: ProjectList
  text: string
  preview?: boolean
  /** Проект, выбранный на экране: им заменяется основной проект компании, когда # нет. */
  defaultProjectId?: string
  via: Via
}): Promise<QuickResult> {
  const sub = input.userId
  const mine = input.projects
  const parsed = parseQuick(input.text)
  const bad = (body: Record<string, unknown>): QuickResult => ({ status: 400, body })
  if (!parsed.title) return bad({ error: 'title_required' })
  if (parsed.people.length > 1) return bad({ error: 'many_people', tokens: parsed.people })
  if (parsed.projects.length > 1) return bad({ error: 'many_projects', tokens: parsed.projects })
  if (!mine.length) return bad({ error: 'no_projects' })

  // Проект: из #, иначе основной проект компании, иначе единственный.
  let project: ProjectList[number] | undefined
  if (parsed.projects[0]) {
    const m = matchProject(parsed.projects[0], mine)
    if (!m.ok) return bad(unmatched('project', parsed.projects[0], m))
    project = mine.find((p) => p.id === m.value.id)
  } else {
    const company = input.companyId
      ? await db.query.companies.findFirst({ where: eq(companies.id, input.companyId) })
      : null
    project =
      mine.find((p) => p.id === input.defaultProjectId) ??
      mine.find((p) => p.id === company?.mainProjectId) ??
      (mine.length === 1 ? mine[0] : undefined)
  }
  if (!project) return bad({ error: 'project_required', candidates: mine.map((p) => ({ id: p.id, name: p.name })) })
  if (!(await hasPermission(project.id, sub, 'tasks.create'))) return { status: 403, body: { error: 'Forbidden' } }

  // Человек: из @, иначе я сам. Ищем только в команде выбранного проекта —
  // мяч может уйти лишь тому, кто задачу увидит.
  const team = await db
    .select({ id: users.id, name: users.name, email: users.email, avatarUrl: users.avatarUrl })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, project.id))
  let to = team.find((u) => u.id === sub)
  if (parsed.people[0]) {
    const m = matchPerson(parsed.people[0], team, sub)
    if (!m.ok) {
      // Нет в команде проекта — может, есть в компании: скажем именно это.
      if (m.reason === 'none') {
        const company = await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(companyMembers)
          .innerJoin(users, eq(users.id, companyMembers.userId))
          .where(and(eq(companyMembers.companyId, project.companyId), ne(companyMembers.userId, sub)))
        const elsewhere = matchPerson(parsed.people[0], company, sub)
        if (elsewhere.ok) {
          return bad({
            error: 'not_in_project',
            person: { id: elsewhere.value.id, name: elsewhere.value.name },
            project: { id: project.id, name: project.name },
          })
        }
      }
      return bad(unmatched('person', parsed.people[0], m))
    }
    to = team.find((u) => u.id === m.value.id)
  }

  const result = {
    title: parsed.title,
    project: { id: project.id, name: project.name, color: project.color },
    assignee: to ? { id: to.id, name: to.name, avatarUrl: to.avatarUrl } : null,
  }
  if (input.preview) return { status: 200, body: { preview: result } }

  const [{ next, minSort }] = (await db
    .select({
      next: sql<number>`coalesce(max(cast(substring(${tasks.number} from 6) as int)), 0) + 1`,
      minSort: sql<number>`coalesce(min(${tasks.sortOrder}), 0)`,
    })
    .from(tasks)
    .where(eq(tasks.projectId, project.id))) as [{ next: number; minSort: number }]

  const row = await insertTask(
    {
      projectId: project.id,
      number: `TASK-${next}`,
      sortOrder: minSort - 1,
      title: parsed.title.slice(0, 300),
      assigneeId: to?.id ?? null,
      createdById: sub,
    },
    { actorId: sub, via: input.via },
  )
  // Те же следствия, что у обычного создания: уведомить, обновить списки, журнал.
  void notifyTask(project.id, sub, row, { assigneeChanged: Boolean(row.assigneeId) && row.assigneeId !== sub })
  if (row.assigneeId && row.assigneeId !== sub) void postTaskAssigned(project.id, sub, row.assigneeId, row)
  tasksChanged(project.id, [row.assigneeId, sub])
  void logActivity({
    projectId: project.id,
    actorId: sub,
    action: 'create',
    entityType: 'task',
    entityId: row.id,
    entityLabel: `${row.number}: ${row.title}`,
  })
  return { status: 201, body: { task: { id: row.id, number: row.number, ...result } } }
}

function unmatched(kind: 'person' | 'project', token: string, m: Match<{ id: string; name: string }>) {
  if (m.ok) throw new Error('unmatched called on a match')
  return {
    error: m.reason === 'ambiguous' ? `${kind}_ambiguous` : `${kind}_not_found`,
    token,
    candidates: m.candidates.map((x) => ({ id: x.id, name: x.name })),
  }
}
