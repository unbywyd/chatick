import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../db/client.js'
import { companies, companyMembers, projectMembers, projects, taskHandoffs, tasks, TASK_MOVES, users } from '../db/schema.js'
import { requireSession, type SessionEnv } from '../auth.js'
import { hasPermission, ownsOrManages } from './projects.js'
import { insertTask, setOnTable, TABLE_LIMIT } from '../lib/ball.js'
import { closedSql } from '../lib/task-status.js'
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

async function myProjects(companyId: string, userId: string) {
  return db
    .select({ id: projects.id, name: projects.name, color: projects.color, logoUrl: projects.logoUrl })
    .from(projects)
    .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
    .where(and(eq(projects.companyId, companyId), eq(projectMembers.userId, userId), isNull(projects.archivedAt)))
}

const listQuery = z.object({
  companyId: z.string().min(1),
  project: z.string().optional(),
  move: z.enum(TASK_MOVES).optional(),
  /** held — дольше всех у держателя сверху; due — по сроку; priority; created — новые сверху. */
  sort: z.enum(['held', 'due', 'priority', 'created']).optional(),
  group: z.enum(['move', 'project', 'holder', 'owner']).optional(),
})
type ListQuery = z.infer<typeof listQuery>

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

async function list(q: ListQuery, where: SQL, defaults: SQL[], projectList: Awaited<ReturnType<typeof myProjects>>) {
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
  const projectBy = new Map(projectList.map((p) => [p.id, p]))
  const person = (p: Person | { id: null }): Person | null => (p.id ? (p as Person) : null)

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
ballRoute.get('/mine', zValidator('query', listQuery), async (c) => {
  const { sub } = c.get('session')
  const q = c.req.valid('query')
  const mine = await myProjects(q.companyId, sub)
  if (!mine.length) return c.json({ table: [], items: [], tableLimit: TABLE_LIMIT })

  const items = await list(
    q,
    and(...filters(q, mine.map((p) => p.id)), eq(tasks.assigneeId, sub))!,
    [WAITING_LAST, MOVE_RANK, OVERDUE_FIRST, sql`${tasks.heldSince} asc nulls last`],
    mine,
  )
  const table = items.filter((i) => i.ball.onTable)
  const rest = items.filter((i) => !i.ball.onTable)
  return c.json({ table, items: rest, groups: groupBy(rest, q.group), tableLimit: TABLE_LIMIT })
})

/**
 * «От меня»: я владелец, мяч у другого. Дольше всех лежащее — сверху: это то,
 * о чём пора спросить. Без держателя (бэклог) — тоже здесь: это моё, и никто
 * над ним не работает.
 */
ballRoute.get('/from-me', zValidator('query', listQuery), async (c) => {
  const { sub } = c.get('session')
  const q = c.req.valid('query')
  const mine = await myProjects(q.companyId, sub)
  if (!mine.length) return c.json({ items: [] })

  const items = await list(
    q,
    and(
      ...filters(q, mine.map((p) => p.id)),
      sql`coalesce(${tasks.ownerId}, ${tasks.createdById}) = ${sub}`,
      sql`${tasks.assigneeId} is distinct from ${sub}`,
    )!,
    [WAITING_LAST, OVERDUE_FIRST, sql`${tasks.heldSince} asc nulls last`],
    mine,
  )
  return c.json({ items, groups: groupBy(items, q.group) })
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

    const r = await setOnTable(task, on, sub, await ownsOrManages(task.projectId, sub, []))
    if (!r.ok) return c.json({ error: r.error, ...(r.error === 'table_full' ? { limit: TABLE_LIMIT } : {}) }, r.error === 'forbidden' ? 403 : 409)
    tasksChanged(task.projectId, [task.assigneeId])
    return c.json({ id: r.task.id, onTable: r.task.onTable })
  },
)

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
    z.object({ companyId: z.string().min(1), text: z.string().min(1).max(1000), preview: z.boolean().optional() }),
  ),
  async (c) => {
    const { sub } = c.get('session')
    const b = c.req.valid('json')
    const parsed = parseQuick(b.text)
    if (!parsed.title) return c.json({ error: 'title_required' }, 400)
    if (parsed.people.length > 1) return c.json({ error: 'many_people', tokens: parsed.people }, 400)
    if (parsed.projects.length > 1) return c.json({ error: 'many_projects', tokens: parsed.projects }, 400)

    const mine = await myProjects(b.companyId, sub)
    if (!mine.length) return c.json({ error: 'no_projects' }, 400)

    // Проект: из #, иначе основной проект компании, иначе единственный.
    let project: (typeof mine)[number] | undefined
    if (parsed.projects[0]) {
      const m = matchProject(parsed.projects[0], mine)
      if (!m.ok) return c.json(unmatched('project', parsed.projects[0], m), 400)
      project = mine.find((p) => p.id === m.value.id)
    } else {
      const company = await db.query.companies.findFirst({ where: eq(companies.id, b.companyId) })
      project = mine.find((p) => p.id === company?.mainProjectId) ?? (mine.length === 1 ? mine[0] : undefined)
      if (!project) return c.json({ error: 'project_required', candidates: mine.map((p) => ({ id: p.id, name: p.name })) }, 400)
    }
    if (!(await hasPermission(project!.id, sub, 'tasks.create'))) return c.json({ error: 'Forbidden' }, 403)

    // Человек: из @, иначе я сам. Ищем только в команде выбранного проекта —
    // мяч может уйти лишь тому, кто задачу увидит.
    const team = await db
      .select({ id: users.id, name: users.name, email: users.email, avatarUrl: users.avatarUrl })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, project!.id))
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
            .where(and(eq(companyMembers.companyId, b.companyId), ne(companyMembers.userId, sub)))
          const elsewhere = matchPerson(parsed.people[0], company, sub)
          if (elsewhere.ok) return c.json({ error: 'not_in_project', person: { id: elsewhere.value.id, name: elsewhere.value.name }, project: { id: project!.id, name: project!.name } }, 400)
        }
        return c.json(unmatched('person', parsed.people[0], m), 400)
      }
      to = team.find((u) => u.id === m.value.id)
    }

    const result = {
      title: parsed.title,
      project: { id: project!.id, name: project!.name, color: project!.color },
      assignee: to ? { id: to.id, name: to.name, avatarUrl: to.avatarUrl } : null,
    }
    if (b.preview) return c.json({ preview: result })

    const [{ next, minSort }] = (await db
      .select({
        next: sql<number>`coalesce(max(cast(substring(${tasks.number} from 6) as int)), 0) + 1`,
        minSort: sql<number>`coalesce(min(${tasks.sortOrder}), 0)`,
      })
      .from(tasks)
      .where(eq(tasks.projectId, project!.id))) as [{ next: number; minSort: number }]

    const row = await insertTask(
      {
        projectId: project!.id,
        number: `TASK-${next}`,
        sortOrder: minSort - 1,
        title: parsed.title.slice(0, 300),
        assigneeId: to?.id ?? null,
        createdById: sub,
      },
      { actorId: sub, via: 'ui' },
    )
    // Те же следствия, что у обычного создания: уведомить, обновить списки, журнал.
    void notifyTask(project!.id, sub, row, { assigneeChanged: Boolean(row.assigneeId) && row.assigneeId !== sub })
    if (row.assigneeId && row.assigneeId !== sub) void postTaskAssigned(project!.id, sub, row.assigneeId, row)
    tasksChanged(project!.id, [row.assigneeId, sub])
    void logActivity({ projectId: project!.id, actorId: sub, action: 'create', entityType: 'task', entityId: row.id, entityLabel: `${row.number}: ${row.title}` })
    return c.json({ task: { id: row.id, number: row.number, ...result } }, 201)
  },
)

function unmatched(kind: 'person' | 'project', token: string, m: Match<{ id: string; name: string }>) {
  if (m.ok) throw new Error('unmatched called on a match')
  return {
    error: m.reason === 'ambiguous' ? `${kind}_ambiguous` : `${kind}_not_found`,
    token,
    candidates: m.candidates.map((x) => ({ id: x.id, name: x.name })),
  }
}
