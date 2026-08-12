import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companies, projectMembers, projects, tasks, timeEntries, users } from '../db/schema.js'
import { requireProject, requireSession, type ProjectEnv, type SessionEnv } from '../auth.js'
import { projectRoleOf, companyRoleOf } from './projects.js'
import { logActivity } from '../lib/audit.js'
import { broadcast, sendToUserAnywhere } from '../ws.js'
import { translateTimeEntry } from '../lib/llm.js'

// Трекинг времени (SPEC §8.32).
// Одна запись — один отрезок работы. Задача необязательна и всегда одна:
// параллельные задачи — это параллельные таймеры, а не список внутри записи.
export const timeRoute = new Hono<ProjectEnv>()
timeRoute.use('*', requireProject)

/**
 * Сводка по компании живёт отдельно: она про компанию, а не про проект.
 *
 * Под общим requireProject экран часов компании падал в 401 — проектного
 * токена там нет и быть не должно, а у компании без проектов не будет вовсе.
 * React Query повторял запрос, и вкладка бесконечно мигала многоточием.
 *
 * Доступ не ослаб: обработчик и раньше проверял роль admin/manager В КОМПАНИИ,
 * проектный токен ничего к этому не добавлял.
 */
export const timeCompanyRoute = new Hono<SessionEnv>()
timeCompanyRoute.use('*', requireSession)

timeCompanyRoute.get(
  '/company/:companyId',
  zValidator('query', z.object({ from: z.string().optional(), to: z.string().optional(), userId: z.string().optional() })),
  async (c) => {
    const { sub } = c.get('session')
    const companyId = c.req.param('companyId')
    const role = await companyRoleOf(companyId, sub)
    if (role !== 'admin' && role !== 'manager') return c.json({ error: 'Forbidden' }, 403)

    const f = c.req.valid('query')
    const periodFrom = f.from ? new Date(f.from) : null
    const periodTo = f.to ? new Date(f.to) : null
    if (periodTo && !f.to!.includes('T')) periodTo.setHours(23, 59, 59, 999)

    const conds = [eq(projects.companyId, companyId), sql`${timeEntries.endedAt} is not null`]
    if (f.userId) conds.push(eq(timeEntries.userId, f.userId))
    // берём пересекающиеся записи, а лишнее отрежем — иначе смена через полночь
    // на границе месяца попадёт в отчёт целиком
    if (periodFrom) conds.push(sql`${timeEntries.endedAt} >= ${periodFrom.toISOString()}::timestamptz`)
    if (periodTo) conds.push(lte(timeEntries.startedAt, periodTo))

    const clipEnd = periodTo ? sql`${periodTo.toISOString()}::timestamptz` : sql`${timeEntries.endedAt}`
    const clipStart = periodFrom ? sql`${periodFrom.toISOString()}::timestamptz` : sql`${timeEntries.startedAt}`
    const minutes = sql<number>`coalesce(sum(greatest(extract(epoch from (
      least(${timeEntries.endedAt}, ${clipEnd}) - greatest(${timeEntries.startedAt}, ${clipStart})
    )) / 60, 0)), 0)::int`

    const rows = await db
      .select({
        userId: timeEntries.userId,
        userName: users.name,
        avatarUrl: users.avatarUrl,
        projectId: projects.id,
        projectName: projects.name,
        // Значок проекта: в разбивке по людям проекты различают по цвету, а
        // не вчитываясь в длинные названия на трёх языках.
        projectColor: projects.color,
        projectLogoUrl: projects.logoUrl,
        minutes,
        entries: sql<number>`count(*)::int`,
      })
      .from(timeEntries)
      .innerJoin(projects, eq(projects.id, timeEntries.projectId))
      .innerJoin(users, eq(users.id, timeEntries.userId))
      .where(and(...conds))
      .groupBy(timeEntries.userId, users.name, users.avatarUrl, projects.id, projects.name)
      // проекты с нулём внутри периода не показываем: запись могла задеть
      // границу краем, а строка «0ч 0м» в платёжном отчёте только мешает
      .having(sql`${minutes} > 0`)

    // Дни, в которые человек работал, и часы в каждом. Для расчётов это нужно
    // не меньше суммы: по ним сверяют табель и считают среднюю выработку.
    const dayRows = await db.execute(sql`
      with bounds as (
        select ${timeEntries.userId} as uid, ${timeEntries.startedAt} as s, ${timeEntries.endedAt} as e
        from ${timeEntries}
        inner join ${projects} on ${projects.id} = ${timeEntries.projectId}
        where ${and(...conds)}
      ),
      spread as (
        select b.uid,
          generate_series(
            date_trunc('day', b.s at time zone 'UTC'),
            date_trunc('day', b.e at time zone 'UTC'),
            interval '1 day'
          ) as day_local,
          b.s, b.e
        from bounds b
      )
      select uid,
        to_char(day_local, 'YYYY-MM-DD') as day,
        coalesce(sum(greatest(extract(epoch from (
          least(e, (day_local + interval '1 day') at time zone 'UTC')
          - greatest(s, day_local at time zone 'UTC')
        )) / 60, 0)), 0)::int as minutes
      from spread
      group by uid, day_local
      having coalesce(sum(greatest(extract(epoch from (
        least(e, (day_local + interval '1 day') at time zone 'UTC')
        - greatest(s, day_local at time zone 'UTC')
      )) / 60, 0)), 0) > 0
      order by day_local
    `)

    const daysByUser = new Map<string, { day: string; minutes: number }[]>()
    for (const r of dayRows as unknown as { uid: string; day: string; minutes: number }[]) {
      const list = daysByUser.get(r.uid) ?? []
      list.push({ day: String(r.day), minutes: Number(r.minutes) })
      daysByUser.set(r.uid, list)
    }

    // сворачиваем в людей с разбивкой по проектам: так читают отчёт
    const byUser = new Map<string, { userId: string; name: string; avatarUrl: string | null; minutes: number; projects: { id: string; name: string; minutes: number; color: string | null; logoUrl: string | null }[] }>()
    for (const r of rows) {
      const entry = byUser.get(r.userId) ?? { userId: r.userId, name: r.userName, avatarUrl: r.avatarUrl, minutes: 0, projects: [] }
      entry.minutes += r.minutes
      entry.projects.push({
        id: r.projectId,
        name: r.projectName,
        minutes: r.minutes,
        color: r.projectColor,
        logoUrl: r.projectLogoUrl,
      })
      byUser.set(r.userId, entry)
    }

    const people = [...byUser.values()]
      .map((u) => {
        const days = daysByUser.get(u.userId) ?? []
        return {
          ...u,
          projects: u.projects.sort((a, b) => b.minutes - a.minutes),
          days,
          // средняя выработка считается по РАБОЧИМ дням, а не по календарным:
          // делить месячную сумму на 30 бессмысленно, если человек работал 12 дней
          daysWorked: days.length,
          avgPerDay: days.length ? Math.round(u.minutes / days.length) : 0,
        }
      })
      .filter((u) => u.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes)

    return c.json({
      people,
      totalMinutes: people.reduce((sum, u) => sum + u.minutes, 0),
    })
  },
)


export type TimeConfig = {
  maxTimers: number
  idleAction: 'remind' | 'stop'
  idleHours: number
  repeatHours: number
  /** ISO-код страны — из него подставляются пояс, первый день недели и язык */
  country: string
  /** IANA, например Asia/Jerusalem: по нему режутся сутки в отчётах */
  timezone: string
  /** 0 = воскресенье … 1 = понедельник; в Израиле неделя начинается с воскресенья */
  weekStart: number
  /** пропускать описания записей через ИИ на язык проекта */
  translate: boolean
  /** Начало рабочего дня, минуты от полуночи: 9:00 = 540. */
  workDayStart: number
  /** Конец рабочего дня, минуты от полуночи: 18:00 = 1080. */
  workDayEnd: number
}

export const DEFAULT_TIME_CONFIG: TimeConfig = {
  maxTimers: 1, // параллельные таймеры разрешены, но по умолчанию их нет
  idleAction: 'remind',
  idleHours: 8,
  repeatHours: 8,
  country: '',
  timezone: 'UTC',
  weekStart: 1,
  translate: false,
  workDayStart: 9 * 60,
  workDayEnd: 18 * 60,
}

/** Минуты от полуночи из «9:00» или числа; вне суток — значение по умолчанию. */
function readMinutes(v: unknown, fallback: number): number {
  const n = typeof v === 'string' && v.includes(':') ? Number(v.split(':')[0]) * 60 + Number(v.split(':')[1]) : Number(v)
  return Number.isFinite(n) && n >= 0 && n <= 24 * 60 ? Math.round(n) : fallback
}

export function readTimeConfig(raw: string | null | undefined): TimeConfig {
  try {
    const p = JSON.parse(raw || '{}') as Partial<TimeConfig>
    return {
      maxTimers: Math.max(1, Math.min(20, Number(p.maxTimers) || DEFAULT_TIME_CONFIG.maxTimers)),
      idleAction: p.idleAction === 'stop' ? 'stop' : 'remind',
      idleHours: Math.max(1, Math.min(48, Number(p.idleHours) || DEFAULT_TIME_CONFIG.idleHours)),
      repeatHours: Math.max(1, Math.min(48, Number(p.repeatHours) || DEFAULT_TIME_CONFIG.repeatHours)),
      country: typeof p.country === 'string' ? p.country.slice(0, 2).toUpperCase() : '',
      timezone: typeof p.timezone === 'string' && p.timezone ? p.timezone : DEFAULT_TIME_CONFIG.timezone,
      weekStart: Number.isInteger(p.weekStart) && Number(p.weekStart) >= 0 && Number(p.weekStart) <= 6 ? Number(p.weekStart) : 1,
      translate: p.translate === true,
      workDayStart: readMinutes(p.workDayStart, DEFAULT_TIME_CONFIG.workDayStart),
      // Конец раньше начала — сутки наизнанку: считать по такому нечего, и
      // молча принимать это значит потом объяснять отрицательные часы.
      workDayEnd:
        readMinutes(p.workDayEnd, DEFAULT_TIME_CONFIG.workDayEnd) > readMinutes(p.workDayStart, DEFAULT_TIME_CONFIG.workDayStart)
          ? readMinutes(p.workDayEnd, DEFAULT_TIME_CONFIG.workDayEnd)
          : DEFAULT_TIME_CONFIG.workDayEnd,
    }
  } catch {
    return DEFAULT_TIME_CONFIG
  }
}

/**
 * Настройки времени для проекта: свои, иначе компании.
 *
 * Наследование, а не копия при создании: часовой пояс меняют раз в жизни, но
 * когда меняют — ожидают, что он поменяется везде, а не только в проектах,
 * заведённых после. Из интерфейса проекта настройки убраны, поле осталось —
 * если однажды понадобится проект в другом поясе, включать будет нечего.
 */
export async function timeConfigForProject(projectId: string): Promise<TimeConfig> {
  const row = await db
    .select({ own: projects.timeConfig, company: companies.timeConfig })
    .from(projects)
    .leftJoin(companies, eq(companies.id, projects.companyId))
    .where(eq(projects.id, projectId))
    .limit(1)
  const r = row[0]
  if (!r) return DEFAULT_TIME_CONFIG
  // «{}» — это «не задано», а не «всё по умолчанию»: пустой объект стоит у
  // всех проектов с рождения, и принимать его за настройку значило бы никогда
  // не дойти до компании.
  const own = (r.own ?? '').trim()
  return readTimeConfig(own && own !== '{}' ? own : r.company)
}

/** Чужие записи видит и правит только руководство проекта. */
async function canSeeOthers(projectId: string, userId: string): Promise<boolean> {
  const m = await projectRoleOf(projectId, userId)
  return m?.role === 'owner' || m?.role === 'admin'
}

const serialize = (
  e: typeof timeEntries.$inferSelect,
  user?: { id: string; name: string; avatarUrl: string | null } | null,
  task?: { id: string; number: string; title: string } | null,
) => ({
  id: e.id,
  userId: e.userId,
  user: user ?? null,
  task: task ?? null,
  description: e.description,
  startedAt: e.startedAt,
  endedAt: e.endedAt,
  running: e.endedAt === null,
  // минуты считает сервер: у клиентов часы разъезжаются, а в отчёте это цена
  minutes: e.endedAt ? Math.round((e.endedAt.getTime() - e.startedAt.getTime()) / 60_000) : null,
  autoStopped: e.autoStopped,
  createdVia: e.createdVia,
})

async function hydrate(rows: (typeof timeEntries.$inferSelect)[]) {
  if (!rows.length) return []
  const userIds = [...new Set(rows.map((r) => r.userId))]
  const taskIds = [...new Set(rows.map((r) => r.taskId).filter(Boolean) as string[])]
  const [people, taskRows] = await Promise.all([
    db.select().from(users).where(inArray(users.id, userIds)),
    taskIds.length ? db.select().from(tasks).where(inArray(tasks.id, taskIds)) : Promise.resolve([]),
  ])
  const byUser = new Map(people.map((u) => [u.id, { id: u.id, name: u.name, avatarUrl: u.avatarUrl }]))
  const byTask = new Map(taskRows.map((t) => [t.id, { id: t.id, number: t.number, title: t.title }]))
  return rows.map((r) => serialize(r, byUser.get(r.userId), r.taskId ? byTask.get(r.taskId) : null))
}


/**
 * Переводит описание записи на язык проекта, если это включено. Делается
 * ФОНОМ после сохранения: человек не должен ждать модель, чтобы продолжить.
 */
export async function maybeTranslate(projectId: string, entryId: string, text: string): Promise<void> {
  if (!text.trim()) return
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project || !(await timeConfigForProject(projectId)).translate) return
  const language = (JSON.parse(project.aiConfig || '{}') as { language?: string }).language ?? 'en'
  const translated = await translateTimeEntry(projectId, text, language)
  if (!translated) return
  await db.update(timeEntries).set({ description: translated }).where(eq(timeEntries.id, entryId))
  broadcast(projectId, 'time', { action: 'update', id: entryId, userId: '' })
}

// --- Текущие таймеры --------------------------------------------------------

/**
 * Что идёт прямо сейчас у меня — ВО ВСЕХ проектах, а не только в открытом.
 * Человек один: уйдя в другой проект, он не перестаёт работать, и таймер,
 * забытый в соседнем проекте, должен быть виден, а не исчезать из глаз.
 */
timeRoute.get('/running', async (c) => {
  const { projectId, sub } = c.get('auth')
  const rows = await db
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.userId, sub), isNull(timeEntries.endedAt)))
    .orderBy(asc(timeEntries.startedAt))

  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  // названия проектов нужны, чтобы отличить чужой таймер от здешнего
  const otherIds = [...new Set(rows.map((r) => r.projectId).filter((id) => id !== projectId))]
  const others = otherIds.length
    ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, otherIds))
    : []
  const nameById = new Map(others.map((p) => [p.id, p.name]))

  const items = (await hydrate(rows)).map((item, i) => ({
    ...item,
    projectId: rows[i]!.projectId,
    // null для текущего проекта — клиенту достаточно понять «это не здесь»
    projectName: rows[i]!.projectId === projectId ? null : nameById.get(rows[i]!.projectId) ?? '—',
  }))

  return c.json({ items, config: await timeConfigForProject(projectId) })
})

/**
 * Мой идущий таймер — по сессии, без привязки к проекту.
 *
 * Трею нужно знать, идут ли часы, даже когда ни один проект не открыт: иначе
 * панель показывает «таймер не запущен», а он идёт, и остановить его оттуда
 * нельзя. Записи и так ищутся по человеку — project-токен здесь ничего не
 * решал, только мешал.
 */
export const timeMineRoute = new Hono<SessionEnv>()
timeMineRoute.use('*', requireSession)

timeMineRoute.get('/running', async (c) => {
  const { sub } = c.get('session')
  const rows = await db
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.userId, sub), isNull(timeEntries.endedAt)))
    .orderBy(asc(timeEntries.startedAt))

  const ids = [...new Set(rows.map((r) => r.projectId))]
  const names = ids.length
    ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, ids))
    : []
  const nameById = new Map(names.map((p) => [p.id, p.name]))

  const items = (await hydrate(rows)).map((item, i) => ({
    ...item,
    projectId: rows[i]!.projectId,
    projectName: nameById.get(rows[i]!.projectId) ?? '—',
  }))
  return c.json({ items })
})

/**
 * Мои часы по ВСЕМ проектам — экран времени в мобильном.
 *
 * Права здесь те же, что и в проектной ручке: свои записи человек видит и
 * правит всегда. Отдельная ручка нужна не ради прав, а ради одного запроса
 * вместо запроса на каждый проект: иначе главная опрашивала бы их по очереди,
 * а итог в шапке расходился бы с итогом на странице из-за округлений.
 *
 * userId в фильтре слушаем только у того, кто и так вправе видеть чужое, и
 * только по проектам, где он руководит. Без прав параметр игнорируется молча —
 * подделанный запрос не отдаёт чужие часы и не сообщает, что попытка замечена.
 */
/**
 * Мои последние записи — по сессии, без проектного токена.
 *
 * Страница компании стоит над проектами, и проектного токена на ней нет. Из-за
 * этого поправить свои часы можно было только зайдя в конкретный проект, а
 * перенести время между проектами — вообще никак, только руками в базе.
 *
 * Только СВОИ записи: чужие часы правит начальство проекта, и делает это у
 * себя, где видит контекст. Здесь человек разбирает собственный день.
 */
timeMineRoute.get('/recent', async (c) => {
  const { sub } = c.get('session')
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit')) || 10))

  const rows = await db
    .select({ e: timeEntries, p: projects, t: tasks })
    .from(timeEntries)
    .innerJoin(projects, eq(projects.id, timeEntries.projectId))
    .leftJoin(tasks, eq(tasks.id, timeEntries.taskId))
    .where(eq(timeEntries.userId, sub))
    .orderBy(desc(timeEntries.startedAt))
    .limit(limit)

  // Куда можно перенести: проекты, где человек состоит. Предлагать чужие
  // бессмысленно — ручка правки их всё равно отвергнет.
  // Значок проекта — логотип, иначе цвет. По названиям проекты в длинном
  // списке не различают: их читают, а значок узнают.
  const mine = await db
    .select({
      id: projects.id,
      name: projects.name,
      companyId: projects.companyId,
      color: projects.color,
      logoUrl: projects.logoUrl,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(eq(projectMembers.userId, sub))

  return c.json({
    // Поля те же, что у списка записей проекта: список рисует один и тот же
    // компонент, и расхождение полей означает «то же самое, но не работает».
    items: rows.map(({ e, p, t }) => ({
      id: e.id,
      userId: e.userId,
      user: null,
      projectId: e.projectId,
      projectName: p.name,
      projectColor: p.color,
      projectLogoUrl: p.logoUrl,
      task: t ? { id: t.id, number: t.number, title: t.title } : null,
      description: e.description,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      running: !e.endedAt,
      minutes: e.endedAt ? Math.round((e.endedAt.getTime() - e.startedAt.getTime()) / 60000) : null,
      autoStopped: e.autoStopped,
    })),
    projects: mine,
  })
})

const minePatchSchema = z.object({
  projectId: z.string().optional(),
  description: z.string().max(500).optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().nullable().optional(),
})

timeMineRoute.patch('/:id', zValidator('json', minePatchSchema), async (c) => {
  const { sub } = c.get('session')
  const entry = await db.query.timeEntries.findFirst({ where: eq(timeEntries.id, c.req.param('id')) })
  if (!entry) return c.json({ error: 'Not found' }, 404)
  // Здесь правят ТОЛЬКО своё — без исключений для начальства: этот экран про
  // собственный день, а чужие часы правят в проекте, где виден контекст.
  if (entry.userId !== sub) return c.json({ error: 'Forbidden' }, 403)

  const b = c.req.valid('json')
  const patch: Partial<typeof timeEntries.$inferInsert> = { updatedAt: new Date() }

  if (b.projectId && b.projectId !== entry.projectId) {
    // Переносить можно только туда, где человек состоит.
    if (!(await projectRoleOf(b.projectId, sub))) {
      return c.json({ error: 'You are not a member of that project' }, 403)
    }
    patch.projectId = b.projectId
    // Задача осталась в прежнем проекте — связь рвём, иначе запись указывала
    // бы на задачу чужого проекта, и в отчёте появился бы висячий номер.
    patch.taskId = null
  }
  if (b.description !== undefined) patch.description = b.description
  if (b.startedAt) patch.startedAt = new Date(b.startedAt)
  if (b.endedAt !== undefined) {
    patch.endedAt = b.endedAt ? new Date(b.endedAt) : null
    // Ручная правка снимает пометку автостопа: время подтверждено человеком.
    if (b.endedAt) patch.autoStopped = false
  }

  const started = patch.startedAt ?? entry.startedAt
  const ended = patch.endedAt !== undefined ? patch.endedAt : entry.endedAt
  if (ended && ended.getTime() < started.getTime()) {
    return c.json({ error: 'The end cannot be earlier than the start' }, 400)
  }

  const [row] = await db.update(timeEntries).set(patch).where(eq(timeEntries.id, entry.id)).returning()
  return c.json({
    id: row!.id,
    projectId: row!.projectId,
    description: row!.description,
    startedAt: row!.startedAt,
    endedAt: row!.endedAt,
  })
})

timeMineRoute.delete('/:id', async (c) => {
  const { sub } = c.get('session')
  const entry = await db.query.timeEntries.findFirst({ where: eq(timeEntries.id, c.req.param('id')) })
  if (!entry) return c.json({ error: 'Not found' }, 404)
  if (entry.userId !== sub) return c.json({ error: 'Forbidden' }, 403)
  await db.delete(timeEntries).where(eq(timeEntries.id, entry.id))
  return c.json({ ok: true })
})

timeMineRoute.get(
  '/summary',
  zValidator(
    'query',
    z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      projectId: z.string().optional(),
      userId: z.string().optional(),
    }),
  ),
  async (c) => {
    const { sub } = c.get('session')
    const f = c.req.valid('query')

    // Проекты, где я состою, и те из них, где я вправе видеть чужие часы.
    const myMemberships = await db
      .select({ projectId: projectMembers.projectId, role: projectMembers.role })
      .from(projectMembers)
      .where(eq(projectMembers.userId, sub))

    const myProjectIds = myMemberships.map((m) => m.projectId)
    if (!myProjectIds.length) {
      return c.json({ items: [], byProject: [], totalMinutes: 0, canSeeOthers: false, people: [] })
    }

    const leadProjectIds = myMemberships
      .filter((m) => m.role === 'owner' || m.role === 'admin')
      .map((m) => m.projectId)
    const canSeeOthers = leadProjectIds.length > 0

    // Чьи записи показываем. Кнопка выбора человека на клиенте блокируется, но
    // решает всё равно сервер: заблокированный контрол — подсказка, не защита.
    const scopeIds = f.projectId ? [f.projectId] : myProjectIds
    const allowedIds = scopeIds.filter((id) => myProjectIds.includes(id))
    if (!allowedIds.length) return c.json({ error: 'Forbidden' }, 403)

    const target = canSeeOthers && f.userId ? f.userId : sub
    // Чужие часы — только там, где я руковожу, даже если проекты общие.
    const searchIds = target === sub ? allowedIds : allowedIds.filter((id) => leadProjectIds.includes(id))
    if (!searchIds.length) {
      return c.json({ items: [], byProject: [], totalMinutes: 0, canSeeOthers, people: [] })
    }

    const periodFrom = f.from ? new Date(f.from) : null
    const periodTo = f.to ? new Date(f.to) : null
    // Дата без времени — это все сутки целиком: иначе «по сегодня» теряет день.
    if (periodTo && !f.to!.includes('T')) periodTo.setHours(23, 59, 59, 999)

    const conds = [
      inArray(timeEntries.projectId, searchIds),
      eq(timeEntries.userId, target),
      sql`${timeEntries.endedAt} is not null`,
    ]
    // Берём пересекающиеся с периодом записи, лишнее отрежем ниже.
    if (periodFrom) conds.push(sql`${timeEntries.endedAt} >= ${periodFrom.toISOString()}::timestamptz`)
    if (periodTo) conds.push(lte(timeEntries.startedAt, periodTo))

    /**
     * Минуты ВНУТРИ периода — та же обрезка, что в проектной сводке. Смена с
     * 23:00 до 02:00 на границе месяца иначе попала бы в отчёт целиком.
     */
    const clipEnd = periodTo ? sql`${periodTo.toISOString()}::timestamptz` : sql`${timeEntries.endedAt}`
    const clipStart = periodFrom ? sql`${periodFrom.toISOString()}::timestamptz` : sql`${timeEntries.startedAt}`
    const clipped = sql<number>`extract(epoch from (
      least(${timeEntries.endedAt}, ${clipEnd})
      - greatest(${timeEntries.startedAt}, ${clipStart})
    )) / 60`
    const minutes = sql<number>`coalesce(sum(greatest(${clipped}, 0)), 0)::int`

    const [rows, byProjectRows] = await Promise.all([
      db
        .select()
        .from(timeEntries)
        .where(and(...conds))
        .orderBy(desc(timeEntries.startedAt))
        .limit(500),
      db
        .select({
          projectId: timeEntries.projectId,
          projectName: projects.name,
          color: projects.color,
          logoUrl: projects.logoUrl,
          minutes,
          entries: sql<number>`count(*)::int`,
        })
        .from(timeEntries)
        .innerJoin(projects, eq(projects.id, timeEntries.projectId))
        .where(and(...conds))
        .groupBy(timeEntries.projectId, projects.name, projects.color, projects.logoUrl),
    ])

    /**
     * Коллеги для фильтра — только тем, кто вправе их видеть. Без прав список
     * не приходит вовсе, а не приходит и прячется: скрытое в клиенте достаётся
     * из ответа за минуту, и состав команды утёк бы тому, кого он не касается.
     */
    const people = canSeeOthers
      ? await db
          .selectDistinct({ id: users.id, name: users.name, avatarUrl: users.avatarUrl })
          .from(projectMembers)
          .innerJoin(users, eq(users.id, projectMembers.userId))
          .where(inArray(projectMembers.projectId, leadProjectIds))
      : []

    return c.json({
      items: await hydrate(rows),
      byProject: byProjectRows,
      totalMinutes: byProjectRows.reduce((s, r) => s + r.minutes, 0),
      canSeeOthers,
      people,
    })
  },
)

timeRoute.post(
  '/start',
  zValidator(
    'json',
    z.object({
      taskId: z.string().nullable().optional(),
      description: z.string().max(500).default(''),
      /** ISO — если работа началась раньше, чем человек вспомнил про таймер */
      startedAt: z.string().optional(),
      /**
       * Проект, в котором стартуем. Project-токен один на приложение и
       * меняется с задержкой при переходе между проектами — полагаться на
       * него значит иногда записывать часы не туда. Клиент знает, где он
       * находится, и говорит это прямо.
       */
      projectId: z.string().optional(),
    }),
  ),
  async (c) => {
    const { projectId: tokenProject, sub } = c.get('auth')
    const body = c.req.valid('json')

    // членство обязательно: иначе можно завести часы в чужом проекте
    let projectId = tokenProject
    if (body.projectId && body.projectId !== tokenProject) {
      const membership = await projectRoleOf(body.projectId, sub)
      if (!membership) return c.json({ error: 'You are not a member of that project' }, 403)
      projectId = body.projectId
    }

    const cfg = await timeConfigForProject(projectId)

    // Лимит про ЧЕЛОВЕКА, а не про проект: иначе при лимите 1 можно набрать
    // по таймеру в каждом проекте и «работать» в пяти местах разом.
    const running = await db
      .select()
      .from(timeEntries)
      .where(and(eq(timeEntries.userId, sub), isNull(timeEntries.endedAt)))
    if (running.length >= cfg.maxTimers) {
      const elsewhere = running.find((r) => r.projectId !== projectId)
      const otherName = elsewhere
        ? (await db.query.projects.findFirst({ where: eq(projects.id, elsewhere.projectId) }))?.name
        : null
      return c.json(
        {
          error: otherName
            ? `A timer is already running in "${otherName}". Stop it first, or raise the parallel-timer limit.`
            : cfg.maxTimers === 1
              ? 'A timer is already running. Stop it first, or raise the parallel-timer limit in project settings.'
              : `You already have ${running.length} timers running (limit ${cfg.maxTimers}).`,
          running: await hydrate(running),
        },
        409,
      )
    }

    if (body.taskId) {
      const task = await db.query.tasks.findFirst({ where: and(eq(tasks.id, body.taskId), eq(tasks.projectId, projectId)) })
      if (!task) return c.json({ error: 'Task not found in this project' }, 404)
    }

    const [row] = await db
      .insert(timeEntries)
      .values({
        projectId,
        userId: sub,
        taskId: body.taskId ?? null,
        description: body.description,
        startedAt: body.startedAt ? new Date(body.startedAt) : new Date(),
      })
      .returning()

    broadcast(projectId, 'time', { action: 'start', id: row!.id, userId: sub })
    // И лично человеку: трей живёт вне проекта, а часы — его собственные.
    // Без этого панель до полуминуты показывала прежнее состояние.
    sendToUserAnywhere(sub, 'time', { action: 'start', id: row!.id })
    void maybeTranslate(projectId, row!.id, row!.description).catch(() => {})
    return c.json((await hydrate([row!]))[0], 201)
  },
)

timeRoute.post('/:id/stop', async (c) => {
  const { projectId, sub } = c.get('auth')
  // Запись ищем без привязки к текущему проекту: свой таймер, забытый в
  // соседнем проекте, должен останавливаться там же, где он показан.
  const entry = await db.query.timeEntries.findFirst({ where: eq(timeEntries.id, c.req.param('id')) })
  if (!entry) return c.json({ error: 'Not found' }, 404)
  // чужой таймер в чужом проекте — не наше дело
  if (entry.userId !== sub && !(entry.projectId === projectId && (await canSeeOthers(projectId, sub)))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  if (entry.endedAt) return c.json({ error: 'Already stopped' }, 400)

  const endedAt = new Date()
  // Меньше секунды — двойной клик, а не работа. Порог намеренно крошечный:
  // всё, что человек делал хоть сколько-то, должно записаться.
  if (endedAt.getTime() - entry.startedAt.getTime() < 1_000) {
    await db.delete(timeEntries).where(eq(timeEntries.id, entry.id))
    broadcast(entry.projectId, 'time', { action: 'delete', id: entry.id, userId: entry.userId })
    sendToUserAnywhere(entry.userId, 'time', { action: 'delete', id: entry.id })
    return c.json({ discarded: true, reason: 'Stopped within a second — nothing recorded.' })
  }

  const [row] = await db
    .update(timeEntries)
    .set({ endedAt, updatedAt: endedAt })
    .where(eq(timeEntries.id, entry.id))
    .returning()

  broadcast(entry.projectId, 'time', { action: 'stop', id: row!.id, userId: entry.userId })
  sendToUserAnywhere(entry.userId, 'time', { action: 'stop', id: row!.id })
  return c.json((await hydrate([row!]))[0])
})

// --- Список и правка --------------------------------------------------------

timeRoute.get(
  '/',
  zValidator(
    'query',
    z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      userId: z.string().optional(),
      taskId: z.string().optional(),
      q: z.string().optional(),
      limit: z.coerce.number().min(1).max(500).default(200),
    }),
  ),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    const f = c.req.valid('query')
    const privileged = await canSeeOthers(projectId, sub)

    const conds = [eq(timeEntries.projectId, projectId)]
    // участник видит только свои записи — чужие часы не его дело
    if (!privileged) conds.push(eq(timeEntries.userId, sub))
    else if (f.userId) conds.push(eq(timeEntries.userId, f.userId))

    // Запись попадает в выборку, если ПЕРЕСЕКАЕТСЯ с периодом, а не начата
    // внутри него: работа с 23:00 до 02:00 относится к обоим дням, и при
    // поиске «за сегодня» ночная смена обязана найтись.
    if (f.from) {
      const from = new Date(f.from)
      // ISO-строкой с явным приведением: Date в sql-шаблоне драйвер не понимает
      conds.push(sql`coalesce(${timeEntries.endedAt}, now()) >= ${from.toISOString()}::timestamptz`)
    }
    if (f.to) {
      const to = new Date(f.to)
      if (!f.to.includes('T')) to.setHours(23, 59, 59, 999)
      conds.push(lte(timeEntries.startedAt, to))
    }
    if (f.taskId) conds.push(eq(timeEntries.taskId, f.taskId))
    if (f.q?.trim()) conds.push(sql`${timeEntries.description} ilike ${`%${f.q.trim()}%`}`)

    const rows = await db
      .select()
      .from(timeEntries)
      .where(and(...conds))
      .orderBy(desc(timeEntries.startedAt))
      .limit(f.limit)

    return c.json({ items: await hydrate(rows), canSeeOthers: privileged, config: await timeConfigForProject(projectId) })
  },
)

const patchSchema = z.object({
  /** перенести запись в другой проект — часы уехали не туда, бывает */
  projectId: z.string().optional(),
  taskId: z.string().nullable().optional(),
  description: z.string().max(500).optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().nullable().optional(),
})

timeRoute.patch('/:id', zValidator('json', patchSchema), async (c) => {
  const { projectId, sub } = c.get('auth')
  const entry = await db.query.timeEntries.findFirst({ where: eq(timeEntries.id, c.req.param('id')) })
  if (!entry) return c.json({ error: 'Not found' }, 404)
  // свою запись правим где угодно; чужую — только у себя в проекте и с правами
  if (entry.userId !== sub && !(entry.projectId === projectId && (await canSeeOthers(projectId, sub)))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const b = c.req.valid('json')
  const patch: Partial<typeof timeEntries.$inferInsert> = { updatedAt: new Date() }

  // Смена проекта: часы принадлежат проекту, поэтому переносить их можно
  // только туда, где человек действительно состоит.
  let targetProject = entry.projectId
  if (b.projectId && b.projectId !== entry.projectId) {
    const membership = await projectRoleOf(b.projectId, sub)
    if (!membership) return c.json({ error: 'You are not a member of that project' }, 403)
    patch.projectId = b.projectId
    // задача осталась в прежнем проекте — она там и остаётся, связь рвём
    patch.taskId = null
    targetProject = b.projectId
  }

  if (b.taskId !== undefined) {
    if (b.taskId) {
      const task = await db.query.tasks.findFirst({ where: and(eq(tasks.id, b.taskId), eq(tasks.projectId, targetProject)) })
      if (!task) return c.json({ error: 'Task not found in this project' }, 404)
    }
    patch.taskId = b.taskId
  }
  if (b.description !== undefined) patch.description = b.description
  if (b.startedAt) patch.startedAt = new Date(b.startedAt)
  if (b.endedAt !== undefined) {
    patch.endedAt = b.endedAt ? new Date(b.endedAt) : null
    // ручная правка снимает пометку автостопа: время теперь подтверждено человеком
    if (b.endedAt) patch.autoStopped = false
  }

  const started = patch.startedAt ?? entry.startedAt
  const ended = patch.endedAt !== undefined ? patch.endedAt : entry.endedAt
  if (ended && ended.getTime() <= started.getTime()) {
    return c.json({ error: 'End must be after start (a shift past midnight already counts as the next day)' }, 400)
  }

  const [row] = await db.update(timeEntries).set(patch).where(eq(timeEntries.id, entry.id)).returning()
  broadcast(entry.projectId, 'time', { action: 'update', id: row!.id, userId: entry.userId })
  if (targetProject !== entry.projectId) {
    broadcast(targetProject, 'time', { action: 'update', id: row!.id, userId: entry.userId })
  }
  if (b.description !== undefined) void maybeTranslate(projectId, row!.id, row!.description).catch(() => {})
  return c.json((await hydrate([row!]))[0])
})

/** Ручная запись задним числом — работал, а таймер не включил. */
timeRoute.post(
  '/',
  zValidator(
    'json',
    z.object({
      taskId: z.string().nullable().optional(),
      description: z.string().max(500).default(''),
      startedAt: z.string(),
      endedAt: z.string(),
    }),
  ),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    const b = c.req.valid('json')
    const started = new Date(b.startedAt)
    const ended = new Date(b.endedAt)
    if (ended.getTime() <= started.getTime()) return c.json({ error: 'End must be after start' }, 400)

    if (b.taskId) {
      const task = await db.query.tasks.findFirst({ where: and(eq(tasks.id, b.taskId), eq(tasks.projectId, projectId)) })
      if (!task) return c.json({ error: 'Task not found in this project' }, 404)
    }

    const [row] = await db
      .insert(timeEntries)
      .values({ projectId, userId: sub, taskId: b.taskId ?? null, description: b.description, startedAt: started, endedAt: ended })
      .returning()

    broadcast(projectId, 'time', { action: 'create', id: row!.id, userId: sub })
    void maybeTranslate(projectId, row!.id, row!.description).catch(() => {})
    return c.json((await hydrate([row!]))[0], 201)
  },
)

timeRoute.delete('/:id', async (c) => {
  const { projectId, sub } = c.get('auth')
  const entry = await db.query.timeEntries.findFirst({
    where: and(eq(timeEntries.id, c.req.param('id')), eq(timeEntries.projectId, projectId)),
  })
  if (!entry) return c.json({ error: 'Not found' }, 404)
  if (entry.userId !== sub && !(await canSeeOthers(projectId, sub))) return c.json({ error: 'Forbidden' }, 403)

  await db.delete(timeEntries).where(eq(timeEntries.id, entry.id))
  void logActivity({
    projectId,
    actorId: sub,
    action: 'delete',
    entityType: 'time',
    entityId: entry.id,
    entityLabel: entry.description || '—',
  })
  broadcast(projectId, 'time', { action: 'delete', id: entry.id, userId: entry.userId })
  return c.json({ ok: true })
})

/**
 * Сводка по всей компании (SPEC §8.32) — для расчёта зарплат и счетов.
 * Только admin/manager компании: это чужие часы, и видеть их вправе лишь тот,
 * кто за них платит.
 *
 * Строки — «человек × проект»: именно так их и сводят, когда считают, кому
 * сколько заплатить и на какой проект списать.
 */

// --- Сводка -----------------------------------------------------------------

/** Часы по людям и по задачам за период — основа графиков и выгрузок. */
timeRoute.get(
  '/summary',
  zValidator('query', z.object({ from: z.string().optional(), to: z.string().optional() })),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    const f = c.req.valid('query')
    const privileged = await canSeeOthers(projectId, sub)

    const tz = (await timeConfigForProject(projectId)).timezone

    // Границы периода в поясе ПРОЕКТА: «этот месяц» начинается в 00:00 там, где
    // работает команда, а не там, где стоит сервер.
    const periodFrom = f.from ? new Date(f.from) : null
    const periodTo = f.to ? new Date(f.to) : null
    if (periodTo && !f.to!.includes('T')) periodTo.setHours(23, 59, 59, 999)

    const conds = [eq(timeEntries.projectId, projectId), sql`${timeEntries.endedAt} is not null`]
    if (!privileged) conds.push(eq(timeEntries.userId, sub))
    // берём всё, что ПЕРЕСЕКАЕТСЯ с периодом, а лишнее отрежем ниже
    if (periodFrom) conds.push(sql`${timeEntries.endedAt} >= ${periodFrom.toISOString()}::timestamptz`)
    if (periodTo) conds.push(lte(timeEntries.startedAt, periodTo))

    /**
     * Минуты записи ВНУТРИ периода. Смена с 23:00 до 02:00 отдаёт час одному
     * дню и два — другому; иначе отчёт за день завышен на чужие часы, а сумма
     * дней не сходится с итогом. Время терять нельзя, но и приписывать чужое
     * тоже.
     */
    const clipEnd = periodTo ? sql`${periodTo.toISOString()}::timestamptz` : sql`${timeEntries.endedAt}`
    const clipStart = periodFrom ? sql`${periodFrom.toISOString()}::timestamptz` : sql`${timeEntries.startedAt}`
    const clipped = sql<number>`extract(epoch from (
      least(${timeEntries.endedAt}, ${clipEnd})
      - greatest(${timeEntries.startedAt}, ${clipStart})
    )) / 60`
    const minutes = sql<number>`coalesce(sum(greatest(${clipped}, 0)), 0)::int`

    const [byUser, byDay] = await Promise.all([
      db
        .select({ userId: timeEntries.userId, name: users.name, avatarUrl: users.avatarUrl, minutes, entries: sql<number>`count(*)::int` })
        .from(timeEntries)
        .innerJoin(users, eq(users.id, timeEntries.userId))
        .where(and(...conds))
        .groupBy(timeEntries.userId, users.name, users.avatarUrl),
      // Раскладываем каждую запись по суткам, которые она задевает: сутки
      // берутся в поясе проекта, а от каждого дня считается ровно тот кусок,
      // что попал внутрь записи И внутрь периода.
      db.execute(sql`
        with bounds as (
          select
            ${timeEntries.startedAt} as s,
            ${timeEntries.endedAt} as e
          from ${timeEntries}
          where ${and(...conds)}
        ),
        spread as (
          select
            generate_series(
              date_trunc('day', b.s at time zone ${tz}),
              date_trunc('day', b.e at time zone ${tz}),
              interval '1 day'
            ) as day_local,
            b.s, b.e
          from bounds b
        )
        select
          to_char(day_local, 'YYYY-MM-DD') as day,
          coalesce(sum(greatest(extract(epoch from (
            least(e, (day_local + interval '1 day') at time zone ${tz})
            - greatest(s, day_local at time zone ${tz})
          )) / 60, 0)), 0)::int as minutes
        from spread
        group by day_local
        order by day_local
      `),
    ])

    const days = (byDay as unknown as { day: string; minutes: number }[]).map((r) => ({
      day: String(r.day),
      minutes: Number(r.minutes),
    }))

    return c.json({
      byUser: byUser.sort((a, b) => b.minutes - a.minutes),
      byDay: days,
      totalMinutes: byUser.reduce((sum, r) => sum + r.minutes, 0),
      canSeeOthers: privileged,
    })
  },
)
