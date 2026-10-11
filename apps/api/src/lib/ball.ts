import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { projectMembers, taskHandoffs, tasks, type HandoffAction, type TaskMove } from '../db/schema.js'
import { closedSql, isClosed, type TaskStatus } from './task-status.js'

/**
 * Мяч (v2) — единственное место, где меняется, у кого задача и чего от него ждут.
 *
 * Мяч — это assignee_id: ровно один человек, от которого ждут хода. Ход (move)
 * говорит, какого: сделать, проверить или ответить. Статус в базе остаётся ради
 * отчётов, внешних систем и старых клиентов, но вводится уже не руками: его
 * выводит отсюда сервер.
 *
 * Слоёв два. Правила — чистые функции (planHandoff, planCompat, planCreate):
 * по задаче и действию они говорят, какие поля меняются и какая строка ляжет в
 * журнал передач. Запись (handoff, updateTask, insertTask) применяет план одной
 * транзакцией. Правила проверяются тестами без базы, а запись не знает правил.
 *
 * Писать assignee_id, status, move и остальные поля мяча в обход этого файла
 * нельзя — сторож ball-writes.test.ts ловит такие места. Иначе журнал передач
 * разошёлся бы с тем, у кого задача на самом деле, а именно журнал отвечает на
 * вопрос «почему это у меня».
 */

export type Task = typeof tasks.$inferSelect
export type BallTask = Pick<
  Task,
  | 'id'
  | 'projectId'
  | 'status'
  | 'assigneeId'
  | 'ownerId'
  | 'createdById'
  | 'move'
  | 'round'
  | 'askFromId'
  | 'askPrevMove'
  | 'waitingClientSince'
>

/** Откуда пришло действие — для журнала и разбора «кто это сделал». */
export type Via = 'ui' | 'mcp' | 'api' | 'ai' | 'compat' | 'tray' | 'system'

/** Поля мяча. Только этот файл кладёт их в update/insert задач. */
export const BALL_FIELDS = [
  'assigneeId',
  'status',
  'move',
  'ownerId',
  'heldSince',
  'round',
  'askFromId',
  'askPrevMove',
  'waitingClientSince',
  'onTable',
] as const

export type BallPatch = Partial<Pick<Task, (typeof BALL_FIELDS)[number]>>

export type HandoffRow = typeof taskHandoffs.$inferInsert

export type BallError =
  | 'note_required'
  | 'target_required'
  | 'closed'
  | 'not_closed'
  | 'wrong_move'
  | 'not_asking'
  | 'already_asking'
  | 'not_waiting'
  | 'already_waiting'
  | 'self'
  | 'no_owner'
  | 'not_member'
  | 'forbidden'
  | 'conflict'

export type Plan = { patch: BallPatch; handoff: HandoffRow | null }
export type PlanResult = { ok: true; plan: Plan } | { ok: false; error: BallError }

/**
 * Действия, где записка обязательна. Без неё пинг-понг становился мутным:
 * «вернул» — а что не так? «На проверку» — а что смотреть?
 * «Передать» записку только просит: иногда сказать нечего.
 */
export const NOTE_REQUIRED: ReadonlySet<HandoffAction> = new Set<HandoffAction>(['review', 'return', 'ask', 'answer', 'cancel'])

/** Владелец задачи: поле owner, а у задач до v2 без него — автор. */
export const ownerOf = (t: Pick<BallTask, 'ownerId' | 'createdById'>): string | null => t.ownerId ?? t.createdById ?? null

/**
 * Статус открытой задачи из хода.
 *
 * «Проверить» — всегда review. «Ответить» — пауза внутри работы: статус
 * остаётся, каким был, иначе вопрос посреди проверки выбрасывал бы задачу из
 * колонки «на проверке» у старых клиентов. «Сделать» сохраняет todo и
 * in_progress, всё прочее становится in_progress: вернули — значит, в работе.
 */
export function openStatusFor(move: TaskMove, prev: TaskStatus): TaskStatus {
  if (move === 'review') return 'review'
  const open = !isClosed(prev) && prev !== 'verified'
  if (move === 'answer') return open ? prev : 'in_progress'
  return prev === 'todo' || prev === 'in_progress' ? prev : 'in_progress'
}

export interface HandoffInput {
  actorId: string | null
  /** Кому. undefined — «по умолчанию для действия», null — в бэклог (только pass). */
  to?: string | null
  note?: string
  via?: Via
  now?: Date
  /**
   * Мягкий режим для старых клиентов: записка не обязательна, а проверки
   * «из какого хода можно» не действуют. Старый клиент не знает ходов, и
   * отказ ему выглядел бы как поломка, а не как правило.
   */
  lenient?: boolean
}

const clearAsk = { askFromId: null, askPrevMove: null } as const

export function planHandoff(task: BallTask, action: HandoffAction, input: HandoffInput): PlanResult {
  const now = input.now ?? new Date()
  const note = (input.note ?? '').trim()
  const lenient = Boolean(input.lenient)
  const fail = (error: BallError): PlanResult => ({ ok: false, error })

  if (!lenient && NOTE_REQUIRED.has(action) && !note) return fail('note_required')

  const closed = isClosed(task.status)
  if (closed && action !== 'reopen' && !(lenient && (action === 'accept' || action === 'cancel'))) return fail('closed')

  let patch: BallPatch
  switch (action) {
    case 'create': {
      const to = input.to ?? null
      patch = { assigneeId: to, move: 'do', heldSince: now }
      break
    }
    case 'review': {
      const to = input.to !== undefined ? input.to : ownerOf(task)
      if (!to) return fail('no_owner')
      if (!lenient && task.move !== 'do') return fail('wrong_move')
      if (!lenient && to === task.assigneeId) return fail('self')
      patch = { assigneeId: to, move: 'review', status: 'review', heldSince: now, waitingClientSince: null, ...clearAsk }
      break
    }
    case 'accept': {
      patch = { status: 'done', waitingClientSince: null, onTable: false, ...clearAsk }
      break
    }
    case 'return': {
      if (!lenient && task.move !== 'review') return fail('wrong_move')
      const to = input.to
      if (!to) return fail('target_required')
      patch = {
        assigneeId: to,
        move: 'do',
        status: 'in_progress',
        round: task.round + 1,
        heldSince: now,
        waitingClientSince: null,
        ...clearAsk,
      }
      break
    }
    case 'ask': {
      const to = input.to
      if (!to) return fail('target_required')
      if (to === task.assigneeId) return fail('self')
      if (!lenient && task.move === 'answer') return fail('already_asking')
      patch = {
        assigneeId: to,
        move: 'answer',
        status: openStatusFor('answer', task.status),
        askFromId: task.assigneeId ?? input.actorId,
        askPrevMove: task.move,
        heldSince: now,
      }
      break
    }
    case 'answer': {
      if (task.move !== 'answer') return fail('not_asking')
      const to = task.askFromId ?? ownerOf(task)
      if (!to) return fail('target_required')
      const move = task.askPrevMove ?? 'do'
      patch = { assigneeId: to, move, status: openStatusFor(move, task.status), heldSince: now, ...clearAsk }
      break
    }
    case 'pass':
    case 'take': {
      const to = action === 'take' ? input.actorId : input.to
      if (to === undefined) return fail('target_required')
      patch = { assigneeId: to, heldSince: now }
      break
    }
    case 'wait_client': {
      if (task.waitingClientSince && !lenient) return fail('already_waiting')
      patch = { waitingClientSince: now }
      break
    }
    case 'client_replied': {
      if (!task.waitingClientSince && !lenient) return fail('not_waiting')
      patch = { waitingClientSince: null }
      break
    }
    case 'cancel': {
      patch = { status: 'cancelled', waitingClientSince: null, onTable: false, ...clearAsk }
      break
    }
    case 'reopen': {
      if (!closed) return fail('not_closed')
      const to = input.to !== undefined ? input.to : task.assigneeId
      patch = { assigneeId: to, move: 'do', status: 'todo', heldSince: now, waitingClientSince: null, ...clearAsk }
      break
    }
  }

  const toId = patch.assigneeId !== undefined ? patch.assigneeId : task.assigneeId
  return {
    ok: true,
    plan: {
      patch,
      handoff: {
        taskId: task.id,
        projectId: task.projectId,
        action,
        actorId: input.actorId,
        fromId: action === 'create' ? null : task.assigneeId,
        toId,
        moveBefore: action === 'create' ? null : task.move,
        moveAfter: patch.move ?? task.move,
        note,
        round: patch.round ?? task.round,
        via: input.via ?? 'ui',
        createdAt: now,
      },
    },
  }
}

/**
 * Кто какое действие вправе сделать. Базовое право проекта (видеть и двигать
 * задачи) проверяет маршрут; здесь — роль человека в самой задаче.
 *
 *   держатель — у кого мяч; владелец — кто отвечает за результат;
 *   управляющий — owner/admin проекта, ему можно всё.
 */
export function mayHandoff(action: HandoffAction, task: BallTask, actorId: string, isManager: boolean): boolean {
  if (isManager) return true
  const holder = task.assigneeId === actorId
  const owner = ownerOf(task) === actorId
  switch (action) {
    case 'review':
    case 'ask':
    case 'pass':
    case 'wait_client':
    case 'client_replied':
      return holder || owner
    case 'answer':
      return holder
    case 'accept':
    case 'return':
      return owner || (holder && task.move === 'review')
    case 'take':
    case 'cancel':
    case 'reopen':
      return owner
    case 'create':
      return false
  }
}

/** Что старый клиент хочет поменять в мяче: статус и/или исполнителя. */
export interface LegacyBallPatch {
  status?: TaskStatus
  /** undefined — не трогать, null — снять исполнителя. */
  assigneeId?: string | null
}

export interface CompatContext {
  actorId: string | null
  via?: Via
  now?: Date
  /** Владелец ещё в команде проекта — только тогда «на проверку» уходит ему. */
  ownerInTeam: boolean
  /** Кто последним отправил задачу на проверку — ему её и вернут. */
  lastReviewFrom: string | null
}

/**
 * Перевод старых правок (status/assignee) в ходы мяча.
 *
 * Старые клиенты — Atlas, MCP-инструменты, трей, вкладки v1 — ничего не знают
 * о ходах и продолжат слать статусы. Каждое такое изменение превращается в
 * передачу с пометкой via='compat':
 *
 *   → review                  на проверку владельцу (если он ещё в команде)
 *   → done / verified         принять (закрыть)
 *   → cancelled               отменить
 *   закрытая → открытая       открыть заново
 *   review → todo/in_progress вернуть тому, кто отправлял, круг +1
 *   смена исполнителя         передать тем же ходом
 *
 * Если исполнитель прислан вместе со статусом, он и есть адресат.
 */
export function planCompat(task: BallTask, want: LegacyBallPatch, ctx: CompatContext): Plan {
  const status: TaskStatus | undefined = want.status === 'verified' ? 'done' : want.status
  const base = { actorId: ctx.actorId, via: ctx.via ?? 'compat', now: ctx.now, lenient: true } as const
  const given = want.assigneeId !== undefined
  const statusChanged = status !== undefined && status !== task.status
  const assigneeChanged = given && want.assigneeId !== task.assigneeId

  const finish = (r: PlanResult, finalStatus?: TaskStatus): Plan => {
    if (!r.ok) return { patch: {}, handoff: null }
    const patch: BallPatch = { ...r.plan.patch }
    if (finalStatus && !isClosed(finalStatus)) patch.status = finalStatus
    if (given && patch.assigneeId === undefined) patch.assigneeId = want.assigneeId
    return { patch, handoff: r.plan.handoff ? { ...r.plan.handoff, toId: patch.assigneeId !== undefined ? patch.assigneeId : task.assigneeId } : null }
  }

  if (statusChanged) {
    if (isClosed(status)) return finish(planHandoff(task, status === 'done' ? 'accept' : 'cancel', base))
    if (isClosed(task.status)) {
      const r = planHandoff(task, 'reopen', { ...base, to: given ? want.assigneeId : undefined })
      if (r.ok && status === 'review') r.plan.patch.move = 'review'
      if (r.ok && r.plan.handoff) r.plan.handoff.moveAfter = r.plan.patch.move ?? 'do'
      return finish(r, status)
    }
    if (status === 'review') {
      const owner = ownerOf(task)
      const to = given ? want.assigneeId : ctx.ownerInTeam && owner ? owner : task.assigneeId
      // Проверять некому — задача ни на ком и без владельца: только ход.
      if (!to) return { patch: { status, move: 'review' }, handoff: null }
      return finish(planHandoff(task, 'review', { ...base, to }), status)
    }
    if (task.move === 'review' || task.status === 'review' || task.status === 'verified') {
      const to = given ? want.assigneeId : (ctx.lastReviewFrom ?? task.assigneeId)
      if (to) return finish(planHandoff(task, 'return', { ...base, to }), status)
      // Вернуть некому — задача ни на ком: ход «сделать» без передачи.
      return { patch: { status, move: 'do' }, handoff: null }
    }
    // todo ↔ in_progress — движение внутри хода, не передача.
    if (!assigneeChanged) return { patch: { status }, handoff: null }
    return finish(planHandoff(task, 'pass', { ...base, to: want.assigneeId }), status)
  }

  if (assigneeChanged) return finish(planHandoff(task, 'pass', { ...base, to: want.assigneeId }))
  return { patch: {}, handoff: null }
}

/** Поля мяча новой задачи и строка «поставлена на человека». */
export function planCreate(
  values: { status?: TaskStatus | null; assigneeId?: string | null; createdById?: string | null; ownerId?: string | null },
  ctx: { actorId: string | null; via?: Via; now?: Date },
): { fields: BallPatch; handoff: Omit<HandoffRow, 'taskId' | 'projectId'> | null } {
  const now = ctx.now ?? new Date()
  const status: TaskStatus = values.status === 'verified' ? 'done' : (values.status ?? 'todo')
  const assigneeId = values.assigneeId ?? null
  const move: TaskMove = status === 'review' ? 'review' : 'do'
  const fields: BallPatch = {
    status,
    assigneeId,
    move,
    ownerId: values.ownerId ?? values.createdById ?? null,
    heldSince: assigneeId ? now : null,
  }
  const handoff = assigneeId
    ? {
        action: 'create' as const,
        actorId: ctx.actorId,
        fromId: null,
        toId: assigneeId,
        moveBefore: null,
        moveAfter: move,
        note: '',
        round: 1,
        via: ctx.via ?? 'ui',
        createdAt: now,
      }
    : null
  return { fields, handoff }
}

// --- Запись -------------------------------------------------------------------

/** Кто последним отправил задачу на проверку: ему её и возвращают. */
export async function lastReviewFrom(taskId: string): Promise<string | null> {
  const row = await db
    .select({ fromId: taskHandoffs.fromId })
    .from(taskHandoffs)
    .where(and(eq(taskHandoffs.taskId, taskId), eq(taskHandoffs.action, 'review')))
    .orderBy(desc(taskHandoffs.createdAt))
    .limit(1)
  return row[0]?.fromId ?? null
}

async function inTeam(projectId: string, userId: string): Promise<boolean> {
  const m = await db.query.projectMembers.findFirst({
    where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)),
  })
  return Boolean(m)
}

/**
 * Применить план: поля задачи и строку журнала — одной транзакцией.
 *
 * Обновление идёт с условием «мяч всё ещё там, где мы его видели»: два
 * человека, нажавшие одновременно, не должны оба передать один мяч. Второй
 * получает 'conflict' и перечитывает задачу.
 */
async function apply(task: Task, plan: Plan, other: Record<string, unknown> = {}): Promise<Task | null> {
  const set = { ...other, ...plan.patch }
  if (!Object.keys(set).length) return task
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(tasks)
      .set({ ...set, updatedAt: new Date() })
      .where(
        and(
          eq(tasks.id, task.id),
          sql`${tasks.assigneeId} is not distinct from ${task.assigneeId}`,
          eq(tasks.move, task.move),
          eq(tasks.status, task.status),
        ),
      )
      .returning()
    if (!row) return null
    if (plan.handoff) await tx.insert(taskHandoffs).values(plan.handoff)
    return row
  })
}

export type HandoffResult = { ok: true; task: Task; handoff: HandoffRow | null } | { ok: false; error: BallError }

/**
 * Ход мяча: «На проверку», «Принять», «Вернуть», «Спросить», «Ответить»,
 * «Передать», «Забрать», «Ждём клиента», «Отменить», «Открыть заново».
 *
 * Права роли в задаче проверяются здесь (mayHandoff), базовые права проекта —
 * у вызывающего маршрута.
 */
export async function handoff(
  task: Task,
  action: HandoffAction,
  input: HandoffInput & { actorId: string; isManager: boolean },
): Promise<HandoffResult> {
  if (!mayHandoff(action, task, input.actorId, input.isManager)) return { ok: false, error: 'forbidden' }
  // «Вернуть» без адресата — тому, кто отправлял на проверку.
  const to = action === 'return' && input.to === undefined ? ((await lastReviewFrom(task.id)) ?? undefined) : input.to
  const r = planHandoff(task, action, { ...input, to })
  if (!r.ok) return r
  // Мяч уходит только человеку из команды проекта: иначе задача повисла бы на
  // том, кто её даже не видит. Снять в бэклог (null) можно всегда.
  const target = r.plan.patch.assigneeId
  if (target && target !== task.assigneeId && !(await inTeam(task.projectId, target))) return { ok: false, error: 'not_member' }
  const row = await apply(task, r.plan)
  if (!row) return { ok: false, error: 'conflict' }
  return { ok: true, task: row, handoff: r.plan.handoff }
}

/**
 * Правка задачи со старыми полями. Поля мяча (status, assigneeId) уходят через
 * planCompat, остальное пишется как есть. Один update, одна строка журнала.
 *
 * Гонку здесь не считаем ошибкой: старые клиенты на «conflict» не рассчитаны.
 * Перечитываем задачу и применяем ещё раз — правка «как прислали» побеждает,
 * как и было до v2.
 */
export async function updateTask(
  existing: Task,
  patch: Record<string, unknown>,
  ctx: { actorId: string | null; via?: Via },
): Promise<{ task: Task; handoff: HandoffRow | null }> {
  const { status, assigneeId, ...other } = patch
  for (const k of BALL_FIELDS) if (k in other) throw new Error(`updateTask: ${k} is managed by the ball`)

  let current = existing
  for (let attempt = 0; attempt < 3; attempt++) {
    const want: LegacyBallPatch = {}
    if (status !== undefined) want.status = status as TaskStatus
    if (assigneeId !== undefined) want.assigneeId = assigneeId as string | null
    const needsOwner = want.status === 'review' && want.assigneeId === undefined
    const owner = ownerOf(current)
    const plan = planCompat(current, want, {
      actorId: ctx.actorId,
      via: ctx.via,
      ownerInTeam: needsOwner && owner ? await inTeam(current.projectId, owner) : false,
      lastReviewFrom:
        want.status && want.status !== 'review' && !isClosed(want.status) && current.move === 'review'
          ? await lastReviewFrom(current.id)
          : null,
    })
    const row = await apply(current, plan, other)
    if (row) return { task: row, handoff: plan.handoff }
    const fresh = await db.query.tasks.findFirst({ where: eq(tasks.id, existing.id) })
    if (!fresh) return { task: existing, handoff: null }
    current = fresh
  }
  throw new Error(`updateTask: task ${existing.id} keeps changing under us`)
}

/**
 * Новая задача. Поля мяча — из planCreate: владелец = автор, ход по статусу,
 * «с какого момента у держателя» = сейчас. Если задачу сразу поставили на
 * человека, в журнал ложится «создал и передал».
 */
export async function insertTask(
  values: typeof tasks.$inferInsert,
  ctx: { actorId: string | null; via?: Via },
): Promise<Task> {
  const { fields, handoff: h } = planCreate(
    { status: values.status, assigneeId: values.assigneeId, createdById: values.createdById, ownerId: values.ownerId },
    ctx,
  )
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(tasks)
      .values({ ...values, ...fields })
      .returning()
    if (h) await tx.insert(taskHandoffs).values({ ...h, taskId: row!.id, projectId: row!.projectId })
    return row!
  })
}

/**
 * «На столе» — срочное держателя, отдельно на главном экране.
 *
 * Не больше трёх: стол, на котором лежит всё, ничего не выделяет. Четвёртое
 * положить нельзя, пока не уберёшь одно, — это и есть смысл лимита, а не
 * техническое ограничение. Считаем по держателю: стол — его, и пометка едет
 * вместе с мячом. Если пришло сверх лимита (передали срочное), ничего не
 * снимаем молча — держатель сам решит, что убрать.
 *
 * Класть может держатель, владелец и управляющий проектом.
 */
export const TABLE_LIMIT = 3

export type TableResult = { ok: true; task: Task } | { ok: false; error: 'forbidden' | 'closed' | 'no_holder' | 'table_full' }

export async function setOnTable(task: Task, on: boolean, actorId: string, isManager: boolean): Promise<TableResult> {
  const holder = task.assigneeId === actorId
  if (!holder && ownerOf(task) !== actorId && !isManager) return { ok: false, error: 'forbidden' }
  if (task.onTable === on) return { ok: true, task }
  if (on) {
    if (isClosed(task.status)) return { ok: false, error: 'closed' }
    if (!task.assigneeId) return { ok: false, error: 'no_holder' }
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(
        and(
          eq(tasks.assigneeId, task.assigneeId),
          eq(tasks.onTable, true),
          sql`${tasks.deletedAt} is null`,
          sql`${tasks.status} not in ${closedSql}`,
        ),
      )
    if ((row?.n ?? 0) >= TABLE_LIMIT) return { ok: false, error: 'table_full' }
  }
  const [row] = await db.update(tasks).set({ onTable: on, updatedAt: new Date() }).where(eq(tasks.id, task.id)).returning()
  return { ok: true, task: row! }
}

/**
 * Человек ушёл из проекта — его мячи не должны повиснуть.
 *
 * Без этого задачи ушедшего остаются «на нём»: в его списке их больше никто
 * не видит, в чужих — тоже, и работа молча встаёт. Удаление при этом не
 * блокируем: Atlas убирает людей сам, и отказ сломал бы ему синхронизацию.
 *
 *   держал мяч        → владельцу задачи, если тот в команде; иначе владельцу
 *                       проекта; иначе в бэклог;
 *   был владельцем    → владение переходит владельцу проекта: иначе «на
 *                       проверку» уходить некому;
 *   задал вопрос      → ответ вернётся владельцу задачи (askFromId снимаем).
 *
 * Каждая передача — строка журнала via='system'. Возвращает, кому сколько
 * задач досталось, — для одного сводного уведомления на человека.
 */
export async function releaseBalls(
  projectId: string,
  userId: string,
  actorId: string | null,
): Promise<{ moved: Map<string, number>; tasks: number }> {
  const team = await db
    .select({ userId: projectMembers.userId, role: projectMembers.role })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId))
  const inTeamNow = new Set(team.map((m) => m.userId).filter((id) => id !== userId))
  const projectOwner = team.find((m) => m.role === 'owner' && m.userId !== userId)?.userId ?? null
  const moved = new Map<string, number>()
  let count = 0

  const open = and(eq(tasks.projectId, projectId), sql`${tasks.deletedAt} is null`, sql`${tasks.status} not in ${closedSql}`)

  // Владение — до передачи мячей: ниже «владелец» уже новый.
  await db
    .update(tasks)
    .set({ ownerId: projectOwner, updatedAt: new Date() })
    .where(and(open, sql`coalesce(${tasks.ownerId}, ${tasks.createdById}) = ${userId}`))
  await db.update(tasks).set({ askFromId: null }).where(and(open, eq(tasks.askFromId, userId)))

  const held = await db.select().from(tasks).where(and(open, eq(tasks.assigneeId, userId)))
  for (const t of held) {
    const owner = ownerOf(t)
    const to = owner && inTeamNow.has(owner) ? owner : projectOwner
    const r = planHandoff(t, 'pass', { actorId, to, via: 'system', lenient: true })
    if (!r.ok) continue
    // Ход «ответить» без спросившего превращается в «сделать»: ответ некому.
    if (t.move === 'answer' && !t.askFromId) r.plan.patch.move = 'do'
    if (r.plan.handoff) r.plan.handoff.moveAfter = r.plan.patch.move ?? t.move
    const row = await apply(t, r.plan)
    if (!row) continue
    count++
    if (to) moved.set(to, (moved.get(to) ?? 0) + 1)
  }
  return { moved, tasks: count }
}
