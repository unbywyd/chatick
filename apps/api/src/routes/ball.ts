import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../db/client.js'
import { companies, companyMembers, credentials, documents, files, HANDOFF_ACTIONS, notes, notifications, projectMembers, projects, taskBlockers, taskHandoffs, tasks, TASK_MOVES, timeEntries, users } from '../db/schema.js'
import { requireSession, type SessionEnv } from '../auth.js'
import { canCreateProjects, companyRoleOf, hasPermission, ownsOrManages, projectRoleOf } from './projects.js'
import { insertTask, lastReviewFrom, mayHandoff, ownerOf, planHandoff, setOnTable, TABLE_LIMIT, type Via } from '../lib/ball.js'
import { closedSql, isClosed } from '../lib/task-status.js'
import { matchPerson, matchProject, parseQuick, resolveDue, type Match } from '../lib/quick-task.js'
import { notifyTask } from './tasks.js'
import { postTaskAssigned } from '../lib/task-events.js'
import { logActivity } from '../lib/audit.js'
import { tasksChanged } from '../ws.js'

/**
 * Списки мяча (v2) — главный экран: «На столе», «На мне», «От меня», «Все» и
 * закрытые задачи по запросу.
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

/**
 * Проекты, которые человек видит целиком: участнику — где он в команде,
 * менеджеру и админу компании — все живые проекты компании (одна лестница
 * ролей). Права на каждое действие проверяются отдельно, как и прежде.
 */
export async function visibleProjects(companyId: string, userId: string): Promise<ProjectList> {
  if (!canCreateProjects(await companyRoleOf(companyId, userId))) return myProjects(companyId, userId)
  return db
    .select({ id: projects.id, name: projects.name, color: projects.color, logoUrl: projects.logoUrl, companyId: projects.companyId })
    .from(projects)
    .where(and(eq(projects.companyId, companyId), isNull(projects.archivedAt)))
}

/**
 * Для «Все»: видимые проекты, где человеку можно читать задачи. Доменные
 * права проекта действуют и здесь — участник, которому закрыли задачи
 * проекта, не увидит их и в общем списке. Менеджер и админ компании —
 * админы в любом её проекте, проверять их по одному незачем.
 */
async function readableProjects(companyId: string, userId: string): Promise<ProjectList> {
  if (canCreateProjects(await companyRoleOf(companyId, userId))) return visibleProjects(companyId, userId)
  const mine = await myProjects(companyId, userId)
  const ok = await Promise.all(mine.map((p) => hasPermission(p.id, userId, 'tasks.read')))
  return mine.filter((_, i) => ok[i])
}

/**
 * Поиск по Ctrl+K: задачи, документы, файлы, ресурсы и заметки компании —
 * по названию (задачи ещё по номеру).
 *
 * Права — те же, что у каждого списка: проекты, где человеку можно читать
 * именно это. Менеджер и админ компании — админы в любом её проекте. У
 * ресурса — только имя: секреты остаются за своей проверкой.
 */
export async function searchCompany(companyId: string, userId: string, role: string, q: string) {
  const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`
  // Роль уже известна — не спрашиваем её заново на каждом шаге: каждый лишний
  // запрос к базе человек ждёт, глядя на пустое окно поиска.
  const boss = canCreateProjects(role as Parameters<typeof canCreateProjects>[0])
  const visible = boss
    ? await db
        .select({ id: projects.id, name: projects.name, color: projects.color, logoUrl: projects.logoUrl, companyId: projects.companyId })
        .from(projects)
        .where(and(eq(projects.companyId, companyId), isNull(projects.archivedAt)))
    : await myProjects(companyId, userId)
  const names = new Map(visible.map((p) => [p.id, p.name]))
  const allowed = async (perm: Parameters<typeof hasPermission>[2]) => {
    if (boss) return visible.map((p) => p.id)
    const ok = await Promise.all(visible.map((p) => hasPermission(p.id, userId, perm)))
    return visible.filter((_, i) => ok[i]).map((p) => p.id)
  }
  const [taskP, docP, fileP, resP] = await Promise.all([allowed('tasks.read'), allowed('documents.read'), allowed('files.read'), allowed('credentials.read')])
  // Заметки — база знаний компании: состоишь в компании — читаешь (canUseKnowledge в notes.ts).
  const kb = true
  const [t, d, f, r, n] = await Promise.all([
    taskP.length
      ? db
          .select({ id: tasks.id, number: tasks.number, title: tasks.title, projectId: tasks.projectId, status: tasks.status })
          .from(tasks)
          .where(and(inArray(tasks.projectId, taskP), isNull(tasks.deletedAt), or(ilike(tasks.title, like), ilike(tasks.number, like))))
          // Открытые — выше: закрытую ищут реже.
          .orderBy(
            // Точный номер (TASK-12, 12) — первым, иначе TASK-120 и TASK-124 его заслоняют.
            sql`case when lower(${tasks.number}) = lower(${q}) or ${tasks.number} ilike ${'%-' + q.replace(/^.*-/, '')} then 0 else 1 end`,
            sql`case when ${tasks.status} in ${closedSql} then 1 else 0 end`,
            desc(tasks.updatedAt),
          )
          .limit(8)
      : [],
    docP.length
      ? db
          .select({ id: documents.id, title: documents.title, projectId: documents.projectId })
          .from(documents)
          .where(and(inArray(documents.projectId, docP), isNull(documents.deletedAt), ilike(documents.title, like)))
          .orderBy(desc(documents.updatedAt))
          .limit(5)
      : [],
    fileP.length
      ? db
          .select({ id: files.id, name: files.name, projectId: files.projectId })
          .from(files)
          .where(and(inArray(files.projectId, fileP), isNull(files.deletedAt), isNull(files.pendingUntil), ilike(files.name, like)))
          .orderBy(desc(files.createdAt))
          .limit(5)
      : [],
    resP.length
      ? db
          .select({ id: credentials.id, name: credentials.name, projectId: credentials.projectId })
          .from(credentials)
          .where(and(inArray(credentials.projectId, resP), isNull(credentials.deletedAt), ilike(credentials.name, like)))
          .limit(5)
      : [],
    kb
      ? db
          .select({ id: notes.id, title: notes.title, projectId: notes.projectId })
          .from(notes)
          .where(and(eq(notes.companyId, companyId), isNull(notes.deletedAt), ilike(notes.title, like)))
          .orderBy(desc(notes.updatedAt))
          .limit(5)
      : [],
  ])
  const pn = (id: string | null) => (id ? (names.get(id) ?? null) : null)
  return {
    tasks: t.map((x) => ({ ...x, closed: isClosed(x.status), projectName: pn(x.projectId) })),
    docs: d.map((x) => ({ ...x, projectName: pn(x.projectId) })),
    files: f.map((x) => ({ ...x, projectName: pn(x.projectId) })),
    resources: r.map((x) => ({ ...x, projectName: pn(x.projectId) })),
    notes: n.map((x) => ({ ...x, projectName: pn(x.projectId) })),
  }
}

export const listFilters = z.object({
  project: z.string().optional(),
  move: z.enum(TASK_MOVES).optional(),
  /** held — дольше всех у держателя сверху; due — по сроку; priority; created — новые сверху. */
  sort: z.enum(['held', 'due', 'priority', 'created']).optional(),
  group: z.enum(['move', 'project', 'holder', 'owner']).optional(),
  /** Задачи одного человека — страница «Команда» показывает их по щелчку. */
  holder: z.string().optional(),
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

async function list(userId: string, q: ListQuery, where: SQL, defaults: SQL[], projectList: ProjectList, page?: { limit: number; offset: number }) {
  const query = db
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
    .$dynamic()
  const rows = page ? await query.limit(page.limit).offset(page.offset) : await query

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
  /**
   * Строке списка нужны ещё две цифры: сколько вложений и сколько открытых
   * блокеров (замок у заблокированной задачи). Тоже одним запросом на список.
   */
  const fileCount = ids.length
    ? new Map(
        (
          await db
            .select({ id: files.taskId, n: sql<number>`count(*)::int` })
            .from(files)
            .where(and(inArray(files.taskId, ids), isNull(files.deletedAt), isNull(files.pendingUntil)))
            .groupBy(files.taskId)
        ).map((r) => [r.id, r.n]),
      )
    : new Map<string | null, number>()
  const blocker = alias(tasks, 'blocker')
  const blockedBy = ids.length
    ? new Map(
        (
          await db
            .select({ id: taskBlockers.blockedTaskId, n: sql<number>`count(*)::int` })
            .from(taskBlockers)
            .innerJoin(blocker, eq(blocker.id, taskBlockers.blockerTaskId))
            .where(and(inArray(taskBlockers.blockedTaskId, ids), isNull(blocker.deletedAt), sql`${blocker.status} not in ${closedSql}`))
            .groupBy(taskBlockers.blockedTaskId)
        ).map((r) => [r.id, r.n]),
      )
    : new Map<string, number>()
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
      estimateMinutes: t.estimateMinutes,
      files: fileCount.get(t.id) ?? 0,
      /** Сколько незакрытых задач её держат: больше нуля — замок в строке. */
      blockedBy: blockedBy.get(t.id) ?? 0,
      // Отдельного поля «закрыта» нет: после закрытия задачу почти не правят,
      // и время последней правки — это время закрытия.
      closedAt: isClosed(t.status) ? t.updatedAt : null,
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
    ...(q.holder ? [eq(tasks.assigneeId, q.holder)] : []),
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

ballRoute.get('/search', zValidator('query', z.object({ companyId: z.string().min(1), q: z.string().trim().min(1).max(100) })), async (c) => {
  const { sub } = c.get('session')
  const { companyId, q } = c.req.valid('query')
  const role = await companyRoleOf(companyId, sub)
  if (!role) return c.json({ error: 'Forbidden' }, 403)
  return c.json(await searchCompany(companyId, sub, role, q))
})

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
 * «Все»: открытые задачи всех проектов, которые человек видит, — бэклог,
 * чужие, без исполнителя. Руководителю — по всей компании. Просроченные и
 * важные сверху, дальше — дольше всех лежащие у держателя.
 */
export async function allList(userId: string, visible: ProjectList, q: ListQuery) {
  if (!visible.length) return { items: [], groups: undefined }
  const items = await list(
    userId,
    q,
    and(...filters(q, visible.map((p) => p.id)))!,
    [WAITING_LAST, OVERDUE_FIRST, PRIORITY_RANK, sql`${tasks.heldSince} asc nulls last`],
    visible,
  )
  return { items, groups: groupBy(items, q.group) }
}

ballRoute.get('/all', zValidator('query', listQuery), async (c) => {
  const { sub } = c.get('session')
  const q = c.req.valid('query')
  return c.json(await allList(sub, await readableProjects(q.companyId, sub), q))
})

/**
 * «Команда»: кто что делает и сколько на ком. Простая картина вместо
 * статистики первой версии: открытые задачи на человеке, сколько из них ждут
 * его проверки или ответа, сколько просрочено, и идущий таймер.
 *
 * Видно всем участникам компании, но считается по тем же проектам, что
 * «Все»: задачи проекта, куда человека не пускают, в его цифры не попадают,
 * и над чем коллега работает в закрытом проекте — тоже не видно.
 */
ballRoute.get('/team', zValidator('query', z.object({ companyId: z.string().min(1) })), async (c) => {
  const { sub } = c.get('session')
  const { companyId } = c.req.valid('query')
  if (!(await companyRoleOf(companyId, sub))) return c.json({ error: 'Forbidden' }, 403)
  const readable = await readableProjects(companyId, sub)
  const ids = readable.map((p) => p.id)
  const projectBy = new Map(readable.map(({ companyId: _c, ...p }) => [p.id, p]))

  const people = await db
    .select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl, jobTitle: companyMembers.jobTitle, role: companyMembers.role })
    .from(companyMembers)
    .innerJoin(users, eq(users.id, companyMembers.userId))
    .where(eq(companyMembers.companyId, companyId))

  const counts = ids.length
    ? await db
        .select({
          userId: tasks.assigneeId,
          total: sql<number>`count(*)::int`,
          review: sql<number>`(count(*) filter (where ${tasks.move} = 'review'))::int`,
          answer: sql<number>`(count(*) filter (where ${tasks.move} = 'answer'))::int`,
          late: sql<number>`(count(*) filter (where ${tasks.dueDate} is not null and ${tasks.dueDate} < now()))::int`,
        })
        .from(tasks)
        .where(and(...filters({}, ids), isNotNull(tasks.assigneeId)))
        .groupBy(tasks.assigneeId)
    : []
  const countBy = new Map(counts.map((r) => [r.userId!, r]))

  const companyProjectIds = (await db.select({ id: projects.id }).from(projects).where(eq(projects.companyId, companyId))).map((p) => p.id)
  const running = people.length
    ? await db
        .select({
          userId: timeEntries.userId,
          projectId: timeEntries.projectId,
          startedAt: timeEntries.startedAt,
          task: { id: tasks.id, number: tasks.number, title: tasks.title, projectId: tasks.projectId },
        })
        .from(timeEntries)
        .leftJoin(tasks, eq(tasks.id, timeEntries.taskId))
        .where(
          and(
            isNull(timeEntries.endedAt),
            inArray(
              timeEntries.userId,
              people.map((p) => p.id),
            ),
            or(eq(timeEntries.companyId, companyId), companyProjectIds.length ? inArray(timeEntries.projectId, companyProjectIds) : sql`false`),
          ),
        )
    : []
  const runBy = new Map(running.map((r) => [r.userId, r]))

  return c.json({
    people: people
      .map((p) => {
        const n = countBy.get(p.id)
        const r = runBy.get(p.id)
        return {
          id: p.id,
          name: p.name,
          avatarUrl: p.avatarUrl,
          jobTitle: p.jobTitle,
          role: p.role,
          open: n?.total ?? 0,
          review: n?.review ?? 0,
          answer: n?.answer ?? 0,
          late: n?.late ?? 0,
          // Проект и задачу таймера — только если их видно смотрящему.
          now: r
            ? {
                startedAt: r.startedAt,
                project: r.projectId ? (projectBy.get(r.projectId) ?? null) : null,
                task: r.task?.id && projectBy.has(r.task.projectId) ? { id: r.task.id, number: r.task.number, title: r.task.title } : null,
              }
            : null,
        }
      })
      .sort((a, b) => Number(Boolean(b.now)) - Number(Boolean(a.now)) || b.open - a.open || a.name.localeCompare(b.name)),
  })
})

const closedQuery = z.object({
  companyId: z.string().min(1),
  tab: z.enum(['mine', 'from', 'all']),
  project: z.string().optional(),
  /** 0 — только число: свёрнутый блок показывает его, не загружая строк. */
  limit: z.coerce.number().int().min(0).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
})

/**
 * Закрытые задачи — по запросу и порциями: их сотни, а нужны они редко
 * («где та задача, что закрыли на прошлой неделе»). Свежезакрытые сверху.
 *
 *   mine — задачи, где мяч был у меня (при закрытии он остаётся у последнего
 *          держателя — часто у проверяющего, поэтому смотрим и передачи);
 *   from — мои как владельца;
 *   all  — всё в видимых проектах.
 */
ballRoute.get('/closed', zValidator('query', closedQuery), async (c) => {
  const { sub } = c.get('session')
  const q = c.req.valid('query')
  const scope = q.tab === 'all' ? await readableProjects(q.companyId, sub) : await myProjects(q.companyId, sub)
  const ids = scope.map((p) => p.id).filter((id) => !q.project || id === q.project)
  if (!ids.length) return c.json({ items: [], total: 0 })
  const who =
    q.tab === 'mine'
      ? sql`(${tasks.assigneeId} = ${sub} or exists (select 1 from ${taskHandoffs} where ${taskHandoffs.taskId} = ${tasks.id} and ${taskHandoffs.toId} = ${sub}))`
      : q.tab === 'from'
        ? sql`coalesce(${tasks.ownerId}, ${tasks.createdById}) = ${sub}`
        : sql`true`
  const where = and(inArray(tasks.projectId, ids), isNull(tasks.deletedAt), sql`${tasks.status} in ${closedSql}`, who)!
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(where)
  const total = row?.n ?? 0
  if (!q.limit || !total) return c.json({ items: [], total })
  const items = await list(sub, {}, where, [sql`${tasks.updatedAt} desc`, sql`${tasks.id} asc`], scope, { limit: q.limit, offset: q.offset })
  return c.json({ items, total })
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
      /** «Сегодня» человека и его пояс: от них считается «завтра» и «до пятницы». */
      today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      tzOffset: z.number().int().min(-14 * 60).max(14 * 60).optional(),
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
      today: b.today,
      tzOffset: b.tzOffset,
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
  /** Местное «сегодня» человека ('YYYY-MM-DD') и getTimezoneOffset() — для срока. */
  today?: string
  tzOffset?: number
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

  // Срок — полдень того дня по местному времени человека, как ставит его веб.
  const dueDay = parsed.due ? resolveDue(parsed.due, input.today ?? new Date().toISOString().slice(0, 10)) : null
  let dueDate: Date | null = null
  if (dueDay) {
    const [y, m, d] = dueDay.split('-').map(Number) as [number, number, number]
    dueDate = new Date(Date.UTC(y, m - 1, d, 12) + (input.tzOffset ?? 0) * 60_000)
  }
  const result = {
    title: parsed.title,
    project: { id: project.id, name: project.name, color: project.color },
    assignee: to ? { id: to.id, name: to.name, avatarUrl: to.avatarUrl } : null,
    due: dueDay,
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
      dueDate,
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
