import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { buildType, isLiveStage } from '../lib/release-stages.js'
import { companyOf, projectPath } from '../lib/links.js'
import { db } from '../db/client.js'
import { activityLog, credentials, files, projectMembers, projects, taskBlockers, taskChecklist, taskComments, taskGroups, taskLinks, taskNotes, taskResources, tasks, users, taskReleases, releases } from '../db/schema.js'
import { requireProject, requireSession, type ProjectEnv, type SessionEnv } from '../auth.js'
import { hasPermission, ownsOrManages } from './projects.js'
import { improveTask, validateTask, generateTaskNotes } from '../lib/llm.js'
import { buildTeamContext } from '../lib/memory.js'
import { notify, extractMentions, dropNotice, commentWatchers, checklistAnswerWatchers } from '../lib/notify.js'
import { setDue } from '../lib/notify-config.js'
import { broadcast, tasksChanged } from '../ws.js'
import { logActivity } from '../lib/audit.js'
import { postTaskDone, postTaskAssigned } from '../lib/task-events.js'
import { richText } from '../lib/markdown.js'
import { normalizeRefs, MAX_REFS_LENGTH } from '../lib/task-refs.js'

// Задачи проекта — project-токен; права per-user (SPEC §4.3) на каждое действие
export const tasksRoute = new Hono<ProjectEnv>()
tasksRoute.use('*', requireProject)

const STATUSES = ['todo', 'in_progress', 'review', 'verified', 'done'] as const
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

const taskShape = {
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).default(''),
  status: z.enum(STATUSES).default('todo'),
  priority: z.enum(PRIORITIES).default('normal'),
  sortOrder: z.number().optional(),
  dueDate: z.string().datetime({ offset: true }).nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  groupId: z.string().nullable().optional(),
  estimateMinutes: z.number().int().min(0).max(100000).nullable().optional(),
  // Свои номера задачи: экраны в макете, пункты договора. Разбор — по запятой.
  refs: z.string().max(MAX_REFS_LENGTH).optional(),
}

/**
 * Задачу сняли с человека — снять и уведомление о назначении.
 *
 * Иначе в колокольчике висит «вам назначили задачу» про задачу, к которой он
 * уже не имеет отношения: открывает и не понимает, чего от него хотят.
 * Одна функция на все точки, где меняется исполнитель, — их несколько (форма,
 * доска, мост), и разойтись им нельзя.
 */
export function unassignNotice(userId: string, taskId: string): Promise<void> {
  return dropNotice({
    userId,
    event: 'task_assigned',
    entityId: taskId,
    dedupeKey: `task_assigned:${taskId}:${userId}`,
  })
}

/**
 * На пункт чек-листа ответили — сказать тем, кто задачу ведёт.
 *
 * Раньше не говорили никому. У checklistAccess это записано допущением:
 * «человек и так смотрит на свою задачу». Верно, пока задачу ведёт человек;
 * задачу, заведённую ассистентом, не «смотрит» никто, и ответ оставался в
 * пункте навсегда. Отвечавшему приходилось писать отдельный комментарий «я
 * ответил в пунктах» — когда человек дублирует уведомление руками, механизма
 * нет.
 *
 * ОДНА запись на задачу, а не на пункт. Ответ на десять вопросов — это десять
 * заметок за минуту, и десять строк в колокольчике про одну задачу похоронили
 * бы всё остальное. Ключ дедупа общий на задачу, поэтому dropNotice сначала:
 * при занятом ключе notify молча пропускает повтор (см. `continue` в notify),
 * и человек навсегда остался бы с текстом ПЕРВОГО ответа.
 *
 * Прочитанное dropNotice не трогает — и это правильно: человек уже видел ту
 * запись, она была правдой. Ключ при этом освобождается, и следующий ответ
 * заводит новую. Свёртка работает там, где нужна: пока не смотрели.
 *
 * Ключ БЕЗ userId: и notify, и dropNotice доклеивают его сами. С ним вышло бы
 * `checklist_answer:task:user:user`, и dropNotice не нашёл бы ничего — молча.
 *
 * Одна функция на оба пути записи: веб (форма задачи) и мост (ассистент).
 */
export async function checklistAnswerNotice(input: {
  projectId: string
  task: typeof tasks.$inferSelect
  actorId: string
  /** Текст пункта — попадёт в заголовок: «ответили в TASK-81» не говорит, на что. */
  itemText: string
  /** Сам ответ, размеченный: превью очистит notify. */
  note: string
}): Promise<void> {
  const { projectId, task, actorId, itemText, note } = input
  const recipients = checklistAnswerWatchers({
    assigneeId: task.assigneeId,
    createdById: task.createdById,
    actorId,
  })
  if (!recipients.length) return

  const dedupeKey = `checklist_answer:${task.id}`
  for (const userId of recipients) {
    await dropNotice({ userId, event: 'checklist_answer', entityId: task.id, dedupeKey })
  }

  const actor = await db.query.users.findFirst({ where: eq(users.id, actorId) })
  await notify({
    projectId,
    event: 'checklist_answer',
    recipientIds: recipients,
    actorId,
    actorName: actor?.name || 'Someone',
    dedupeKey,
    entityType: 'task',
    entityId: task.id,
    link: projectPath((await companyOf(projectId)) ?? '', projectId, `/tasks/${task.id}`),
    preview: note,
    // Длинный пункт в заголовке не читается — обрезаем здесь, а не в шаблоне:
    // шаблон один на три языка, а правило обрезки одно на все шаблоны.
    vars: { ref: task.number, item: itemText.length > 60 ? `${itemText.slice(0, 60)}…` : itemText },
  })
}

// Уведомления по задаче: назначение, смена статуса, упоминания в описании (SPEC §8.9).
export async function notifyTask(
  projectId: string,
  actorId: string,
  task: typeof tasks.$inferSelect,
  opts: { assigneeChanged?: boolean; statusChanged?: boolean; mentions?: boolean },
) {
  const actor = await db.query.users.findFirst({ where: eq(users.id, actorId) })
  const actorName = actor?.name || 'Someone'
  const link = projectPath((await companyOf(projectId)) ?? '', projectId, `/tasks/${task.id}`)

  if (opts.assigneeChanged && task.assigneeId) {
    await notify({
      projectId,
      event: 'task_assigned',
      recipientIds: [task.assigneeId],
      actorId,
      actorName,
      dedupeKey: `task_assigned:${task.id}:${task.assigneeId}`,
      entityType: 'task',
      entityId: task.id,
      link,
      preview: task.title,
    })
  }
  // Смена статуса касается двоих: исполнителя и того, кто задачу поставил.
  //
  // Раньше уведомляли только исполнителя, и типичный случай выпадал целиком:
  // я поставил задачу Талю, Таль перевёл её в ревью — и я об этом не узнаю,
  // хотя ревью ждут именно от меня. Заказчик работы молча оставался в
  // неведении о её ходе.
  //
  // notify сам выбрасывает актора и повторы, поэтому список можно собирать
  // прямолинейно: сменил статус исполнитель — уйдёт автору, сменил автор —
  // уйдёт исполнителю, сменил кто-то третий — обоим.
  const statusRecipients = [task.assigneeId, task.createdById].filter((id): id is string => Boolean(id))
  if (opts.statusChanged && statusRecipients.length) {
    await notify({
      projectId,
      event: 'task_status',
      recipientIds: statusRecipients,
      actorId,
      actorName,
      // Ключ без получателя: notify дописывает id адресата сам. Прежний
      // вариант с assigneeId внутри давал бы его дважды, и автор с
      // исполнителем перестали бы различаться при дедупе.
      dedupeKey: `task_status:${task.id}:${task.status}`,
      entityType: 'task',
      entityId: task.id,
      link,
      preview: task.title,
      vars: { ref: task.number, status: task.status },
    })
  }
  if (opts.mentions) {
    const mentioned = extractMentions(task.description)
    if (mentioned.length) {
      await notify({
        projectId,
        event: 'task_mention',
        recipientIds: mentioned,
        actorId,
        actorName,
        dedupeKey: `task_mention:${task.id}`,
        entityType: 'task',
        entityId: task.id,
        link,
        preview: task.title,
      })
    }
  }
}

function serialize(row: typeof tasks.$inferSelect, assignee?: typeof users.$inferSelect | null) {
  return {
    id: row.id,
    number: row.number,
    groupId: row.groupId,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    estimateMinutes: row.estimateMinutes ? Number(row.estimateMinutes) : null,
    refs: row.refs,
    sortOrder: row.sortOrder,
    dueDate: row.dueDate,
    assignee: assignee ? { id: assignee.id, name: assignee.name, avatarUrl: assignee.avatarUrl } : null,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// Список задач проекта (фильтры — на клиенте, объём в рамках проекта небольшой)
tasksRoute.get('/', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.read'))) return c.json({ error: 'Forbidden' }, 403)
  const rows = await db
    .select({
      task: tasks,
      assignee: users,
      attachmentsCount: sql<number>`(select count(*)::int from ${files} where ${files.taskId} = ${tasks.id} and ${files.deletedAt} is null)`,
      // Зависимости считаем здесь, а не отдельным запросом на каждую строку:
      // значок нужен КАЖДОЙ задаче в списке, и N+1 запросов на таблицу в
      // тысячу задач — это секунды ожидания.
      //
      // blockedBy — сколько НЕЗАКРЫТЫХ задач она ждёт: замочек должен гаснуть
      // сам, когда блокеры завершены, а связь при этом остаётся.
      // blocking — сколько ждут ЕЁ, независимо от их статуса: это мера того,
      // насколько задача держит проект.
      //
      // Ссылка на внешнюю строку — через "tasks"."id" ЯВНО, а не через
      // ${tasks.id}.
      //
      // Подзапрос снова заходит в tasks (нужен статус блокера), и голое «id»
      // разрешилось бы во внутреннюю таблицу: Postgres отвечает «column
      // reference is ambiguous», и весь список падает с 500. Здесь это до сих
      // пор работало СЛУЧАЙНО — из-за leftJoin(users) drizzle подставлял
      // квалифицированное имя. Убери join, и запрос сломается. В мосте такого
      // join не было, и он сломался. Поэтому квалифицируем руками.
      blockedBy: sql<number>`(
        select count(*)::int from ${taskBlockers} b
        join ${tasks} bt on bt.id = b.blocker_task_id
        where b.blocked_task_id = "tasks"."id"
          and bt.status <> 'done' and bt.deleted_at is null
      )`,
      blocking: sql<number>`(
        select count(*)::int from ${taskBlockers} b
        join ${tasks} dt on dt.id = b.blocked_task_id
        where b.blocker_task_id = "tasks"."id" and dt.deleted_at is null
      )`,
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .where(and(eq(tasks.projectId, projectId), sql`${tasks.deletedAt} is null`))
    .orderBy(asc(tasks.sortOrder), desc(tasks.createdAt))

  // Привязанные ресурсы — одним запросом на весь список, а не по одному на
  // задачу: доски бывают в сотню строк.
  //
  // Только имя и ссылка. Есть ли под ресурсом секреты и кому они открыты —
  // решает сам ресурс; задача лишь показывает, что доступ где-то лежит.
  const taskIds = rows.map((r) => r.task.id)
  const resourceRows = taskIds.length
    ? await db
        .select({
          taskId: taskResources.taskId,
          id: credentials.id,
          name: credentials.name,
          url: credentials.url,
        })
        .from(taskResources)
        .innerJoin(credentials, eq(credentials.id, taskResources.resourceId))
        .where(and(inArray(taskResources.taskId, taskIds), isNull(credentials.deletedAt)))
    : []
  const byTask = new Map<string, { id: string; name: string; url: string | null }[]>()
  for (const r of resourceRows) {
    const list = byTask.get(r.taskId) ?? []
    list.push({ id: r.id, name: r.name, url: r.url })
    byTask.set(r.taskId, list)
  }

  // Версии задачи — со стадией.
  //
  // Стадия здесь не украшение: «эта задача уедет в 1.4» без ответа на «а где
  // сейчас 1.4» заставляет открывать вкладку версий ради одного слова.
  const releaseRows = taskIds.length
    ? await db
        .select({ taskId: taskReleases.taskId, r: releases })
        .from(taskReleases)
        .innerJoin(releases, eq(releases.id, taskReleases.releaseId))
        .where(inArray(taskReleases.taskId, taskIds))
    : []
  const releasesByTask = new Map<
    string,
    { id: string; version: string; buildType: string; status: string; statusLabel: string; isLive: boolean }[]
  >()
  for (const row of releaseRows) {
    const list = releasesByTask.get(row.taskId) ?? []
    list.push({
      id: row.r.id,
      version: row.r.version,
      buildType: row.r.buildType,
      status: row.r.status,
      statusLabel: buildType(row.r.buildType)?.stages.find((s) => s.key === row.r.status)?.label ?? row.r.status,
      isLive: isLiveStage(row.r.buildType, row.r.status),
    })
    releasesByTask.set(row.taskId, list)
  }

  return c.json(
    rows.map((r) => ({
      ...serialize(r.task, r.assignee),
      attachmentsCount: r.attachmentsCount,
      blockedBy: r.blockedBy,
      blocking: r.blocking,
      resources: byTask.get(r.task.id) ?? [],
      releases: releasesByTask.get(r.task.id) ?? [],
    })),
  )
})

// Создать — tasks.create
tasksRoute.post('/', zValidator('json', z.object(taskShape)), async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.create'))) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')

  // aiConfig.improveTasks: адаптировать под язык проекта + слегка улучшить (fail-open)
  let { title, description } = body
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  const aiConfig = JSON.parse(project?.aiConfig || '{}') as { improveTasks?: boolean; generateTaskNotes?: boolean; language?: string }
  let aiImproved = false
  if (aiConfig.improveTasks) {
    const improved = await improveTask(projectId, { title, description, language: aiConfig.language ?? 'en' })
    if (improved) {
      title = improved.title
      description = improved.description
      aiImproved = true
    }
  }

  // порядковый номер в рамках проекта: TASK-<max+1>; новая задача — наверх группы
  const [{ next, minSort }] = (await db
    .select({
      next: sql<number>`coalesce(max(cast(substring(${tasks.number} from 6) as int)), 0) + 1`,
      minSort: sql<number>`coalesce(min(${tasks.sortOrder}), 0)`,
    })
    .from(tasks)
    .where(eq(tasks.projectId, projectId))) as [{ next: number; minSort: number }]

  const [row] = await db
    .insert(tasks)
    .values({
      projectId,
      number: `TASK-${next}`,
      sortOrder: minSort - 1,
      title,
      description,
      status: body.status,
      priority: body.priority,
      dueDate: body.dueDate ? new Date(body.dueDate) : null,
      assigneeId: body.assigneeId ?? null,
      groupId: body.groupId ?? null,
      estimateMinutes: body.estimateMinutes != null ? String(body.estimateMinutes) : null,
      refs: body.refs ? normalizeRefs(body.refs) : '',
      createdById: sub,
    })
    .returning()

  const assignee = row!.assigneeId ? await db.query.users.findFirst({ where: eq(users.id, row!.assigneeId) }) : null
  void notifyTask(projectId, sub, row!, { assigneeChanged: Boolean(row!.assigneeId), mentions: true })

  // Заметки ИИ (SPEC §8.14): генерируем в фоне, только если включено; broadcast не нужен — клиент подтянет
  if (aiConfig.generateTaskNotes) {
    void (async () => {
      try {
        const teamContext = await buildTeamContext(projectId)
        const notes = await generateTaskNotes(projectId, { title, description, language: aiConfig.language ?? 'en', teamContext })
        if (notes && notes.length) {
          await db.insert(taskNotes).values(notes.map((n) => ({ taskId: row!.id, projectId, kind: n.kind, body: n.body })))
        }
      } catch (e) {
        console.error('[tasks] generateTaskNotes failed:', e)
      }
    })()
  }

  tasksChanged(projectId, [row!.assigneeId, row!.createdById])
  void logActivity({ projectId, actorId: sub, action: 'create', entityType: 'task', entityId: row!.id, entityLabel: `${row!.number}: ${row!.title}` })
  // назначил на кого-то при создании → автосообщение в чат (SPEC §8.23)
  if (row!.assigneeId) void postTaskAssigned(projectId, sub, row!.assigneeId, row!)
  return c.json({ ...serialize(row!, assignee), aiImproved, notesPending: Boolean(aiConfig.generateTaskNotes) }, 201)
})

// Обновить: смена только статуса — tasks.changeStatus; всё остальное — tasks.edit
/**
 * Порядок задач и групп целиком.
 *
 * Раньше клиент считал новый sortOrder как середину между соседями и слал один
 * PATCH. Пока значения различаются — работает; но у всех задач проекта
 * sort_order по умолчанию 0, а середина между нулями — тоже ноль. Перетащенная
 * карточка возвращалась на место, и выглядело это как сломанный драг. То же у
 * групп: у них порядок был нулевым поголовно.
 *
 * Поэтому порядок задаём списком идентификаторов и нумеруем на сервере. Заодно
 * уходит вторая беда: пачка PATCH по одному обновляла список после каждого, и
 * карточка успевала съездить назад и вернуться.
 */
tasksRoute.patch(
  '/reorder',
  zValidator(
    'json',
    z.object({
      // Список задач в нужном порядке. groupId передаётся, когда карточку
      // перенесли в другую группу: одной операцией и порядок, и переезд.
      tasks: z.array(z.object({ id: z.string(), groupId: z.string().nullable().optional() })).max(1000).optional(),
      groups: z.array(z.string()).max(200).optional(),
    }),
  ),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    if (!(await hasPermission(projectId, sub, 'tasks.edit'))) return c.json({ error: 'Forbidden' }, 403)
    const b = c.req.valid('json')

    if (b.groups?.length) {
      const own = await db.query.taskGroups.findMany({ where: eq(taskGroups.projectId, projectId) })
      const mine = new Set(own.map((g) => g.id))
      let i = 0
      for (const id of b.groups) {
        if (!mine.has(id)) continue // чужая группа не должна получить номер в этом проекте
        await db.update(taskGroups).set({ sortOrder: i++ }).where(eq(taskGroups.id, id))
      }
    }

    if (b.tasks?.length) {
      const ids = b.tasks.map((x) => x.id)
      const own = await db.query.tasks.findMany({
        where: and(eq(tasks.projectId, projectId), inArray(tasks.id, ids), isNull(tasks.deletedAt)),
      })
      const byId = new Map(own.map((t) => [t.id, t]))
      let i = 0
      for (const item of b.tasks) {
        const row = byId.get(item.id)
        if (!row) continue
        const patch: Record<string, unknown> = { sortOrder: i++ }
        // groupId трогаем, только если он ПРИСЛАН: иначе перестановка внутри
        // группы обнуляла бы принадлежность всем задачам списка.
        if (item.groupId !== undefined && (row.groupId ?? null) !== (item.groupId ?? null)) {
          patch.groupId = item.groupId ?? null
        }
        await db.update(tasks).set(patch).where(eq(tasks.id, row.id))
      }
    }

    broadcast(projectId, 'tasks_changed', {})
    return c.json({ ok: true })
  },
)

tasksRoute.patch(
  '/:taskId',
  zValidator('json', z.object({ ...taskShape, title: taskShape.title.optional(), status: z.enum(STATUSES).optional(), priority: z.enum(PRIORITIES).optional(), description: z.string().max(10_000).optional() })),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    const taskId = c.req.param('taskId')
    const task = await db.query.tasks.findFirst({ where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)) })
    if (!task) return c.json({ error: 'Not found' }, 404)

    const body = c.req.valid('json')
    const keys = Object.keys(body)
    // drag: смена статуса/группы/порядка — по changeStatus (лёгкое перемещение на доске)
    const statusOnly = keys.every((k) => k === 'status' || k === 'sortOrder' || k === 'groupId')

    // Статус — любому, кто видит доску: отметить работу сделанной должен уметь
    // тот, кто её делает. Всё остальное — только в своей задаче: участник
    // распоряжается тем, что завёл сам или что назначено на него, а чужую
    // задачу не переписывает.
    const permitted = statusOnly
      ? (await hasPermission(projectId, sub, 'tasks.changeStatus')) || (await hasPermission(projectId, sub, 'tasks.edit'))
      : (await hasPermission(projectId, sub, 'tasks.edit')) &&
        (await ownsOrManages(projectId, sub, [task.createdById, task.assigneeId]))
    if (!permitted) return c.json({ error: 'Forbidden' }, 403)

    const patch: Record<string, unknown> = {}
    if (body.title !== undefined) patch.title = body.title
    if (body.description !== undefined) patch.description = body.description
    if (body.status !== undefined) patch.status = body.status
    if (body.priority !== undefined) patch.priority = body.priority
    if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder
    if (body.dueDate !== undefined) setDue(patch, body.dueDate ? new Date(body.dueDate) : null)
    if (body.assigneeId !== undefined) patch.assigneeId = body.assigneeId
    if (body.groupId !== undefined) patch.groupId = body.groupId
    if (body.estimateMinutes !== undefined) patch.estimateMinutes = body.estimateMinutes != null ? String(body.estimateMinutes) : null
    // Приводим к одному виду на записи: иначе «1,2» и «1, 2» лягут в базу
    // разными строками, и поиск по номеру находил бы то одну, то другую.
    if (body.refs !== undefined) patch.refs = normalizeRefs(body.refs)

    const [row] = await db.update(tasks).set(patch).where(eq(tasks.id, taskId)).returning()
    const assignee = row!.assigneeId ? await db.query.users.findFirst({ where: eq(users.id, row!.assigneeId) }) : null
    void notifyTask(projectId, sub, row!, {
      assigneeChanged: body.assigneeId !== undefined && body.assigneeId !== task.assigneeId && Boolean(row!.assigneeId),
      statusChanged: body.status !== undefined && body.status !== task.status,
      mentions: body.description !== undefined && body.description !== task.description,
    })
    // Сняли человека с задачи — снимаем и его уведомление о назначении.
    if (body.assigneeId !== undefined && task.assigneeId && body.assigneeId !== task.assigneeId)
      void unassignNotice(task.assigneeId, task.id)
    tasksChanged(projectId, [row!.assigneeId, row!.createdById, task.assigneeId])
    const act = body.status !== undefined && body.status !== task.status ? 'status' : body.assigneeId !== undefined ? 'assign' : 'update'
    /**
     * Пишем не только ЧТО менялось, но и НА ЧТО.
     *
     * Раньше в журнал ложилось `{changed:["status"]}` — «сменил статус», и ни
     * слова о том, на какой. Для ленты изменений этого мало: «Алекс сменил
     * статус» не отвечает на вопрос, ради которого туда смотрят.
     *
     * Оба значения лежат прямо здесь — task это до, row это после, — и стоило
     * их просто не выбросить. Старые записи так и останутся без значений:
     * задним числом их взять неоткуда.
     *
     * Только вехи: статус, исполнитель, срок, важность. Текст описания сюда не
     * кладём — он бывает в тысячи знаков, а журнал не хранилище версий.
     */
    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    if (body.status !== undefined && body.status !== task.status) {
      before.status = task.status
      after.status = row!.status
    }
    if (body.assigneeId !== undefined && body.assigneeId !== task.assigneeId) {
      before.assigneeId = task.assigneeId
      after.assigneeId = row!.assigneeId
    }
    if (body.priority !== undefined && body.priority !== task.priority) {
      before.priority = task.priority
      after.priority = row!.priority
    }
    if (body.dueDate !== undefined && String(body.dueDate ?? '') !== String(task.dueDate ?? '')) {
      before.dueDate = task.dueDate
      after.dueDate = row!.dueDate
    }
    void logActivity({
      projectId,
      actorId: sub,
      action: act,
      entityType: 'task',
      entityId: row!.id,
      entityLabel: `${row!.number}: ${row!.title}`,
      meta: {
        changed: Object.keys(patch),
        ...(Object.keys(after).length ? { before, after } : {}),
      },
    })

    // Автосообщения в чат о событиях задач (SPEC §8.23)
    if (body.status === 'done' && task.status !== 'done') void postTaskDone(projectId, sub, row!)
    if (body.assigneeId !== undefined && body.assigneeId && body.assigneeId !== task.assigneeId)
      void postTaskAssigned(projectId, sub, body.assigneeId, row!)

    return c.json(serialize(row!, assignee))
  },
)

// Удалить — tasks.delete
tasksRoute.delete('/:taskId', async (c) => {
  const { projectId, sub } = c.get('auth')
  const taskId = c.req.param('taskId')
  const task = await db.query.tasks.findFirst({ where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)) })
  if (!task) return c.json({ error: 'Not found' }, 404)

  // Свою задачу участник удаляет сам; чужую — только тот, у кого есть
  // tasks.delete. Удаление мягкое, восстановимо 7 дней.
  const canDeleteAny = await hasPermission(projectId, sub, 'tasks.delete')
  const canDeleteOwn =
    (await hasPermission(projectId, sub, 'tasks.create')) &&
    (await ownsOrManages(projectId, sub, [task.createdById, task.assigneeId]))
  if (!canDeleteAny && !canDeleteOwn) return c.json({ error: 'Forbidden' }, 403)

  // soft-delete (SPEC §8.21): восстановимо 7 дней
  await db.update(tasks).set({ deletedAt: new Date(), deletedById: sub }).where(eq(tasks.id, taskId))
  // Задачи больше нет в списках — уведомлению о ней там тоже делать нечего:
  // человек шёл бы по ссылке в пустоту. Восстановят — назначение уведомит
  // заново, журнал дедупа мы тоже чистим.
  if (task.assigneeId) void unassignNotice(task.assigneeId, task.id)
  void logActivity({ projectId, actorId: sub, action: 'delete', entityType: 'task', entityId: task.id, entityLabel: `${task.number}: ${task.title}` })
  tasksChanged(projectId, [task.assigneeId, task.createdById])
  return c.json({ ok: true })
})

// Корзина: удалённые задачи (восстановимые)
tasksRoute.get('/trash', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.read'))) return c.json({ error: 'Forbidden' }, 403)
  const rows = await db
    .select({ task: tasks, deleter: users })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.deletedById))
    .where(and(eq(tasks.projectId, projectId), sql`${tasks.deletedAt} is not null`))
    .orderBy(desc(tasks.deletedAt))
  return c.json(
    rows.map((r) => ({
      id: r.task.id,
      number: r.task.number,
      title: r.task.title,
      deletedAt: r.task.deletedAt,
      deletedBy: r.deleter ? { id: r.deleter.id, name: r.deleter.name, avatarUrl: r.deleter.avatarUrl } : null,
    })),
  )
})

// Восстановить задачу из корзины
tasksRoute.post('/:taskId/restore', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.delete'))) return c.json({ error: 'Forbidden' }, 403)
  const taskId = c.req.param('taskId')
  const task = await db.query.tasks.findFirst({ where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)) })
  if (!task) return c.json({ error: 'Not found' }, 404)
  await db.update(tasks).set({ deletedAt: null, deletedById: null }).where(eq(tasks.id, taskId))
  void logActivity({ projectId, actorId: sub, action: 'restore', entityType: 'task', entityId: task.id, entityLabel: `${task.number}: ${task.title}` })
  tasksChanged(projectId, [task.assigneeId, task.createdById])
  return c.json({ ok: true })
})

// --- Группы задач = спринты (SPEC §8.6) --------------------------------------

const HEX = /^#[0-9a-fA-F]{6}$/

// Список групп проекта
tasksRoute.get('/groups', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.read'))) return c.json({ error: 'Forbidden' }, 403)
  const rows = await db
    .select()
    .from(taskGroups)
    .where(eq(taskGroups.projectId, projectId))
    .orderBy(asc(taskGroups.sortOrder), asc(taskGroups.createdAt))
  return c.json(rows.map((g) => ({ id: g.id, name: g.name, color: g.color, sortOrder: g.sortOrder })))
})

// Создать группу — tasks.edit
tasksRoute.post(
  '/groups',
  zValidator('json', z.object({ name: z.string().min(1).max(120), color: z.string().regex(HEX).default('#64748b') })),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    if (!(await hasPermission(projectId, sub, 'tasks.edit'))) return c.json({ error: 'Forbidden' }, 403)
    const { name, color } = c.req.valid('json')
    const [{ minSort }] = (await db
      .select({ minSort: sql<number>`coalesce(min(${taskGroups.sortOrder}), 0)` })
      .from(taskGroups)
      .where(eq(taskGroups.projectId, projectId))) as [{ minSort: number }]
    const [row] = await db
      .insert(taskGroups)
      .values({ projectId, name, color, sortOrder: minSort - 1, createdById: sub })
      .returning()
    broadcast(projectId, 'tasks_changed', {})
    return c.json({ id: row!.id, name: row!.name, color: row!.color, sortOrder: row!.sortOrder }, 201)
  },
)

// Обновить группу (имя/цвет/порядок) — tasks.edit
tasksRoute.patch(
  '/groups/:groupId',
  zValidator(
    'json',
    z.object({ name: z.string().min(1).max(120).optional(), color: z.string().regex(HEX).optional(), sortOrder: z.number().optional() }),
  ),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    if (!(await hasPermission(projectId, sub, 'tasks.edit'))) return c.json({ error: 'Forbidden' }, 403)
    const groupId = c.req.param('groupId')
    const group = await db.query.taskGroups.findFirst({ where: and(eq(taskGroups.id, groupId), eq(taskGroups.projectId, projectId)) })
    if (!group) return c.json({ error: 'Not found' }, 404)
    const b = c.req.valid('json')
    const patch: Record<string, unknown> = {}
    if (b.name !== undefined) patch.name = b.name
    if (b.color !== undefined) patch.color = b.color
    if (b.sortOrder !== undefined) patch.sortOrder = b.sortOrder
    const [row] = await db.update(taskGroups).set(patch).where(eq(taskGroups.id, groupId)).returning()
    broadcast(projectId, 'tasks_changed', {})
    return c.json({ id: row!.id, name: row!.name, color: row!.color, sortOrder: row!.sortOrder })
  },
)

// Удалить группу — tasks.edit. Задачи не трогаем: groupId → null (остаются «без группы»)
tasksRoute.delete('/groups/:groupId', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.edit'))) return c.json({ error: 'Forbidden' }, 403)
  const groupId = c.req.param('groupId')
  const group = await db.query.taskGroups.findFirst({ where: and(eq(taskGroups.id, groupId), eq(taskGroups.projectId, projectId)) })
  if (!group) return c.json({ error: 'Not found' }, 404)
  await db.delete(taskGroups).where(eq(taskGroups.id, groupId)) // FK onDelete: set null
  broadcast(projectId, 'tasks_changed', {})
  return c.json({ ok: true })
})

// --- Заметки ИИ к задаче (SPEC §8.14) ----------------------------------------

// Список заметок ИИ по задаче
tasksRoute.get('/:taskId/notes', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.read'))) return c.json({ error: 'Forbidden' }, 403)
  const taskId = c.req.param('taskId')
  const rows = await db
    .select()
    .from(taskNotes)
    .where(and(eq(taskNotes.taskId, taskId), eq(taskNotes.projectId, projectId)))
    .orderBy(asc(taskNotes.createdAt))
  return c.json(rows.map((n) => ({ id: n.id, kind: n.kind, body: n.body, createdAt: n.createdAt })))
})

// Удалить заметку — tasks.edit (можно почистить нерелевантное)
tasksRoute.delete('/:taskId/notes/:noteId', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.edit'))) return c.json({ error: 'Forbidden' }, 403)
  const { noteId } = c.req.param()
  await db.delete(taskNotes).where(and(eq(taskNotes.id, noteId), eq(taskNotes.projectId, projectId)))
  return c.json({ ok: true })
})

// Перегенерировать заметки вручную (tasks.edit): удаляет старые ИИ-заметки и создаёт новые
tasksRoute.post('/:taskId/notes/regenerate', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.edit'))) return c.json({ error: 'Forbidden' }, 403)
  const taskId = c.req.param('taskId')
  const task = await db.query.tasks.findFirst({ where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)) })
  if (!task) return c.json({ error: 'Not found' }, 404)
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  const language = (JSON.parse(project?.aiConfig || '{}') as { language?: string }).language ?? 'en'
  const teamContext = await buildTeamContext(projectId)
  const notes = await generateTaskNotes(projectId, { title: task.title, description: task.description, language, teamContext })
  if (notes === null) return c.json({ error: 'AI unavailable' }, 503)
  await db.delete(taskNotes).where(and(eq(taskNotes.taskId, taskId), eq(taskNotes.projectId, projectId)))
  if (notes.length) await db.insert(taskNotes).values(notes.map((n) => ({ taskId, projectId, kind: n.kind, body: n.body })))
  return c.json({ count: notes.length })
})

// --- Комментарии задач (SPEC §8.9) -------------------------------------------

async function commentFiles(commentIds: string[]) {
  if (!commentIds.length) return new Map<string, { id: string; name: string; mime: string; deleted: boolean }[]>()
  const rows = await db.query.files.findMany({ where: sql`${files.commentId} in (${sql.join(commentIds.map((id) => sql`${id}`), sql`, `)})` })
  const map = new Map<string, { id: string; name: string; mime: string; deleted: boolean }[]>()
  for (const f of rows) {
    if (!f.commentId) continue
    const arr = map.get(f.commentId) ?? []
    arr.push({ id: f.id, name: f.name, mime: f.mime, deleted: Boolean(f.deletedAt) })
    map.set(f.commentId, arr)
  }
  return map
}

// Список комментариев задачи
// --- чек-лист задачи (SPEC §8.37) -------------------------------------------
//
// Права те же, что у самой задачи: чек-лист — её часть, а не отдельная
// сущность со своим доступом.
//
// Уведомление есть ровно одно — «на пункт ответили» (checklistAnswerNotice).
// Раньше не было ни одного, с доводом «человек и так смотрит на свою задачу».
// Довод оказался неверен: задачу, заведённую ассистентом, не смотрит никто, и
// ответ оставался в пункте навсегда. Галочка и правка текста уведомлений
// по-прежнему не создают — это не сообщение никому.
//
// Отметить галочку и написать ответ может каждый, кто задачу ВИДИТ. Чек-лист
// здесь — способ спросить: «каким ключом подписывать?» пишет один, а знает
// ответ обычно другой, и требовать от него права править задачу — значит
// закрыть единственный путь, ради которого пункт и заведён.
//
// Состав списка — другое дело: добавить пункт, переписать формулировку,
// переставить или удалить может только тот, кто правит саму задачу. Иначе
// человек с одним лишь доступом на чтение переписывал бы её содержание.

/** Есть ли доступ к задаче и можно ли её менять. */
async function checklistAccess(projectId: string, taskId: string, userId: string) {
  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId), isNull(tasks.deletedAt)),
  })
  if (!task) return { error: 'Not found', status: 404 as const }
  if (!(await hasPermission(projectId, userId, 'tasks.read'))) return { error: 'Forbidden', status: 403 as const }
  return { task }
}

const checklistItem = (r: typeof taskChecklist.$inferSelect, who?: { id: string; name: string } | null) => ({
  id: r.id,
  text: r.text,
  note: r.note,
  done: r.done,
  doneBy: who ? { id: who.id, name: who.name } : null,
  doneAt: r.doneAt,
  sortOrder: r.sortOrder,
})

/**
 * История задачи: путь от «завели» до «сдана».
 *
 * Только ВЕХИ. Перетаскивание в списке и правка описания сюда не попадают:
 * у TASK-1 девять записей «изменил» подряд за две минуты — это мышь двигала
 * задачу по списку, и в ленте это шум, за которым не видно настоящих шагов.
 *
 * Значения (было → стало) есть только у записей после этой правки: раньше в
 * журнал ложилось лишь имя поля. Старые показываем как есть — «сменил
 * статус», без подробностей; врать о них нечем.
 */
tasksRoute.get('/:taskId/history', async (c) => {
  const { projectId, sub } = c.get('auth')
  const access = await checklistAccess(projectId, c.req.param('taskId'), sub)
  if ('error' in access) return c.json({ error: access.error }, access.status)

  const rows = await db
    .select({ a: activityLog, actor: users })
    .from(activityLog)
    .leftJoin(users, eq(users.id, activityLog.actorId))
    .where(
      and(
        eq(activityLog.projectId, projectId),
        eq(activityLog.entityType, 'task'),
        eq(activityLog.entityId, access.task.id),
      ),
    )
    .orderBy(asc(activityLog.createdAt))
    .limit(200)

  /** Правка, не менявшая ничего значимого, — это перетаскивание или текст. */
  const isMilestone = (action: string, meta: { changed?: string[] } | null) => {
    if (action !== 'update') return true
    const changed = meta?.changed ?? []
    return changed.some((f) => ['status', 'assigneeId', 'dueDate', 'priority', 'groupId', 'estimateMinutes'].includes(f))
  }

  const items = rows
    .map((r) => ({
      id: r.a.id,
      action: r.a.action,
      meta: (r.a.meta ? JSON.parse(r.a.meta) : null) as
        | { changed?: string[]; before?: Record<string, unknown>; after?: Record<string, unknown> }
        | null,
      createdAt: r.a.createdAt,
      // actor = null означает ИИ или систему — так же, как в общем журнале.
      actor: r.actor ? { id: r.actor.id, name: r.actor.name, avatarUrl: r.actor.avatarUrl } : null,
    }))
    .filter((x) => isMilestone(x.action, x.meta))

  // Имена людей из before/after: в журнале лежат id, а читать надо имена.
  const ids = new Set<string>()
  for (const x of items) {
    for (const side of [x.meta?.before, x.meta?.after]) {
      const v = side?.assigneeId
      if (typeof v === 'string') ids.add(v)
    }
  }
  const people = ids.size
    ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...ids]))
    : []

  return c.json({ items, people: Object.fromEntries(people.map((p) => [p.id, p.name])) })
})

tasksRoute.get('/:taskId/checklist', async (c) => {
  const { projectId, sub } = c.get('auth')
  const access = await checklistAccess(projectId, c.req.param('taskId'), sub)
  if ('error' in access) return c.json({ error: access.error }, access.status)

  const rows = await db
    .select({ item: taskChecklist, who: users })
    .from(taskChecklist)
    .leftJoin(users, eq(users.id, taskChecklist.doneById))
    .where(eq(taskChecklist.taskId, access.task.id))
    .orderBy(asc(taskChecklist.sortOrder), asc(taskChecklist.createdAt))

  return c.json({ items: rows.map((r) => checklistItem(r.item, r.who)) })
})

tasksRoute.post(
  '/:taskId/checklist',
  zValidator('json', z.object({ text: z.string().min(1).max(500), note: z.string().max(4000).optional() })),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    const access = await checklistAccess(projectId, c.req.param('taskId'), sub)
    if ('error' in access) return c.json({ error: access.error }, access.status)
    // Менять чек-лист — то же, что менять задачу.
    if (!(await hasPermission(projectId, sub, 'tasks.edit'))) return c.json({ error: 'Forbidden' }, 403)

    const { text: body, note } = c.req.valid('json')
    // Новый пункт — в конец: список читают сверху вниз, и дописанное внизу
    // не сбивает уже пройденное.
    const [{ maxSort }] = (await db
      .select({ maxSort: sql<number>`coalesce(max(${taskChecklist.sortOrder}), 0)` })
      .from(taskChecklist)
      .where(eq(taskChecklist.taskId, access.task.id))) as [{ maxSort: number }]

    const [row] = await db
      .insert(taskChecklist)
      .values({ taskId: access.task.id, projectId, text: body.trim(), note: note ? richText(note) : '', sortOrder: maxSort + 1 })
      .returning()

    tasksChanged(projectId, [access.task.assigneeId, access.task.createdById])
    return c.json(checklistItem(row!), 201)
  },
)

/**
 * Порядок пунктов целиком.
 *
 * Одним запросом, а не пачкой PATCH по каждому пункту: sort_order — целое,
 * середину между соседями не занять, поэтому при любой перестановке
 * перенумеровывать приходится хвост списка. Пачкой это N запросов, каждый со
 * своим обновлением списка, и порядок на экране скакал между промежуточными
 * состояниями.
 */
tasksRoute.patch(
  '/:taskId/checklist/order',
  zValidator('json', z.object({ ids: z.array(z.string()).max(500) })),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    const access = await checklistAccess(projectId, c.req.param('taskId'), sub)
    if ('error' in access) return c.json({ error: access.error }, access.status)
    // Порядок — часть состава списка, а не доклад о сделанном.
    if (!(await hasPermission(projectId, sub, 'tasks.edit'))) return c.json({ error: 'Forbidden' }, 403)

    const { ids } = c.req.valid('json')
    // Только пункты этой задачи: чужой id в списке иначе получил бы номер и
    // уехал в чей-то чужой чек-лист.
    const own = await db.query.taskChecklist.findMany({ where: eq(taskChecklist.taskId, access.task.id) })
    const mine = new Set(own.map((r) => r.id))

    let i = 0
    for (const itemId of ids) {
      if (!mine.has(itemId)) continue
      await db.update(taskChecklist).set({ sortOrder: i++, updatedAt: new Date() }).where(eq(taskChecklist.id, itemId))
    }

    tasksChanged(projectId, [access.task.assigneeId, access.task.createdById])
    return c.json({ ok: true, ordered: i })
  },
)

tasksRoute.patch(
  '/:taskId/checklist/:itemId',
  zValidator(
    'json',
    z.object({
      text: z.string().min(1).max(500).optional(),
      note: z.string().max(4000).optional(),
      done: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
    }),
  ),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    const access = await checklistAccess(projectId, c.req.param('taskId'), sub)
    if ('error' in access) return c.json({ error: access.error }, access.status)

    const existing = await db.query.taskChecklist.findFirst({
      where: and(eq(taskChecklist.id, c.req.param('itemId')), eq(taskChecklist.taskId, access.task.id)),
    })
    if (!existing) return c.json({ error: 'Not found' }, 404)

    const b = c.req.valid('json')
    // Переписать формулировку или переставить пункт — правка задачи. Отметить
    // и ответить — нет: см. комментарий у checklistAccess.
    if ((b.text !== undefined || b.sortOrder !== undefined) && !(await hasPermission(projectId, sub, 'tasks.edit'))) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() }
    if (b.text !== undefined) patch.text = b.text.trim()
    // Ответ под пунктом — размеченный текст, как описание и комментарии: из
    // приложения приходит разметка редактора, из моста markdown. Один разбор на
    // оба пути, чтобы храниться они начали одинаково.
    if (b.note !== undefined) patch.note = richText(b.note)
    if (b.sortOrder !== undefined) patch.sortOrder = b.sortOrder
    if (b.done !== undefined) {
      patch.done = b.done
      // Снять галочку можно так же свободно, как поставить: передумать —
      // обычное дело, а не исключение. Отметку о том, кто закрыл, при этом
      // стираем: она про закрытие, а не про историю.
      patch.doneById = b.done ? sub : null
      patch.doneAt = b.done ? new Date() : null
    }

    const [row] = await db.update(taskChecklist).set(patch).where(eq(taskChecklist.id, existing.id)).returning()
    const who = row!.doneById ? await db.query.users.findFirst({ where: eq(users.id, row!.doneById) }) : null

    // Ответ под пунктом — событие. Только когда он ИЗМЕНИЛСЯ и непуст:
    // updatedAt здесь ставится безусловно, и снятие галочки или повторное
    // сохранение того же текста иначе дёргали бы людей ни за чем. Стирание
    // ответа тоже не событие — richText('') даёт пустую строку.
    if (typeof patch.note === 'string' && patch.note && patch.note !== existing.note) {
      void checklistAnswerNotice({
        projectId,
        task: access.task,
        actorId: sub,
        itemText: row!.text,
        note: patch.note,
      })
    }

    tasksChanged(projectId, [access.task.assigneeId, access.task.createdById])
    return c.json(checklistItem(row!, who ?? null))
  },
)

tasksRoute.delete('/:taskId/checklist/:itemId', async (c) => {
  const { projectId, sub } = c.get('auth')
  const access = await checklistAccess(projectId, c.req.param('taskId'), sub)
  if ('error' in access) return c.json({ error: access.error }, access.status)
  if (!(await hasPermission(projectId, sub, 'tasks.edit'))) return c.json({ error: 'Forbidden' }, 403)

  await db
    .delete(taskChecklist)
    .where(and(eq(taskChecklist.id, c.req.param('itemId')), eq(taskChecklist.taskId, access.task.id)))

  tasksChanged(projectId, [access.task.assigneeId, access.task.createdById])
  return c.json({ ok: true })
})

// --- Зависимости между задачами --------------------------------------------
//
// «Эта ждёт ту». Одна таблица, читаемая с двух сторон: слева «кого я жду»
// (блокеры), справа «кто ждёт меня». Второй таблицы нет — расходиться нечему.

/** Краткий вид задачи для списков зависимостей: строка, а не карточка. */
const linkView = (t: typeof tasks.$inferSelect, assignee?: typeof users.$inferSelect | null) => ({
  id: t.id,
  number: t.number,
  title: t.title,
  status: t.status,
  priority: t.priority,
  refs: t.refs || undefined,
  assignee: assignee ? { id: assignee.id, name: assignee.name, avatarUrl: assignee.avatarUrl } : null,
})

/**
 * Все задачи, которые (прямо или через цепочку) ждут указанную.
 *
 * Нужно, чтобы не дать замкнуть кольцо: если A уже где-то в хвосте у B, то
 * «B ждёт A» замкнёт круг, и обе задачи станут незакрываемыми навсегда.
 * Обход в ширину по готовому индексу — на проектных объёмах это доли
 * миллисекунды, а рекурсивный SQL здесь читался бы вдвое хуже.
 */
export async function dependentsOf(projectId: string, taskId: string): Promise<Set<string>> {
  const seen = new Set<string>()
  let frontier = [taskId]
  while (frontier.length) {
    const rows = await db
      .select({ blocked: taskBlockers.blockedTaskId })
      .from(taskBlockers)
      .where(and(eq(taskBlockers.projectId, projectId), inArray(taskBlockers.blockerTaskId, frontier)))
    frontier = []
    for (const r of rows) {
      if (seen.has(r.blocked)) continue
      seen.add(r.blocked)
      frontier.push(r.blocked)
    }
  }
  return seen
}

/** Обе стороны связей задачи. */
tasksRoute.get('/:taskId/blockers', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.read'))) return c.json({ error: 'Forbidden' }, 403)
  const taskId = c.req.param('taskId')

  const blockers = await db
    .select({ task: tasks, assignee: users, linkId: taskBlockers.id })
    .from(taskBlockers)
    .innerJoin(tasks, eq(tasks.id, taskBlockers.blockerTaskId))
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .where(and(eq(taskBlockers.blockedTaskId, taskId), isNull(tasks.deletedAt)))
    .orderBy(asc(tasks.status), asc(tasks.number))

  const blocking = await db
    .select({ task: tasks, assignee: users, linkId: taskBlockers.id })
    .from(taskBlockers)
    .innerJoin(tasks, eq(tasks.id, taskBlockers.blockedTaskId))
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .where(and(eq(taskBlockers.blockerTaskId, taskId), isNull(tasks.deletedAt)))
    .orderBy(asc(tasks.status), asc(tasks.number))

  return c.json({
    blockers: blockers.map((r) => ({ ...linkView(r.task, r.assignee), linkId: r.linkId })),
    blocking: blocking.map((r) => ({ ...linkView(r.task, r.assignee), linkId: r.linkId })),
  })
})

/**
 * Кого МОЖНО добавить в блокеры этой задачи.
 *
 * Отдаём только допустимых кандидатов, а не все задачи проекта: выбрать
 * заведомо запрещённую и получить отказ — худший вид подсказки. Выпадают сама
 * задача, уже связанные и все, кто прямо или косвенно ждёт эту, — последние
 * как раз и замкнули бы кольцо.
 */
tasksRoute.get('/:taskId/blockers/candidates', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.read'))) return c.json({ error: 'Forbidden' }, 403)
  const taskId = c.req.param('taskId')
  const q = (c.req.query('q') ?? '').trim()
  // Направление: кого добавляем — блокеров этой задачи или зависимых от неё.
  const side = c.req.query('side') === 'blocking' ? 'blocking' : 'blockers'

  const linked = await db
    .select({ a: taskBlockers.blockedTaskId, b: taskBlockers.blockerTaskId })
    .from(taskBlockers)
    .where(
      and(
        eq(taskBlockers.projectId, projectId),
        side === 'blockers' ? eq(taskBlockers.blockedTaskId, taskId) : eq(taskBlockers.blockerTaskId, taskId),
      ),
    )
  const already = new Set(linked.map((r) => (side === 'blockers' ? r.b : r.a)))

  // Кольцо: при добавлении блокера нельзя брать тех, кто уже ждёт нас; при
  // добавлении зависимой — тех, кого ждём мы.
  const forbidden =
    side === 'blockers' ? await dependentsOf(projectId, taskId) : await blockersOf(projectId, taskId)

  const conds = [eq(tasks.projectId, projectId), isNull(tasks.deletedAt)]
  if (q) {
    conds.push(
      sql`(${tasks.title} ilike ${`%${q}%`} or ${tasks.number} ilike ${`%${q}%`} or ${tasks.refs} ilike ${`%${q}%`})`,
    )
  }
  const rows = await db
    .select({ task: tasks, assignee: users })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .where(and(...conds))
    .orderBy(asc(tasks.status), desc(tasks.createdAt))
    .limit(200)

  const items = rows
    .filter((r) => r.task.id !== taskId && !already.has(r.task.id) && !forbidden.has(r.task.id))
    .slice(0, 50)
    .map((r) => linkView(r.task, r.assignee))
  return c.json({ items })
})

/** Всё, чего ждёт задача — прямо или по цепочке. Зеркало dependentsOf. */
export async function blockersOf(projectId: string, taskId: string): Promise<Set<string>> {
  const seen = new Set<string>()
  let frontier = [taskId]
  while (frontier.length) {
    const rows = await db
      .select({ blocker: taskBlockers.blockerTaskId })
      .from(taskBlockers)
      .where(and(eq(taskBlockers.projectId, projectId), inArray(taskBlockers.blockedTaskId, frontier)))
    frontier = []
    for (const r of rows) {
      if (seen.has(r.blocker)) continue
      seen.add(r.blocker)
      frontier.push(r.blocker)
    }
  }
  return seen
}

/** Добавить связи. Принимаем список: выбрали несколько галочками — один запрос. */
tasksRoute.post(
  '/:taskId/blockers',
  zValidator(
    'json',
    z.object({
      taskIds: z.array(z.string()).min(1).max(50),
      /** blockers — эти задачи держат нашу; blocking — наша держит эти. */
      side: z.enum(['blockers', 'blocking']).default('blockers'),
    }),
  ),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    if (!(await hasPermission(projectId, sub, 'tasks.edit'))) return c.json({ error: 'Forbidden' }, 403)
    const taskId = c.req.param('taskId')
    const { taskIds, side } = c.req.valid('json')

    const task = await db.query.tasks.findFirst({
      where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId), isNull(tasks.deletedAt)),
    })
    if (!task) return c.json({ error: 'Not found' }, 404)

    // Только задачи ЭТОГО проекта: связь между проектами означала бы, что
    // человек видит в списке задачу, к которой у него может не быть доступа.
    const found = await db
      .select({ id: tasks.id, number: tasks.number })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), inArray(tasks.id, taskIds), isNull(tasks.deletedAt)))
    if (found.length !== taskIds.length) return c.json({ error: 'Some tasks are not in this project' }, 400)
    if (taskIds.includes(taskId)) return c.json({ error: 'A task cannot block itself' }, 400)

    // Кольцо проверяем ДО вставки и по каждой задаче: A и B по отдельности
    // безобидны, а вместе замыкают круг.
    const forbidden =
      side === 'blockers' ? await dependentsOf(projectId, taskId) : await blockersOf(projectId, taskId)
    const looped = found.filter((f) => forbidden.has(f.id))
    if (looped.length) {
      return c.json(
        {
          error: `Circular dependency: ${looped.map((l) => l.number).join(', ')} already depends on this task. Neither could ever be finished.`,
        },
        400,
      )
    }

    await db
      .insert(taskBlockers)
      .values(
        taskIds.map((other) => ({
          projectId,
          blockedTaskId: side === 'blockers' ? taskId : other,
          blockerTaskId: side === 'blockers' ? other : taskId,
          createdById: sub,
        })),
      )
      // Повторная связь — не ошибка и не вторая связь: молча пропускаем.
      .onConflictDoNothing()

    void logActivity({
      projectId,
      actorId: sub,
      action: 'update',
      entityType: 'task',
      entityId: taskId,
      entityLabel: `${task.number} ${task.title}`,
    })
    tasksChanged(projectId, [task.assigneeId, task.createdById])
    return c.json({ ok: true, added: taskIds.length })
  },
)

/** Убрать связь. Направление не важно — у связи один id. */
tasksRoute.delete('/:taskId/blockers/:linkId', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.edit'))) return c.json({ error: 'Forbidden' }, 403)
  const taskId = c.req.param('taskId')

  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)),
  })
  if (!task) return c.json({ error: 'Not found' }, 404)

  await db
    .delete(taskBlockers)
    .where(and(eq(taskBlockers.id, c.req.param('linkId')), eq(taskBlockers.projectId, projectId)))

  tasksChanged(projectId, [task.assigneeId, task.createdById])
  return c.json({ ok: true })
})

/* --- Ресурсы задачи --------------------------------------------------------
 *
 * Ресурс — это доступ: стенд, ключ, база. Задача на него ССЫЛАЕТСЯ, а не
 * хранит копию: пароль, вставленный в описание, читают все, кто видит задачу,
 * и отозвать его уже нельзя. Кто может раскрыть значение — решает сам ресурс.
 *
 * Здесь везде отдаются только id, имя и адрес. Значения секретов не
 * выбираются вовсе — ни в списке, ни у кандидатов.
 */

/** Ресурсы, привязанные к задаче. */
tasksRoute.get('/:taskId/resources', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.read'))) return c.json({ error: 'Forbidden' }, 403)
  const taskId = c.req.param('taskId')

  const rows = await db
    .select({
      linkId: taskResources.id,
      id: credentials.id,
      name: credentials.name,
      url: credentials.url,
      icon: credentials.icon,
    })
    .from(taskResources)
    .innerJoin(credentials, eq(credentials.id, taskResources.resourceId))
    .where(and(eq(taskResources.taskId, taskId), isNull(credentials.deletedAt)))
    .orderBy(asc(credentials.name))

  return c.json({ items: rows })
})

/**
 * Кого можно привязать: ресурсы этого проекта, ещё не привязанные.
 *
 * Предлагать уже привязанный — врать подсказкой: человек выберет, а в ответ
 * получит «уже есть».
 */
tasksRoute.get('/:taskId/resources/candidates', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.read'))) return c.json({ error: 'Forbidden' }, 403)
  const taskId = c.req.param('taskId')
  const q = (c.req.query('q') ?? '').trim()

  const linked = await db
    .select({ id: taskResources.resourceId })
    .from(taskResources)
    .where(eq(taskResources.taskId, taskId))
  const already = new Set(linked.map((r) => r.id))

  const conds = [eq(credentials.projectId, projectId), isNull(credentials.deletedAt)]
  if (q) {
    conds.push(sql`(${credentials.name} ilike ${`%${q}%`} or ${credentials.url} ilike ${`%${q}%`})`)
  }
  const rows = await db
    .select({ id: credentials.id, name: credentials.name, url: credentials.url, icon: credentials.icon })
    .from(credentials)
    .where(and(...conds))
    .orderBy(desc(credentials.createdAt))
    .limit(200)

  return c.json({ items: rows.filter((r) => !already.has(r.id)).slice(0, 50) })
})

/** Привязать ресурсы. Список: выбрали несколько галочками — один запрос. */
tasksRoute.post(
  '/:taskId/resources',
  zValidator('json', z.object({ resourceIds: z.array(z.string()).min(1).max(50) })),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    if (!(await hasPermission(projectId, sub, 'tasks.edit'))) return c.json({ error: 'Forbidden' }, 403)
    const taskId = c.req.param('taskId')
    const { resourceIds } = c.req.valid('json')

    const task = await db.query.tasks.findFirst({
      where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId), isNull(tasks.deletedAt)),
    })
    if (!task) return c.json({ error: 'Not found' }, 404)

    // Только ресурсы ЭТОГО проекта: чужой в карточке показал бы доступ,
    // которого у человека нет и открыть который он не сможет.
    const found = await db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.projectId, projectId),
          inArray(credentials.id, resourceIds),
          isNull(credentials.deletedAt),
        ),
      )
    if (found.length !== resourceIds.length) {
      return c.json({ error: 'Some resources are not in this project' }, 400)
    }

    await db
      .insert(taskResources)
      .values(found.map((r) => ({ taskId, resourceId: r.id })))
      // Повторная привязка — не ошибка и не вторая привязка.
      .onConflictDoNothing()

    void logActivity({
      projectId,
      actorId: sub,
      action: 'update',
      entityType: 'task',
      entityId: taskId,
      entityLabel: `${task.number} ${task.title}`,
    })
    tasksChanged(projectId, [task.assigneeId, task.createdById])
    return c.json({ ok: true, added: found.length })
  },
)

/**
 * Отвязать ресурс.
 *
 * Отдельной ручкой, а не заменой всего списка через PATCH: прислав короткий
 * массив, легко молча стереть привязку, которую поставил кто-то другой.
 * Здесь видно по названию, что именно убирают.
 */
tasksRoute.delete('/:taskId/resources/:resourceId', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.edit'))) return c.json({ error: 'Forbidden' }, 403)
  const taskId = c.req.param('taskId')

  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)),
  })
  if (!task) return c.json({ error: 'Not found' }, 404)

  await db
    .delete(taskResources)
    .where(and(eq(taskResources.taskId, taskId), eq(taskResources.resourceId, c.req.param('resourceId'))))

  tasksChanged(projectId, [task.assigneeId, task.createdById])
  return c.json({ ok: true })
})

/* --- Связанные задачи ------------------------------------------------------
 *
 * Не блокеры: эти связи ничего не держат и не влияют на «с чего начать».
 * Они отвечают на другой вопрос — из чего задача выросла и что на неё похоже.
 * Поэтому и таблица отдельная, и ручки отдельные: перепутать их нельзя.
 */

/** Обе стороны связей: направленные derived читаются по-разному, related — одинаково. */
tasksRoute.get('/:taskId/links', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.read'))) return c.json({ error: 'Forbidden' }, 403)
  const taskId = c.req.param('taskId')

  // Строки, где наша задача слева: для derived это «мы выросли из них».
  const out = await db
    .select({ task: tasks, assignee: users, linkId: taskLinks.id, kind: taskLinks.kind })
    .from(taskLinks)
    .innerJoin(tasks, eq(tasks.id, taskLinks.toTaskId))
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .where(and(eq(taskLinks.fromTaskId, taskId), isNull(tasks.deletedAt)))
    .orderBy(asc(tasks.status), asc(tasks.number))

  // Строки, где наша задача справа: для derived это «из нас выросли они».
  const inc = await db
    .select({ task: tasks, assignee: users, linkId: taskLinks.id, kind: taskLinks.kind })
    .from(taskLinks)
    .innerJoin(tasks, eq(tasks.id, taskLinks.fromTaskId))
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .where(and(eq(taskLinks.toTaskId, taskId), isNull(tasks.deletedAt)))
    .orderBy(asc(tasks.status), asc(tasks.number))

  const view = (r: (typeof out)[number]) => ({ ...linkView(r.task, r.assignee), linkId: r.linkId })

  return c.json({
    /** Из чего эта задача выросла. */
    derivedFrom: out.filter((r) => r.kind === 'derived').map(view),
    /** Что выросло из неё. */
    derivedInto: inc.filter((r) => r.kind === 'derived').map(view),
    /** Просто связанные — симметрично, поэтому обе стороны в одном списке. */
    related: [...out, ...inc].filter((r) => r.kind === 'related').map(view),
  })
})

/**
 * Кого можно связать. Выпадают сама задача и уже связанные — предлагать то,
 * что заведомо отвергнут, значит врать подсказкой.
 *
 * Колец здесь не проверяем, в отличие от блокеров: связь ничего не держит, и
 * замкнутая цепочка «похоже на» никого не блокирует.
 */
tasksRoute.get('/:taskId/links/candidates', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.read'))) return c.json({ error: 'Forbidden' }, 403)
  const taskId = c.req.param('taskId')
  const q = (c.req.query('q') ?? '').trim()

  const linked = await db
    .select({ a: taskLinks.fromTaskId, b: taskLinks.toTaskId })
    .from(taskLinks)
    .where(
      and(
        eq(taskLinks.projectId, projectId),
        or(eq(taskLinks.fromTaskId, taskId), eq(taskLinks.toTaskId, taskId)),
      ),
    )
  const already = new Set(linked.flatMap((r) => [r.a, r.b]))

  const conds = [eq(tasks.projectId, projectId), isNull(tasks.deletedAt)]
  if (q) {
    conds.push(
      sql`(${tasks.title} ilike ${`%${q}%`} or ${tasks.number} ilike ${`%${q}%`} or ${tasks.refs} ilike ${`%${q}%`})`,
    )
  }
  const rows = await db
    .select({ task: tasks, assignee: users })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .where(and(...conds))
    .orderBy(asc(tasks.status), desc(tasks.createdAt))
    .limit(200)

  const items = rows
    .filter((r) => r.task.id !== taskId && !already.has(r.task.id))
    .slice(0, 50)
    .map((r) => linkView(r.task, r.assignee))
  return c.json({ items })
})

/** Связать задачи. Список: выбрали несколько галочками — один запрос. */
tasksRoute.post(
  '/:taskId/links',
  zValidator(
    'json',
    z.object({
      taskIds: z.array(z.string()).min(1).max(50),
      kind: z.enum(['derived', 'related']).default('related'),
      /**
       * Для derived направление решает смысл: from — «эта выросла из тех»,
       * into — «из этой выросли те». Для related безразлично, связь
       * симметрична.
       */
      direction: z.enum(['from', 'into']).default('from'),
    }),
  ),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    if (!(await hasPermission(projectId, sub, 'tasks.edit'))) return c.json({ error: 'Forbidden' }, 403)
    const taskId = c.req.param('taskId')
    const { taskIds, kind, direction } = c.req.valid('json')

    const task = await db.query.tasks.findFirst({
      where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId), isNull(tasks.deletedAt)),
    })
    if (!task) return c.json({ error: 'Not found' }, 404)

    // Сама с собой — не связь.
    if (taskIds.includes(taskId)) return c.json({ error: 'A task cannot link to itself' }, 400)

    // Только задачи ЭТОГО проекта: чужой номер человек всё равно не откроет.
    const found = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), inArray(tasks.id, taskIds), isNull(tasks.deletedAt)))
    if (found.length !== taskIds.length) return c.json({ error: 'Some tasks are not in this project' }, 400)

    // Связь уже может существовать в обратную сторону — уникальный индекс её
    // не поймает (пара упорядочена), поэтому отсекаем явно: иначе в списке
    // появятся два одинаковых пункта.
    const existing = await db
      .select({ a: taskLinks.fromTaskId, b: taskLinks.toTaskId })
      .from(taskLinks)
      .where(
        and(
          eq(taskLinks.projectId, projectId),
          or(eq(taskLinks.fromTaskId, taskId), eq(taskLinks.toTaskId, taskId)),
        ),
      )
    const linkedAlready = new Set(existing.flatMap((r) => [r.a, r.b]))
    const fresh = taskIds.filter((x) => !linkedAlready.has(x))

    if (fresh.length) {
      await db
        .insert(taskLinks)
        .values(
          fresh.map((other) => ({
            projectId,
            fromTaskId: direction === 'from' ? taskId : other,
            toTaskId: direction === 'from' ? other : taskId,
            kind,
            createdById: sub,
          })),
        )
        // Повторная связь — не ошибка и не вторая связь.
        .onConflictDoNothing()
    }

    void logActivity({
      projectId,
      actorId: sub,
      action: 'update',
      entityType: 'task',
      entityId: taskId,
      entityLabel: `${task.number} ${task.title}`,
    })
    tasksChanged(projectId, [task.assigneeId, task.createdById])
    return c.json({ ok: true, added: fresh.length })
  },
)

/** Убрать связь. Направление не важно — у связи один id. */
tasksRoute.delete('/:taskId/links/:linkId', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.edit'))) return c.json({ error: 'Forbidden' }, 403)
  const taskId = c.req.param('taskId')

  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)),
  })
  if (!task) return c.json({ error: 'Not found' }, 404)

  await db
    .delete(taskLinks)
    .where(and(eq(taskLinks.id, c.req.param('linkId')), eq(taskLinks.projectId, projectId)))

  tasksChanged(projectId, [task.assigneeId, task.createdById])
  return c.json({ ok: true })
})

tasksRoute.get('/:taskId/comments', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.read'))) return c.json({ error: 'Forbidden' }, 403)
  const taskId = c.req.param('taskId')
  const rows = await db
    .select({ comment: taskComments, author: users })
    .from(taskComments)
    .leftJoin(users, eq(users.id, taskComments.authorId))
    .where(and(eq(taskComments.taskId, taskId), eq(taskComments.projectId, projectId)))
    .orderBy(asc(taskComments.createdAt))
  const fileMap = await commentFiles(rows.map((r) => r.comment.id))
  return c.json(
    rows.map((r) => ({
      id: r.comment.id,
      body: r.comment.body,
      replyToId: r.comment.replyToId,
      createdAt: r.comment.createdAt,
      author: r.author ? { id: r.author.id, name: r.author.name, avatarUrl: r.author.avatarUrl } : null,
      files: fileMap.get(r.comment.id) ?? [],
    })),
  )
})

// Создать комментарий — нужен tasks.read (комментировать может любой, кто видит задачи).
// attachmentIds: файлы проекта (без владельца-сообщения) привязываются к комментарию и задаче.
tasksRoute.post(
  '/:taskId/comments',
  zValidator('json', z.object({ body: z.string().min(1).max(10_000), replyToId: z.string().nullable().optional(), attachmentIds: z.array(z.string()).default([]) })),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    if (!(await hasPermission(projectId, sub, 'tasks.read'))) return c.json({ error: 'Forbidden' }, 403)
    const taskId = c.req.param('taskId')
    const task = await db.query.tasks.findFirst({ where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)) })
    if (!task) return c.json({ error: 'Not found' }, 404)

    const { body, replyToId, attachmentIds } = c.req.valid('json')
    const [row] = await db.insert(taskComments).values({ taskId, projectId, authorId: sub, body, replyToId: replyToId ?? null }).returning()

    // привязать файлы к комментарию + задаче (файл появляется и в разделе Files задачи)
    if (attachmentIds.length) {
      await db
        .update(files)
        .set({ commentId: row!.id, taskId, pendingUntil: null })
        .where(and(sql`${files.id} in (${sql.join(attachmentIds.map((id) => sql`${id}`), sql`, `)})`, eq(files.projectId, projectId), eq(files.uploadedById, sub)))
    }

    const author = await db.query.users.findFirst({ where: eq(users.id, sub) })
    const actorName = author?.name || 'Someone'
    const link = projectPath((await companyOf(projectId)) ?? '', projectId, `/tasks/${taskId}`)

    // уведомления: упоминания в комментарии + автору/ассайни задачи о новом комментарии
    const mentioned = extractMentions(body)
    if (mentioned.length)
      void notify({ projectId, event: 'comment_mention', recipientIds: mentioned, actorId: sub, actorName, dedupeKey: `comment_mention:${row!.id}`, link, preview: body, entityType: 'task', entityId: task.id })
    // Правило одно на все три пути — см. commentWatchers в notify.ts.
    const watchers = commentWatchers({
      assigneeId: task.assigneeId,
      createdById: task.createdById,
      mentioned,
      actorId: sub,
    })
    if (watchers.length)
      void notify({ projectId, event: 'task_comment', recipientIds: watchers, actorId: sub, actorName, dedupeKey: `task_comment:${row!.id}`, link, preview: body, vars: { ref: task.number }, entityType: 'task', entityId: task.id })

    broadcast(projectId, 'task_comments_changed', { taskId })
    const fileMap = await commentFiles([row!.id])
    return c.json(
      {
        id: row!.id,
        body: row!.body,
        replyToId: row!.replyToId,
        createdAt: row!.createdAt,
        author: author ? { id: author.id, name: author.name, avatarUrl: author.avatarUrl } : null,
        files: fileMap.get(row!.id) ?? [],
      },
      201,
    )
  },
)

// Редактировать комментарий — только автор
tasksRoute.patch('/:taskId/comments/:commentId', zValidator('json', z.object({ body: z.string().min(1).max(10_000) })), async (c) => {
  const { projectId, sub } = c.get('auth')
  const commentId = c.req.param('commentId')
  const comment = await db.query.taskComments.findFirst({ where: and(eq(taskComments.id, commentId), eq(taskComments.projectId, projectId)) })
  if (!comment) return c.json({ error: 'Not found' }, 404)
  if (comment.authorId !== sub) return c.json({ error: 'Forbidden' }, 403)
  const [row] = await db.update(taskComments).set({ body: c.req.valid('json').body }).where(eq(taskComments.id, commentId)).returning()
  broadcast(projectId, 'task_comments_changed', { taskId: comment.taskId })
  return c.json({ id: row!.id, body: row!.body })
})

// Удалить комментарий — автор, owner или admin
tasksRoute.delete('/:taskId/comments/:commentId', async (c) => {
  const { projectId, sub, role } = c.get('auth')
  const commentId = c.req.param('commentId')
  const comment = await db.query.taskComments.findFirst({ where: and(eq(taskComments.id, commentId), eq(taskComments.projectId, projectId)) })
  if (!comment) return c.json({ error: 'Not found' }, 404)
  if (comment.authorId !== sub && role !== 'owner' && role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
  await db.delete(taskComments).where(eq(taskComments.id, commentId))
  broadcast(projectId, 'task_comments_changed', { taskId: comment.taskId })
  return c.json({ ok: true })
})

// ИИ-валидация задачи в форме создания/редактирования (SPEC §8.6): «Проверить мою задачу».
// Не сохраняет ничего — возвращает совет + улучшенный вариант для apply.
tasksRoute.post('/validate', zValidator('json', z.object({ title: z.string().default(''), description: z.string().default('') })), async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'tasks.read'))) return c.json({ error: 'Forbidden' }, 403)
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  const language = (JSON.parse(project?.aiConfig || '{}') as { language?: string }).language ?? 'en'
  const { title, description } = c.req.valid('json')
  const result = await validateTask(projectId, { title, description, language })
  if (!result) return c.json({ error: 'AI unavailable' }, 503)
  return c.json(result)
})


/**
 * Мои задачи по всем проектам компании — панель «Мои задачи» (TASK-21).
 *
 * Отдельная ручка на session-токене, а не обход проектов по одному: обходить
 * пришлось бы тринадцать раз, и каждый со своим токеном, который на фронте
 * один.
 *
 * Прав здесь не ослабляем: берём ровно те проекты, где человек СОСТОИТ, и
 * ровно те задачи, что назначены на НЕГО. Своё человек видит всегда — та же
 * логика, что в timeMineRoute для часов.
 */
export const tasksMineRoute = new Hono<SessionEnv>()
tasksMineRoute.use('*', requireSession)

tasksMineRoute.get('/', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.query('companyId')
  if (!companyId) return c.json({ error: 'companyId required' }, 400)

  /**
   * Проекты компании, где человек состоит.
   *
   * Через членство, а не через роль в компании: админ компании вправе зайти в
   * любой проект, но «мои задачи» — это про назначенное лично, и показывать
   * ему чужие проекты в этом списке незачем.
   */
  const mine = await db
    .select({ id: projects.id, name: projects.name, color: projects.color, logoUrl: projects.logoUrl })
    .from(projects)
    .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
    // Архивные не в счёт: панель показывает текущую работу, а законченный
    // проект убрали с глаз именно затем, чтобы он её не разбавлял.
    .where(and(eq(projects.companyId, companyId), eq(projectMembers.userId, sub), isNull(projects.archivedAt)))
  if (!mine.length) return c.json({ items: [] })

  const rows = await db
    .select({
      id: tasks.id,
      number: tasks.number,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
      createdAt: tasks.createdAt,
      projectId: tasks.projectId,
      author: { id: users.id, name: users.name, avatarUrl: users.avatarUrl },
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.createdById))
    .where(
      and(
        inArray(tasks.projectId, mine.map((p) => p.id)),
        eq(tasks.assigneeId, sub),
        isNull(tasks.deletedAt),
        // Всё, кроме сделанного: иначе панель утонет в закрытых задачах.
        sql`${tasks.status} <> 'done'`,
      ),
    )
    /**
     * Сначала просроченные, потом от старых к новым.
     *
     * Порядок считает Postgres, а не фронт: список приходит готовым, и при
     * дозагрузке страницами порядок не разъедется.
     *
     * now() в сравнении, а не переданное клиентом время: часы у клиента могут
     * врать, и задача считалась бы просроченной у одного и нет у другого.
     */
    .orderBy(
      sql`case when ${tasks.dueDate} is not null and ${tasks.dueDate} < now() then 0 else 1 end`,
      asc(tasks.createdAt),
    )

  const projectById = new Map(mine.map((p) => [p.id, p]))
  return c.json({
    items: rows.map((r) => ({
      ...r,
      project: projectById.get(r.projectId) ?? null,
    })),
  })
})
