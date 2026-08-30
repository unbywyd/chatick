import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { workLog, tasks, users } from '../db/schema.js'
import { requireProject, type ProjectEnv } from '../auth.js'
import { projectRoleOf } from './projects.js'
import { enqueue } from '../lib/embeddings.js'
import { sanitizeHtml } from '../lib/sanitize-html.js'

/**
 * Журнал работы: что человек делал в проекте и где остановился.
 *
 * Два правила держат всё остальное:
 *
 * 1. ЧЕРНОВИК ВИДЕН ТОЛЬКО АВТОРУ. Не «скрыт в интерфейсе» — недостижим ни
 *    одним путём: ни списком, ни прямой ссылкой, ни поиском, ни мостом. Иначе
 *    в него перестанут писать честно, а честность — единственное, ради чего он
 *    нужен.
 *
 * 2. ОПУБЛИКОВАННОЕ НЕ ПРАВИТСЯ. Журнал, который переписывают задним числом,
 *    перестаёт быть журналом. Ошибся — пишешь следующую запись; передумал
 *    целиком — удаляешь свою.
 *
 * Черновик у человека в проекте один. Это не ограничение ради ограничения:
 * без него «править можно последнюю до публикации» не имеет ответа на вопрос
 * «последнюю из скольки». Правило держит частичный уникальный индекс в базе
 * (миграция 0094) — две вкладки заведут второй черновик быстрее, чем проверка
 * в коде увидит первый.
 */
export const worklogRoute = new Hono<ProjectEnv>()
worklogRoute.use('*', requireProject)

/** Начальство проекта видит записи всех; участник — только свои. */
async function canSeeEveryone(projectId: string, userId: string): Promise<boolean> {
  const m = await projectRoleOf(projectId, userId)
  return m?.role === 'owner' || m?.role === 'admin'
}

const serialize = (
  r: typeof workLog.$inferSelect,
  author?: { id: string; name: string; avatarUrl: string | null } | null,
  task?: { id: string; number: string; title: string } | null,
) => ({
  id: r.id,
  body: r.body,
  status: r.status,
  publishedAt: r.publishedAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  author: author ?? null,
  task: task ?? null,
})

const listQuery = z.object({
  /** Чьи записи. Участнику доступен только он сам — проверяется ниже. */
  authorId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).default(50),
})

worklogRoute.get('/', zValidator('query', listQuery), async (c) => {
  const { projectId, sub } = c.get('auth')
  const q = c.req.valid('query')
  const seesEveryone = await canSeeEveryone(projectId, sub)

  const conds = [eq(workLog.projectId, projectId), isNull(workLog.deletedAt)]

  /**
   * Граница видимости — ОДНИМ условием на оба правила сразу.
   *
   * «Опубликованное — всех» и «черновики — только мои» это не два фильтра,
   * которые применяют по очереди: в паре они легко складываются в «все
   * черновики», стоит поставить между ними не тот союз. Пишем одним
   * выражением: чужое — только опубликованное, своё — любое.
   */
  const visible = or(
    eq(workLog.authorId, sub),
    eq(workLog.status, 'published'),
  )!
  conds.push(visible)

  // Участник видит только себя — независимо от того, что он попросил.
  if (!seesEveryone) conds.push(eq(workLog.authorId, sub))
  else if (q.authorId) conds.push(eq(workLog.authorId, q.authorId))

  if (q.from) conds.push(gte(workLog.createdAt, new Date(q.from)))
  // «По 15 марта» включает весь день: дата без времени — это полночь, и без
  // добивки фильтр молча терял записи последнего дня периода.
  if (q.to) conds.push(lte(workLog.createdAt, new Date(q.to.length <= 10 ? `${q.to}T23:59:59.999` : q.to)))

  const rows = await db
    .select({
      r: workLog,
      author: { id: users.id, name: users.name, avatarUrl: users.avatarUrl },
      task: { id: tasks.id, number: tasks.number, title: tasks.title },
    })
    .from(workLog)
    .innerJoin(users, eq(users.id, workLog.authorId))
    // leftJoin: задача необязательна, и inner молча выбросил бы все записи
    // без неё — а таких большинство.
    .leftJoin(tasks, eq(tasks.id, workLog.taskId))
    .where(and(...conds))
    // Стоим по времени публикации, а у черновика его нет — тогда по созданию.
    .orderBy(desc(sql`coalesce(${workLog.publishedAt}, ${workLog.createdAt})`))
    .limit(q.limit)

  return c.json({
    items: rows.map((x) => serialize(x.r, x.author, x.task?.id ? x.task : null)),
    canSeeEveryone: seesEveryone,
  })
})

/** Люди, писавшие в журнал — для фильтра. Только начальству: остальным нечего фильтровать. */
worklogRoute.get('/authors', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await canSeeEveryone(projectId, sub))) return c.json({ items: [] })

  const rows = await db
    .selectDistinct({ id: users.id, name: users.name, avatarUrl: users.avatarUrl })
    .from(workLog)
    .innerJoin(users, eq(users.id, workLog.authorId))
    .where(
      and(
        eq(workLog.projectId, projectId),
        isNull(workLog.deletedAt),
        // Автор попадает в фильтр, только если у него есть ЧТО показать
        // спрашивающему: человек, написавший один черновик, в списке не
        // появляется — иначе фильтр по нему даёт пустоту и выглядит поломкой.
        eq(workLog.status, 'published'),
      ),
    )
  return c.json({ items: rows })
})

const bodySchema = z.object({
  body: z.string().max(20000),
  taskId: z.string().nullable().optional(),
})

worklogRoute.post('/', zValidator('json', bodySchema), async (c) => {
  const { projectId, sub } = c.get('auth')
  const input = c.req.valid('json')

  // Черновик уже есть — отдаём его, а не заводим второй. База откажет всё
  // равно, но человеку нужен ответ понятнее, чем нарушение уникальности.
  const open = await db.query.workLog.findFirst({
    where: and(
      eq(workLog.projectId, projectId),
      eq(workLog.authorId, sub),
      eq(workLog.status, 'draft'),
      isNull(workLog.deletedAt),
    ),
  })
  if (open) return c.json({ error: 'draft_exists', id: open.id }, 409)

  const [row] = await db
    .insert(workLog)
    .values({
      projectId,
      authorId: sub,
      body: sanitizeHtml(input.body),
      taskId: input.taskId ?? null,
      status: 'draft',
    })
    .returning()

  return c.json(serialize(row!), 201)
})

worklogRoute.patch('/:id', zValidator('json', bodySchema.partial()), async (c) => {
  const { projectId, sub } = c.get('auth')
  const id = c.req.param('id')
  const p = c.req.valid('json')

  const row = await db.query.workLog.findFirst({
    where: and(eq(workLog.id, id), eq(workLog.projectId, projectId), isNull(workLog.deletedAt)),
  })
  if (!row) return c.json({ error: 'not_found' }, 404)
  // Чужую запись не правит никто, включая владельца проекта: это чужой
  // рассказ о своей работе, а не общий документ.
  if (row.authorId !== sub) return c.json({ error: 'forbidden' }, 403)
  // Опубликованное неизменно — то самое «только вперёд».
  if (row.status !== 'draft') return c.json({ error: 'published_is_final' }, 409)

  const patch: Partial<typeof workLog.$inferInsert> = { updatedAt: new Date() }
  if (p.body !== undefined) patch.body = sanitizeHtml(p.body)
  if (p.taskId !== undefined) patch.taskId = p.taskId

  const [updated] = await db.update(workLog).set(patch).where(eq(workLog.id, id)).returning()
  return c.json(serialize(updated!))
})

/** Публикация — единственный переход, и он в одну сторону. */
worklogRoute.post('/:id/publish', async (c) => {
  const { projectId, sub } = c.get('auth')
  const id = c.req.param('id')

  const row = await db.query.workLog.findFirst({
    where: and(eq(workLog.id, id), eq(workLog.projectId, projectId), isNull(workLog.deletedAt)),
  })
  if (!row) return c.json({ error: 'not_found' }, 404)
  if (row.authorId !== sub) return c.json({ error: 'forbidden' }, 403)
  if (row.status !== 'draft') return c.json({ error: 'already_published' }, 409)
  // Пустую запись публиковать нечего: в ленте она встанет пустой строкой,
  // которую нельзя ни прочитать, ни исправить.
  if (!row.body.replace(/<[^>]*>/g, '').trim()) return c.json({ error: 'empty' }, 400)

  const [updated] = await db
    .update(workLog)
    .set({ status: 'published', publishedAt: new Date(), updatedAt: new Date() })
    .where(eq(workLog.id, id))
    .returning()

  // В поиск попадает опубликованное. Черновик не индексируем вовсе: пока он
  // черновик, найти его должен только автор — а он и так знает, где он.
  void enqueue('work_log', updated!.id, projectId)

  return c.json(serialize(updated!))
})

worklogRoute.delete('/:id', async (c) => {
  const { projectId, sub } = c.get('auth')
  const id = c.req.param('id')

  const row = await db.query.workLog.findFirst({
    where: and(eq(workLog.id, id), eq(workLog.projectId, projectId), isNull(workLog.deletedAt)),
  })
  if (!row) return c.json({ error: 'not_found' }, 404)
  // Своё — любое, и черновик, и опубликованное: «удалять любые» из просьбы.
  // Чужое — никакое: убрать чужой рассказ о работе не вправе и владелец.
  if (row.authorId !== sub) return c.json({ error: 'forbidden' }, 403)

  await db.update(workLog).set({ deletedAt: new Date() }).where(eq(workLog.id, id))

  // Вычищаем из индекса. Ставим в очередь — textOf увидит удалённую запись,
  // вернёт null, и flushQueue снимет вектор. Иначе удалённое продолжало бы
  // находиться поиском: запись стёрта, а ассистент её цитирует.
  void enqueue('work_log', id, projectId)

  return c.json({ ok: true })
})
