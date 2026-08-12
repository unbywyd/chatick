import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import sharp from 'sharp'
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { deleteObject, getObjectStream, resolveStorage, s3Bucket, s3Client, S3_KEY_PREFIX } from '../lib/s3.js'
import { sendDeletedMail } from '../lib/mails.js'
import { db } from '../db/client.js'
import { companyBackupStorage, companyStorage, companies, companyMembers, companyInvites, companyWebhooks, files, messages, projectMembers, projects, tasks, timeEntries, users } from '../db/schema.js'
import { requireSession, type SessionEnv } from '../auth.js'
import { sendInviteMail } from '../lib/mail-invite.js'
import { projectLocale } from '../lib/locale.js'
import { issueKey, listKeys, revokeKey } from '../lib/company-key.js'
import { newSecret } from '../lib/webhooks.js'
import { encrypt } from '../lib/crypto.js'
import { companyMail, sendVia, dropTransport } from '../lib/company-mail.js'
import { companyStorageFor } from '../lib/s3.js'
import { membersLockedForCompany, MEMBERS_LOCKED } from '../lib/members-locked.js'
import { timeConfigSchema } from './projects.js'
import { readTimeConfig } from './time.js'
import { LLM_PROVIDERS, testLlm, type LlmProvider } from '../lib/llm.js'
import { env } from '../env.js'

/**
 * Логотипы компаний — публично, ДО проверки сессии.
 *
 * <img> не умеет слать заголовок авторизации: под общей проверкой картинка
 * отдавала 401 и в интерфейсе висела «битой». Так же решены аватары.
 *
 * Утечки здесь нет: ключ объекта непредсказуем, а логотип компании и так
 * виден всем её участникам и в приглашениях.
 */
export const companyLogoRoute = new Hono()

companyLogoRoute.get('/:companyId/logo', async (c) => {
  const company = await db.query.companies.findFirst({ where: eq(companies.id, c.req.param('companyId')) })
  if (!company?.logoKey) return c.json({ error: 'Not found' }, 404)
  try {
    const { body, contentType } = await getObjectStream(
      { client: s3Client(), bucket: s3Bucket(), keyPrefix: S3_KEY_PREFIX, isCustom: false, publicUrl: null },
      company.logoKey,
    )
    c.header('Content-Type', contentType || 'image/webp')
    c.header('Cache-Control', 'public, max-age=86400')
    const { Readable } = await import('node:stream')
    return c.body(Readable.toWeb(body) as ReadableStream)
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
})

export const companiesRoute = new Hono<SessionEnv>()
companiesRoute.use('*', requireSession)

// Список компаний юзера (+ pending-инвайты на его email)
companiesRoute.get('/', async (c) => {
  const { sub, email } = c.get('session')
  const memberships = await db
    .select({ company: companies, role: companyMembers.role })
    .from(companyMembers)
    .innerJoin(companies, eq(companies.id, companyMembers.companyId))
    .where(eq(companyMembers.userId, sub))

  const invites = await db
    .select({ id: companyInvites.id, token: companyInvites.token, role: companyInvites.role, company: companies })
    .from(companyInvites)
    .innerJoin(companies, eq(companies.id, companyInvites.companyId))
    .where(and(eq(companyInvites.email, email), eq(companyInvites.status, 'pending')))

  // Сколько проектов в каждой компании: по этому числу интерфейс решает,
  // вести ли человека визардом первого входа. Одним запросом здесь — дешевле,
  // чем отдельным запросом со стороны клиента на каждом заходе в компанию.
  const ids = memberships.map((m) => m.company.id)
  const counts = ids.length
    ? await db
        .select({ companyId: projects.companyId, count: sql<number>`count(*)::int` })
        .from(projects)
        .where(inArray(projects.companyId, ids))
        .groupBy(projects.companyId)
    : []
  const byCompany = new Map(counts.map((r) => [r.companyId, r.count]))

  return c.json({
    companies: memberships.map((m) => ({
      ...m.company,
      myRole: m.role,
      // Своя или чужая. Отдаём готовым признаком, а не оставляем клиенту
      // сравнивать идентификаторы: от этого зависит и кнопка «создать
      // компанию», и возможность из неё выйти, и права в опасной зоне.
      isOwner: m.company.createdById === sub,
      projectsCount: byCompany.get(m.company.id) ?? 0,
    })),
    invites: invites.map((i) => ({ id: i.id, token: i.token, role: i.role, company: { id: i.company.id, name: i.company.name, logoUrl: i.company.logoUrl } })),
  })
})

// Создать компанию — создатель становится admin
companiesRoute.post(
  '/',
  zValidator('json', z.object({ name: z.string().min(1).max(120), logoUrl: z.string().url().optional() })),
  async (c) => {
    const { sub } = c.get('session')
    const { name, logoUrl } = c.req.valid('json')

    // Своя компания — одна. Участвовать можно в скольких угодно: это чужие
    // пространства, куда позвали. А заводить их пачками незачем — проекты
    // для того и существуют.
    //
    // Считаем по создателю, а не по роли. Раньше стояло условие «есть где-то
    // роль admin», и человек, которого повысили в ЧУЖОЙ компании, терял право
    // завести собственную — при том, что своей у него нет. Роль говорит о
    // правах внутри пространства, а не о том, чьё оно.
    const own = await db.query.companies.findFirst({
      where: eq(companies.createdById, sub),
      columns: { id: true, name: true },
    })
    if (own) {
      return c.json(
        {
          error: 'You already have a company',
          hint: 'Create projects inside it, or ask to be invited elsewhere.',
          company: own.name,
        },
        409,
      )
    }

    const [company] = await db.insert(companies).values({ name, logoUrl, createdById: sub }).returning()
    await db.insert(companyMembers).values({ companyId: company!.id, userId: sub, role: 'admin' })

    return c.json({ ...company, myRole: 'admin' }, 201)
  },
)

// --- helpers ---
async function memberRoleIn(companyId: string, userId: string) {
  const m = await db.query.companyMembers.findFirst({
    where: and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId)),
  })
  return m?.role ?? null
}

const canManageInvites = (role: string | null) => role === 'admin' || role === 'manager'

// Участники компании
/**
 * Обзор компании (SPEC §8.33): картина целиком, которой нет в списке проектов.
 * Один запрос вместо десятка — страница открывается сразу, а не собирается
 * на глазах.
 */
companiesRoute.get('/:companyId/overview', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  const membership = await db.query.companyMembers.findFirst({
    where: and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, sub)),
  })
  if (!membership) return c.json({ error: 'Forbidden' }, 403)

  // Период задаёт клиент; по умолчанию — текущий месяц: именно за него
  // обычно смотрят и по нему платят. Часы и активность считаем в этих
  // границах, иначе «за всё время» смешивает вчерашнее с прошлогодним.
  const q = c.req.query()
  const now = new Date()
  const since = q.from ? new Date(q.from) : new Date(now.getFullYear(), now.getMonth(), 1)
  // «по 8 августа» включает весь день. Дата без времени разбирается как
  // полночь, и сегодняшние часы выпадали целиком: проект, где работали
  // только сегодня, показывал 0:00 при живых записях в базе. Заметно это
  // становится не сразу — вчерашние проекты считаются верно, и цифра
  // выглядит правдоподобной ровно до того дня, когда в проекте начали
  // работать.
  const until = q.to
    ? new Date(q.to.length <= 10 ? `${q.to}T23:59:59.999` : q.to)
    : now
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
    return c.json({ error: 'Invalid period' }, 400)
  }
  const period = { from: since.toISOString(), to: until.toISOString() }
  const inPeriod = sql`${timeEntries.startedAt} >= ${period.from}::timestamptz and ${timeEntries.startedAt} <= ${period.to}::timestamptz`

  const projectRows = await db.query.projects.findMany({ where: eq(projects.companyId, companyId) })
  const ids = projectRows.map((p) => p.id)
  if (!ids.length) {
    return c.json({ projects: [], totals: { projects: 0, people: 0, tasksTotal: 0, tasksDone: 0, hours: 0, messages: 0 }, weeks: [], topPeople: [] })
  }

  const [taskRows, memberRows, timeRows, msgRows, weekRows] = await Promise.all([
    db
      .select({
        projectId: tasks.projectId,
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) filter (where ${tasks.status} = 'done')::int`,
        overdue: sql<number>`count(*) filter (where ${tasks.status} <> 'done' and ${tasks.dueDate} < now())::int`,
      })
      .from(tasks)
      .where(and(inArray(tasks.projectId, ids), isNull(tasks.deletedAt)))
      .groupBy(tasks.projectId),

    db
      .select({ projectId: projectMembers.projectId, count: sql<number>`count(*)::int` })
      .from(projectMembers)
      .where(inArray(projectMembers.projectId, ids))
      .groupBy(projectMembers.projectId),

    db
      .select({
        projectId: timeEntries.projectId,
        minutes: sql<number>`coalesce(sum(extract(epoch from (${timeEntries.endedAt} - ${timeEntries.startedAt})) / 60), 0)::int`,
      })
      .from(timeEntries)
      .where(and(inArray(timeEntries.projectId, ids), sql`${timeEntries.endedAt} is not null`, inPeriod))
      .groupBy(timeEntries.projectId),

    db
      .select({ projectId: messages.projectId, count: sql<number>`count(*)::int` })
      .from(messages)
      .where(inArray(messages.projectId, ids))
      .groupBy(messages.projectId),

    // по неделям: ритм работы компании, который в списке проектов не увидеть
    db.execute(sql`
      select to_char(date_trunc('week', ${timeEntries.startedAt}), 'YYYY-MM-DD') as week,
             coalesce(sum(extract(epoch from (${timeEntries.endedAt} - ${timeEntries.startedAt})) / 60), 0)::int as minutes
      from ${timeEntries}
      where ${timeEntries.projectId} in ${ids}
        and ${timeEntries.endedAt} is not null
        and ${timeEntries.startedAt} >= ${period.from}::timestamptz
        and ${timeEntries.startedAt} <= ${period.to}::timestamptz
      group by date_trunc('week', ${timeEntries.startedAt})
      order by date_trunc('week', ${timeEntries.startedAt})
    `),
  ])

  // кто сколько отработал — верхушка, чтобы понять распределение нагрузки
  const topPeople = await db
    .select({
      userId: timeEntries.userId,
      name: users.name,
      avatarUrl: users.avatarUrl,
      minutes: sql<number>`coalesce(sum(extract(epoch from (${timeEntries.endedAt} - ${timeEntries.startedAt})) / 60), 0)::int`,
    })
    .from(timeEntries)
    .innerJoin(users, eq(users.id, timeEntries.userId))
    .where(
      and(
        inArray(timeEntries.projectId, ids),
        sql`${timeEntries.endedAt} is not null`,
        inPeriod,
      ),
    )
    .groupBy(timeEntries.userId, users.name, users.avatarUrl)
    .orderBy(sql`2 desc`)

  /**
   * Часы за всё время — рядом с часами за период.
   *
   * По одной цифре не понять, что она за месяц: проект, где работали до
   * первого числа, показывает 0:00 и читается как «часов нет вовсе». Две
   * величины рядом отвечают сразу на оба вопроса — сколько наработали сейчас
   * и сколько всего.
   */
  const totalTimeRows = await db
    .select({
      projectId: timeEntries.projectId,
      minutes: sql<number>`coalesce(sum(extract(epoch from (${timeEntries.endedAt} - ${timeEntries.startedAt})) / 60), 0)::int`,
    })
    .from(timeEntries)
    .where(and(inArray(timeEntries.projectId, ids), sql`${timeEntries.endedAt} is not null`))
    .groupBy(timeEntries.projectId)

  const byId = <T extends { projectId: string }>(rows: T[]) => new Map(rows.map((r) => [r.projectId, r]))
  const totalTimeMap = byId(totalTimeRows)
  const taskMap = byId(taskRows)
  const memberMap = byId(memberRows)
  const timeMap = byId(timeRows)
  const msgMap = byId(msgRows)

  // Где я сам состою — чтобы на обзоре было видно, куда я войду, а куда нет.
  // Одним запросом на весь список, а не по проекту в цикле.
  const myMemberships = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(and(inArray(projectMembers.projectId, ids), eq(projectMembers.userId, sub)))
  const mine = new Set(myMemberships.map((m) => m.projectId))

  // К кому идти за доступом. Поля «создатель» у проекта нет, и роль owner
  // на практике почти не проставлена — 10 проектов из 11 без неё. Поэтому
  // адресат это админы проекта: они есть везде и как раз решают, кого пускать.
  const leadRows = await db
    .select({ projectId: projectMembers.projectId, id: users.id, name: users.name, avatarUrl: users.avatarUrl, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(and(inArray(projectMembers.projectId, ids), inArray(projectMembers.role, ['owner', 'admin'])))
  const leadMap = new Map<string, { id: string; name: string; avatarUrl: string | null }[]>()
  for (const r of leadRows) {
    // Владелец вперёд: если он есть, спрашивать надо его.
    const list = leadMap.get(r.projectId) ?? []
    if (r.role === 'owner') list.unshift({ id: r.id, name: r.name, avatarUrl: r.avatarUrl })
    else list.push({ id: r.id, name: r.name, avatarUrl: r.avatarUrl })
    leadMap.set(r.projectId, list)
  }

  const list = projectRows.map((p) => {
    const t = taskMap.get(p.id)
    return {
      id: p.id,
      name: p.name,
      // Я в команде? Нет — содержимое проекта закрыто, и это видно заранее.
      isMember: mine.has(p.id),
      // Кого просить о доступе — показываем только тем, кто не в команде.
      leads: mine.has(p.id) ? [] : (leadMap.get(p.id) ?? []).slice(0, 3),
      color: p.color,
      logoUrl: p.logoUrl,
      tasksTotal: t?.total ?? 0,
      tasksDone: t?.done ?? 0,
      overdue: t?.overdue ?? 0,
      progress: t?.total ? Math.round(((t.done ?? 0) / t.total) * 100) : 0,
      members: memberMap.get(p.id)?.count ?? 0,
      minutes: timeMap.get(p.id)?.minutes ?? 0,
      totalMinutes: totalTimeMap.get(p.id)?.minutes ?? 0,
      messages: msgMap.get(p.id)?.count ?? 0,
    }
  })

  const companyPeople = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(companyMembers)
    .where(eq(companyMembers.companyId, companyId))

  return c.json({
    period,
    projects: list.sort((a, b) => b.minutes - a.minutes),
    totals: {
      projects: list.length,
      people: companyPeople[0]?.count ?? 0,
      tasksTotal: list.reduce((sum, p) => sum + p.tasksTotal, 0),
      tasksDone: list.reduce((sum, p) => sum + p.tasksDone, 0),
      overdue: list.reduce((sum, p) => sum + p.overdue, 0),
      minutes: list.reduce((sum, p) => sum + p.minutes, 0),
      messages: list.reduce((sum, p) => sum + p.messages, 0),
    },
    weeks: (weekRows as unknown as { week: string; minutes: number }[]).map((r) => ({
      week: String(r.week),
      minutes: Number(r.minutes),
    })),
    topPeople: topPeople.slice(0, 10),
  })
})

companiesRoute.get('/:companyId/members', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  if (!(await memberRoleIn(companyId, sub))) return c.json({ error: 'Forbidden' }, 403)

  const rows = await db
    .select({ id: companyMembers.id, role: companyMembers.role, user: users })
    .from(companyMembers)
    .innerJoin(users, eq(users.id, companyMembers.userId))
    .where(eq(companyMembers.companyId, companyId))

  return c.json(
    rows.map((r) => ({
      id: r.id,
      role: r.role,
      user: { id: r.user.id, name: r.user.name, email: r.user.email, avatarUrl: r.user.avatarUrl },
    })),
  )
})

// --- BYO-LLM (только admin компании) -----------------------------------------
// Ключ шифруется (AES-256-GCM) и НИКОГДА не отдаётся обратно — только статус + last4.

companiesRoute.get('/:companyId/llm', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  const role = await memberRoleIn(companyId, sub)
  if (!role) return c.json({ error: 'Forbidden' }, 403)

  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) })
  return c.json({
    configured: Boolean(company?.llmProvider && company.llmKeyEncrypted),
    provider: company?.llmProvider ?? null,
    model: company?.llmModel ?? null,
    vision: Boolean(company?.llmVision),
    providers: Object.entries(LLM_PROVIDERS).map(([id, p]) => ({ id, label: p.label, defaultModel: p.defaultModel })),
  })
})

/**
 * Настройки компании: имя и язык (SPEC §8.39).
 *
 * Язык нужен не для интерфейса — его каждый выбирает себе сам, — а для писем
 * тем, у кого своих настроек ещё нет: приглашённому и заведённому через API.
 */
companiesRoute.patch(
  '/:companyId',
  zValidator(
    'json',
    z.object({
      name: z.string().min(1).max(120).optional(),
      locale: z.enum(['en', 'ru', 'he']).optional(),
    }),
  ),
  async (c) => {
    const { sub } = c.get('session')
    const companyId = c.req.param('companyId')
    // Настройки компании меняет только админ: язык влияет на письма всем.
    if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

    const { name, locale } = c.req.valid('json')
    const patch: Record<string, unknown> = {}
    if (name !== undefined) patch.name = name.trim()
    if (locale !== undefined) patch.locale = locale
    if (!Object.keys(patch).length) return c.json({ error: 'Nothing to change. Supported: name, locale.' }, 400)

    const [updated] = await db.update(companies).set(patch).where(eq(companies.id, companyId)).returning()
    if (!updated) return c.json({ error: 'Not found' }, 404)
    return c.json({ id: updated.id, name: updated.name, locale: updated.locale })
  },
)

/**
 * Настройки учёта времени компании (SPEC §8.36).
 *
 * Читают их все, кто состоит в компании: часовой пояс и первый день недели
 * нужны любому, кто открывает отчёт по часам, — иначе «эта неделя» у него
 * начнётся не там. Меняет только админ: пояс сдвигает суммы во всех проектах
 * разом.
 */
companiesRoute.get('/:companyId/time-config', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  if (!(await memberRoleIn(companyId, sub))) return c.json({ error: 'Forbidden' }, 403)

  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) })
  if (!company) return c.json({ error: 'Not found' }, 404)
  return c.json({ config: readTimeConfig(company.timeConfig), canEdit: (await memberRoleIn(companyId, sub)) === 'admin' })
})

companiesRoute.patch(
  '/:companyId/time-config',
  zValidator('json', timeConfigSchema.partial()),
  async (c) => {
    const { sub } = c.get('session')
    const companyId = c.req.param('companyId')
    if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

    const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) })
    if (!company) return c.json({ error: 'Not found' }, 404)

    const b = c.req.valid('json')
    if (!Object.keys(b).length) return c.json({ error: 'Nothing to change.' }, 400)
    // Конец раньше начала — сутки наизнанку. Ловим здесь, а не только при
    // чтении: молча подменённое значение человек обнаружит, лишь перезагрузив
    // страницу, и решит, что настройка не сохраняется.
    const merged = { ...readTimeConfig(company.timeConfig), ...b }
    if (merged.workDayEnd <= merged.workDayStart) {
      return c.json({ error: 'workDayEnd must be later than workDayStart' }, 400)
    }

    await db.update(companies).set({ timeConfig: JSON.stringify(merged) }).where(eq(companies.id, companyId))
    return c.json({ config: merged })
  },
)

// --- логотип компании ---------------------------------------------------------
//
// Показывается в шапке вместо нашего, поэтому загрузка нужна прямо здесь:
// просить «разместите картинку где-нибудь и пришлите ссылку» — не решение.

companiesRoute.post('/:companyId/logo', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

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
    const key = `${S3_KEY_PREFIX}/company-logos/${companyId}-${nanoid(6)}.webp`
    await s3Client().send(new PutObjectCommand({ Bucket: s3Bucket(), Key: key, Body: buffer, ContentType: 'image/webp' }))
    // Версия в адресе: без неё браузер отдаёт старый логотип после замены.
    const url = `${process.env.API_PUBLIC_URL || 'https://api.chatick.com'}/api/v1/companies/${companyId}/logo?v=${Date.now()}`
    await db.update(companies).set({ logoUrl: url, logoKey: key }).where(eq(companies.id, companyId))
    return c.json({ logoUrl: url })
  } catch (e) {
    console.error('[company logo] upload failed:', e)
    return c.json({ error: 'Failed to process image' }, 500)
  }
})

companiesRoute.delete('/:companyId/logo', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) })
  if (company?.logoKey) {
    // Файл из хранилища тоже убираем: иначе он копится и оплачивается впустую.
    await deleteObject({ client: s3Client(), bucket: s3Bucket(), keyPrefix: S3_KEY_PREFIX, isCustom: false, publicUrl: null }, company.logoKey).catch(() => {})
  }
  await db.update(companies).set({ logoUrl: null, logoKey: null }).where(eq(companies.id, companyId))
  return c.json({ ok: true })
})

// --- ключи API компании (SPEC-INTEGRATION §2) --------------------------------
//
// Ключ позволяет заводить людей и проекты без чьего-либо подтверждения — то
// есть это ключ от всей компании. Поэтому только админ, и каждое действие
// оставляет след.

companiesRoute.get('/:companyId/api-keys', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)
  return c.json({ items: await listKeys(companyId) })
})

companiesRoute.post(
  '/:companyId/api-keys',
  zValidator(
    'json',
    z.object({
      name: z.string().min(1).max(120),
      scopes: z.array(z.enum(['users:write', 'projects:write', 'read:all'])).min(1),
      allowedIps: z.array(z.string().max(64)).max(20).optional(),
    }),
  ),
  async (c) => {
    const { sub } = c.get('session')
    const companyId = c.req.param('companyId')
    if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

    const { name, scopes, allowedIps } = c.req.valid('json')
    const issued = await issueKey({ companyId, name, scopes, allowedIps, createdById: sub })

    // Единственный раз, когда ключ вообще существует снаружи хранилища:
    // дальше в базе только его хеш, и показать его снова невозможно.
    return c.json({ id: issued.id, key: issued.key, prefix: issued.prefix }, 201)
  },
)

companiesRoute.delete('/:companyId/api-keys/:keyId', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  const ok = await revokeKey(companyId, c.req.param('keyId'))
  if (!ok) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

// --- вебхуки (SPEC-INTEGRATION §7) --------------------------------------------

companiesRoute.get('/:companyId/webhooks', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  const rows = await db.query.companyWebhooks.findMany({ where: eq(companyWebhooks.companyId, companyId) })
  return c.json({
    // Секрет не отдаём: он показывается один раз при создании, как ключ API.
    items: rows.map((w) => ({
      id: w.id,
      url: w.url,
      events: JSON.parse(w.events || '[]') as string[],
      active: w.active,
      lastOkAt: w.lastOkAt,
      lastFailAt: w.lastFailAt,
      lastError: w.lastError,
    })),
  })
})

companiesRoute.post(
  '/:companyId/webhooks',
  zValidator(
    'json',
    z.object({
      url: z.string().url().max(500),
      events: z.array(z.string().max(60)).max(20).optional(),
    }),
  ),
  async (c) => {
    const { sub } = c.get('session')
    const companyId = c.req.param('companyId')
    if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

    const { url, events } = c.req.valid('json')
    if (!/^https:\/\//i.test(url)) {
      // Только https: по http подпись и содержимое читает любой посредник.
      return c.json({ error: 'Webhook URL must use https' }, 400)
    }

    const secret = newSecret()
    const [row] = await db
      .insert(companyWebhooks)
      .values({ companyId, url, secret, events: JSON.stringify(events ?? []) })
      .returning()

    // Секрет — единственный раз: дальше его негде взять, как и ключ API.
    return c.json({ id: row!.id, url: row!.url, secret }, 201)
  },
)

companiesRoute.delete('/:companyId/webhooks/:webhookId', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  await db
    .delete(companyWebhooks)
    .where(and(eq(companyWebhooks.id, c.req.param('webhookId')), eq(companyWebhooks.companyId, companyId)))
  return c.json({ ok: true })
})

// --- Своя почта компании (SPEC §8.41) ---
//
// Письма сотрудникам уходят с домена компании, а не с нашего: письмо «от
// Chatick» про их внутренние задачи выглядит как фишинг и хуже проходит
// спам-фильтры, потому что SPF/DKIM нашего домена к их адресу не относятся.
//
// Пароль SMTP и ключ SendGrid наружу не отдаются НИКОГДА — ни админу, ни в
// API. Клиенту видно только, задан секрет или нет.

/** Текущие настройки почты. Секреты заменены признаком «задано». */
companiesRoute.get('/:companyId/mail', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  const row = await db.query.companies.findFirst({
    where: eq(companies.id, companyId),
    columns: {
      mailProvider: true,
      mailFromEmail: true,
      mailFromName: true,
      mailReplyTo: true,
      mailHost: true,
      mailPort: true,
      mailUser: true,
      mailPasswordEnc: true,
      mailApiKeyEnc: true,
      mailVerifiedAt: true,
    },
  })
  if (!row) return c.json({ error: 'Not found' }, 404)

  const { mailPasswordEnc, mailApiKeyEnc, ...rest } = row
  return c.json({
    ...rest,
    // Не сам секрет, а факт его наличия: иначе «показать пароль» в чужой
    // вкладке — это выданный доступ к почте компании.
    hasPassword: !!mailPasswordEnc,
    hasApiKey: !!mailApiKeyEnc,
  })
})

/** Сохранить настройки почты. Пустая строка секрета — «оставить прежний». */
companiesRoute.patch(
  '/:companyId/mail',
  zValidator(
    'json',
    z.object({
      provider: z.enum(['smtp', 'sendgrid']).nullable(),
      fromEmail: z.string().max(200).optional(),
      fromName: z.string().max(120).optional(),
      replyTo: z.string().max(200).optional(),
      host: z.string().max(200).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      user: z.string().max(200).optional(),
      password: z.string().max(500).optional(),
      apiKey: z.string().max(500).optional(),
    }),
  ),
  async (c) => {
    const { sub } = c.get('session')
    const companyId = c.req.param('companyId')
    if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

    const b = c.req.valid('json')

    // Отключение — стираем всё, включая секреты: «выключил и забыл» не должно
    // оставлять в базе рабочий пароль от чужой почты.
    if (!b.provider) {
      await db
        .update(companies)
        .set({
          mailProvider: null,
          mailFromEmail: null,
          mailFromName: null,
          mailReplyTo: null,
          mailHost: null,
          mailPort: null,
          mailUser: null,
          mailPasswordEnc: null,
          mailApiKeyEnc: null,
          mailVerifiedAt: null,
        })
        .where(eq(companies.id, companyId))
      dropTransport(companyId)
      return c.json({ ok: true, provider: null })
    }

    const from = (b.fromEmail ?? '').trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) return c.json({ error: 'Valid sender email required' }, 400)
    const replyTo = (b.replyTo ?? '').trim().toLowerCase()
    if (replyTo && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(replyTo)) {
      return c.json({ error: 'Reply-to must be a valid email' }, 400)
    }

    const patch: Record<string, unknown> = {
      mailProvider: b.provider,
      mailFromEmail: from,
      mailFromName: (b.fromName ?? '').trim() || null,
      mailReplyTo: replyTo || null,
      // Настройки изменились — прежняя проверка о них ничего не говорит.
      mailVerifiedAt: null,
    }

    if (b.provider === 'smtp') {
      const host = (b.host ?? '').trim()
      if (!host) return c.json({ error: 'SMTP host required' }, 400)
      patch.mailHost = host
      patch.mailPort = b.port ?? 587
      patch.mailUser = (b.user ?? '').trim() || null
      // Пусто — значит «не меняли»: иначе форма, открытая ради смены порта,
      // затирала бы пароль, которого она не показывает.
      if (b.password) patch.mailPasswordEnc = encrypt(b.password)
      patch.mailApiKeyEnc = null
    } else {
      if (b.apiKey) patch.mailApiKeyEnc = encrypt(b.apiKey)
      patch.mailHost = null
      patch.mailPort = null
      patch.mailUser = null
      patch.mailPasswordEnc = null
    }

    await db.update(companies).set(patch).where(eq(companies.id, companyId))
    dropTransport(companyId)

    // Секрет обязателен, но проверяем ПОСЛЕ сохранения остального: иначе
    // человек теряет введённые host/port из-за забытого пароля.
    const saved = await companyMail(companyId)
    if (!saved) return c.json({ error: 'Secret required: enter the password or API key' }, 400)

    return c.json({ ok: true, provider: b.provider })
  },
)

/**
 * Проверка живой отправкой — на почту самого админа.
 *
 * Без неё опечатку в пароле обнаруживают сотрудники, у которых молча
 * перестали приходить письма.
 */
companiesRoute.post('/:companyId/mail/test', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  const m = await companyMail(companyId)
  if (!m) return c.json({ error: 'Mail is not configured' }, 400)

  const me = await db.query.users.findFirst({ where: eq(users.id, sub), columns: { email: true } })
  if (!me?.email) return c.json({ error: 'No email to send to' }, 400)

  try {
    await sendVia(
      m,
      {
        to: me.email,
        subject: 'Chatick: mail settings work',
        text: 'This is a test message. Your company mail settings are working.',
        html: '<p>This is a test message. Your company mail settings are working.</p>',
      },
      companyId,
    )
  } catch (err) {
    // Причину показываем целиком: «не отправилось» не чинится, а «535
    // authentication failed» — чинится сразу.
    dropTransport(companyId)
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }

  await db.update(companies).set({ mailVerifiedAt: new Date() }).where(eq(companies.id, companyId))
  return c.json({ ok: true, sentTo: me.email })
})

// --- Своё хранилище компании (SPEC §8.47) ---
//
// Настройка была только на проекте: компания с десятком проектов вводила одни
// и те же ключи R2 десять раз, а при смене — снова десять. Проекты наследуют
// эту настройку, если у них нет своей.
//
// Ключи шифруются и наружу не отдаются: клиенту видно лишь, заданы ли они.

companiesRoute.get('/:companyId/storage', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  const s = await db.query.companyStorage.findFirst({ where: eq(companyStorage.companyId, companyId) })
  return c.json({
    provider: s?.provider ?? 'platform',
    endpoint: s?.endpoint ?? '',
    region: s?.region ?? 'auto',
    bucket: s?.bucket ?? '',
    publicUrl: s?.publicUrl ?? '',
    hasKeys: Boolean(s?.accessKeyEncrypted && s?.secretKeyEncrypted),
  })
})

const companyStorageSchema = z.object({
  provider: z.enum(['platform', 'custom']),
  endpoint: z.string().max(500).optional(),
  region: z.string().max(100).optional(),
  bucket: z.string().max(200).optional(),
  publicUrl: z.string().max(500).optional(),
  accessKey: z.string().max(500).optional(), // только при смене
  secretKey: z.string().max(1000).optional(),
})

companiesRoute.put('/:companyId/storage', zValidator('json', companyStorageSchema), async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  const b = c.req.valid('json')
  const existing = await db.query.companyStorage.findFirst({ where: eq(companyStorage.companyId, companyId) })

  if (b.provider === 'platform') {
    if (existing) await db.update(companyStorage).set({ provider: 'platform' }).where(eq(companyStorage.companyId, companyId))
    else await db.insert(companyStorage).values({ companyId, provider: 'platform' })
    return c.json({ ok: true, provider: 'platform' })
  }

  if (!b.endpoint || !b.bucket) return c.json({ error: 'endpoint and bucket are required' }, 400)
  const accessKey = b.accessKey || null
  const secretKey = b.secretKey || null
  const hasExistingKeys = Boolean(existing?.accessKeyEncrypted && existing?.secretKeyEncrypted)
  if (!hasExistingKeys && (!accessKey || !secretKey)) {
    return c.json({ error: 'access key and secret key are required' }, 400)
  }

  // Пробная запись и удаление: без неё опечатку в ключе обнаружит первый, кто
  // попробует загрузить файл, — и это будет выглядеть как поломка Chatick.
  if (accessKey && secretKey) {
    try {
      const client = new S3Client({
        region: b.region || 'auto',
        endpoint: b.endpoint,
        credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      })
      const testKey = `chatick-connection-test/${companyId}.txt`
      await client.send(new PutObjectCommand({ Bucket: b.bucket, Key: testKey, Body: 'ok' }))
      await client.send(new DeleteObjectCommand({ Bucket: b.bucket, Key: testKey }))
    } catch (err) {
      return c.json({ error: `Connection test failed: ${err instanceof Error ? err.message : String(err)}` }, 400)
    }
  }

  const values = {
    provider: 'custom' as const,
    endpoint: b.endpoint,
    region: b.region || 'auto',
    bucket: b.bucket,
    publicUrl: b.publicUrl || null,
    ...(accessKey ? { accessKeyEncrypted: encrypt(accessKey) } : {}),
    ...(secretKey ? { secretKeyEncrypted: encrypt(secretKey) } : {}),
    updatedAt: new Date(),
  }
  if (existing) await db.update(companyStorage).set(values).where(eq(companyStorage.companyId, companyId))
  else await db.insert(companyStorage).values({ companyId, ...values })

  return c.json({ ok: true, provider: 'custom' })
})

/**
 * Автобэкап: включить, выключить, посмотреть состояние (SPEC §8.48).
 *
 * Состояние показываем всегда: молча сломавшийся бэкап хуже отсутствующего —
 * на него рассчитывают, а его нет.
 */
companiesRoute.patch(
  '/:companyId/auto-backup',
  zValidator('json', z.object({ enabled: z.boolean() })),
  async (c) => {
    const { sub } = c.get('session')
    const companyId = c.req.param('companyId')
    if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

    const b = c.req.valid('json')


    const enabled = b.enabled
    if (enabled && !(await companyStorageFor(companyId, 'backup'))) {
      return c.json(
        {
          error: 'Connect your own S3/R2 storage first',
          hint: 'A backup kept on our own infrastructure would die together with the original — that is the whole point of it.',
        },
        400,
      )
    }

    await db
      .update(companies)
      .set({ autoBackup: enabled, lastBackupError: null, backupErrorNotifiedAt: null })
      .where(eq(companies.id, companyId))
    return c.json({ ok: true, enabled })
  },
)

companiesRoute.get('/:companyId/auto-backup', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  const row = await db.query.companies.findFirst({
    where: eq(companies.id, companyId),
    columns: { autoBackup: true, lastBackupAt: true, lastBackupError: true },
  })
  return c.json({
    enabled: Boolean(row?.autoBackup),
    lastBackupAt: row?.lastBackupAt ?? null,
    lastError: row?.lastBackupError ?? null,
    storageReady: Boolean(await companyStorageFor(companyId, 'backup')),
  })
})

// --- Хранилище для бэкапов (SPEC §8.48) ---
//
// Отдельное от файлового, со своими ключами: копию имеет смысл держать в другом
// аккаунте, а лучше у другого провайдера. Лежащая в том же аккаунте, она
// недоступна ровно тогда, когда нужна — при его блокировке или потере ключей.
//
// Не настроено — бэкап пишется в файловое хранилище компании.

companiesRoute.get('/:companyId/backup-storage', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  const s = await db.query.companyBackupStorage.findFirst({ where: eq(companyBackupStorage.companyId, companyId) })
  return c.json({
    separate: Boolean(s?.endpoint && s?.bucket),
    endpoint: s?.endpoint ?? '',
    region: s?.region ?? 'auto',
    bucket: s?.bucket ?? '',
    hasKeys: Boolean(s?.accessKeyEncrypted && s?.secretKeyEncrypted),
  })
})

companiesRoute.put(
  '/:companyId/backup-storage',
  zValidator(
    'json',
    z.object({
      separate: z.boolean(),
      endpoint: z.string().max(500).optional(),
      region: z.string().max(100).optional(),
      bucket: z.string().max(200).optional(),
      accessKey: z.string().max(500).optional(),
      secretKey: z.string().max(1000).optional(),
    }),
  ),
  async (c) => {
    const { sub } = c.get('session')
    const companyId = c.req.param('companyId')
    if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

    const b = c.req.valid('json')
    const existing = await db.query.companyBackupStorage.findFirst({
      where: eq(companyBackupStorage.companyId, companyId),
    })

    // Отказ от отдельного хранилища стирает и ключи: «выключил и забыл» не
    // должно оставлять в базе рабочий доступ к чужому бакету.
    if (!b.separate) {
      if (existing) await db.delete(companyBackupStorage).where(eq(companyBackupStorage.companyId, companyId))
      return c.json({ ok: true, separate: false })
    }

    if (!b.endpoint || !b.bucket) return c.json({ error: 'endpoint and bucket are required' }, 400)
    const accessKey = b.accessKey || null
    const secretKey = b.secretKey || null
    const hasExistingKeys = Boolean(existing?.accessKeyEncrypted && existing?.secretKeyEncrypted)
    if (!hasExistingKeys && (!accessKey || !secretKey)) {
      return c.json({ error: 'access key and secret key are required' }, 400)
    }

    // Пробная запись и удаление: иначе опечатку в ключе обнаружит планировщик
    // ночью, а человек — из письма о несостоявшемся бэкапе.
    if (accessKey && secretKey) {
      try {
        const client = new S3Client({
          region: b.region || 'auto',
          endpoint: b.endpoint,
          credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
        })
        const testKey = `chatick-connection-test/${companyId}.txt`
        await client.send(new PutObjectCommand({ Bucket: b.bucket, Key: testKey, Body: 'ok' }))
        await client.send(new DeleteObjectCommand({ Bucket: b.bucket, Key: testKey }))
      } catch (err) {
        return c.json({ error: `Connection test failed: ${err instanceof Error ? err.message : String(err)}` }, 400)
      }
    }

    const values = {
      endpoint: b.endpoint,
      region: b.region || 'auto',
      bucket: b.bucket,
      ...(accessKey ? { accessKeyEncrypted: encrypt(accessKey) } : {}),
      ...(secretKey ? { secretKeyEncrypted: encrypt(secretKey) } : {}),
      updatedAt: new Date(),
    }
    if (existing) await db.update(companyBackupStorage).set(values).where(eq(companyBackupStorage.companyId, companyId))
    else await db.insert(companyBackupStorage).values({ companyId, ...values })

    return c.json({ ok: true, separate: true })
  },
)

/** Настройки внешней системы: название и шаблон ссылки «туда». */
companiesRoute.patch(
  '/:companyId/integration',
  zValidator(
    'json',
    z.object({
      externalSystemName: z.string().max(120).nullable().optional(),
      externalProjectUrl: z.string().max(500).nullable().optional(),
      projectsViaApiOnly: z.boolean().optional(),
      membersViaApiOnly: z.boolean().optional(),
    }),
  ),
  async (c) => {
    const { sub } = c.get('session')
    const companyId = c.req.param('companyId')
    if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

    const b = c.req.valid('json')
    const patch: Record<string, unknown> = {}
    if (b.externalSystemName !== undefined) patch.externalSystemName = b.externalSystemName?.trim() || null
    if (b.externalProjectUrl !== undefined) {
      const url = b.externalProjectUrl?.trim() || null
      // Без {externalId} ссылка вела бы всех в одно место — это не переход к
      // проекту, а ошибка настройки, которую лучше поймать здесь.
      if (url && !url.includes('{externalId}')) {
        return c.json({ error: 'URL template must contain {externalId}' }, 400)
      }
      if (url && !/^https?:\/\//i.test(url)) {
        return c.json({ error: 'URL must start with http:// or https://' }, 400)
      }
      patch.externalProjectUrl = url
    }
    if (b.projectsViaApiOnly !== undefined) patch.projectsViaApiOnly = b.projectsViaApiOnly
    if (b.membersViaApiOnly !== undefined) patch.membersViaApiOnly = b.membersViaApiOnly
    if (!Object.keys(patch).length) return c.json({ error: 'Nothing to change' }, 400)

    const [updated] = await db.update(companies).set(patch).where(eq(companies.id, companyId)).returning()
    return c.json({
      externalSystemName: updated!.externalSystemName,
      externalProjectUrl: updated!.externalProjectUrl,
      projectsViaApiOnly: updated!.projectsViaApiOnly,
      membersViaApiOnly: updated!.membersViaApiOnly,
    })
  },
)

companiesRoute.put(
  '/:companyId/llm',
  zValidator(
    'json',
    z.object({
      provider: z.enum(Object.keys(LLM_PROVIDERS) as [LlmProvider, ...LlmProvider[]]),
      model: z.string().min(1).max(120).optional(),
      apiKey: z.string().min(8).max(512),
      /** Разрешить модели смотреть картинки. Выключено, пока не включат. */
      vision: z.boolean().optional(),
    }),
  ),
  async (c) => {
    const { sub } = c.get('session')
    const companyId = c.req.param('companyId')
    if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

    const { provider, model, apiKey, vision } = c.req.valid('json')
    const resolvedModel = model || LLM_PROVIDERS[provider].defaultModel

    // проверяем ключ живым запросом до сохранения
    const ok = await testLlm({ provider, model: resolvedModel, apiKey })
    if (!ok) return c.json({ error: 'LLM check failed — verify the key and model' }, 422)

    await db
      .update(companies)
      .set({ llmProvider: provider, llmModel: resolvedModel, llmKeyEncrypted: encrypt(apiKey), llmVision: vision === true })
      .where(eq(companies.id, companyId))
    return c.json({ ok: true, provider, model: resolvedModel })
  },
)

/**
 * Распознавание изображений — отдельной ручкой.
 *
 * Не через общее сохранение настроек ИИ: оно требует ввести ключ заново и
 * проверяет его живым запросом. Ключ уже сохранён и повторно не показывается,
 * поэтому переключить одну галочку было нечем — кнопка оставалась серой.
 *
 * Здесь ключ не нужен: мы не трогаем ни модель, ни доступ, а только
 * разрешение отправлять картинки.
 */
companiesRoute.patch(
  '/:companyId/llm/vision',
  zValidator('json', z.object({ vision: z.boolean() })),
  async (c) => {
    const { sub } = c.get('session')
    const companyId = c.req.param('companyId')
    if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)
    const { vision } = c.req.valid('json')
    await db.update(companies).set({ llmVision: vision }).where(eq(companies.id, companyId))
    return c.json({ ok: true, vision })
  },
)

companiesRoute.delete('/:companyId/llm', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  await db
    .update(companies)
    .set({ llmProvider: null, llmModel: null, llmKeyEncrypted: null })
    .where(eq(companies.id, companyId))
  return c.json({ ok: true })
})

// Сменить роль участника (только admin; себя-единственного-админа не понизить)
companiesRoute.patch(
  '/:companyId/members/:userId',
  zValidator('json', z.object({ role: z.enum(['admin', 'manager', 'member']) })),
  async (c) => {
    const { sub } = c.get('session')
    const { companyId, userId } = c.req.param()
    if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

    const { role } = c.req.valid('json')
    if (userId === sub && role !== 'admin') {
      const admins = await db.query.companyMembers.findMany({
        where: and(eq(companyMembers.companyId, companyId), eq(companyMembers.role, 'admin')),
      })
      if (admins.length <= 1) return c.json({ error: 'Cannot demote the only admin' }, 400)
    }

    await db
      .update(companyMembers)
      .set({ role })
      .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId)))
    return c.json({ ok: true })
  },
)

// Удалить участника из компании (admin; себя-единственного-админа нельзя)
companiesRoute.delete('/:companyId/members/:userId', async (c) => {
  const { sub } = c.get('session')
  const { companyId, userId } = c.req.param()
  if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  // Состав команды ведётся во внешней системе (SPEC §8.42).
  if (await membersLockedForCompany(companyId)) return c.json(MEMBERS_LOCKED, 403)

  if (userId === sub) {
    const admins = await db.query.companyMembers.findMany({
      where: and(eq(companyMembers.companyId, companyId), eq(companyMembers.role, 'admin')),
    })
    if (admins.length <= 1) return c.json({ error: 'Cannot remove the only admin' }, 400)
  }

  await db
    .delete(companyMembers)
    .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId)))
  return c.json({ ok: true })
})

/**
 * Удаление компании (SPEC §3.1).
 *
 * Уносит все её проекты со всем содержимым — это самое разрушительное
 * действие в продукте. Поэтому: только админ, подтверждение вводом названия
 * (проверяется на сервере, клиент можно обойти) и зачистка файлов из
 * хранилища, которую каскад базы не сделает.
 *
 * Ассистенту через мост недоступно намеренно.
 */
companiesRoute.delete('/:companyId', async (c) => {
  const { sub } = c.get('session')
  const { companyId } = c.req.param()

  if ((await memberRoleIn(companyId, sub)) !== 'admin') {
    return c.json({ error: 'Only a company admin can delete the company' }, 403)
  }

  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) })
  if (!company) return c.json({ error: 'Not found' }, 404)

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  if (typeof body.confirm !== 'string' || body.confirm.trim() !== company.name) {
    return c.json({ error: 'Confirmation does not match the company name', expected: company.name }, 400)
  }

  // Участников собираем ДО удаления: после каскада писать будет некому.
  const recipients = await db
    .select({ email: users.email, locale: users.locale })
    .from(companyMembers)
    .innerJoin(users, eq(users.id, companyMembers.userId))
    .where(and(eq(companyMembers.companyId, companyId), sql`${companyMembers.userId} <> ${sub}`))
  const actor = await db.query.users.findFirst({ where: eq(users.id, sub) })

  // Файлы сначала: упадём на них — компания ещё цела и можно повторить.
  // Наоборот остались бы объекты, к которым уже никто не знает пути.
  const projectIds = (await db.select({ id: projects.id }).from(projects).where(eq(projects.companyId, companyId))).map(
    (p) => p.id,
  )
  let deletedFiles = 0
  for (const projectId of projectIds) {
    const rows = await db
      .select({ key: files.key, originalKey: files.originalKey })
      .from(files)
      .where(eq(files.projectId, projectId))
    if (!rows.length) continue
    try {
      const store = await resolveStorage(projectId)
      for (const r of rows) {
        for (const key of [r.key, r.originalKey].filter(Boolean) as string[]) {
          await deleteObject(store, key).catch(() => {
            // один непослушный объект не должен блокировать удаление
          })
        }
      }
      deletedFiles += rows.length
    } catch (err) {
      console.error('[companies] storage cleanup failed:', err)
    }
  }

  await db.delete(companies).where(eq(companies.id, companyId))

  // Письма в фоне: ответ не должен ждать почтовый сервер.
  for (const r of recipients) {
    void sendDeletedMail({
      to: r.email,
      locale: r.locale,
      kind: 'company',
      name: company.name,
      actorName: actor?.name || actor?.email || '—',
    })
  }

  return c.json({ ok: true, deletedProjects: projectIds.length, deletedFiles, notified: recipients.length })
})

/**
 * Выйти из компании самому (SPEC §3.1).
 *
 * Отдельно от удаления участника админом: уйти из чужого пространства человек
 * вправе без чьего-либо разрешения. Единственный админ уйти не может — иначе
 * компания осталась бы без хозяина, а вместе с ней и все её проекты.
 */
companiesRoute.post('/:companyId/leave', async (c) => {
  const { sub } = c.get('session')
  const { companyId } = c.req.param()

  const role = await memberRoleIn(companyId, sub)
  if (!role) return c.json({ error: 'Not a member' }, 404)

  if (role === 'admin') {
    const admins = await db.query.companyMembers.findMany({
      where: and(eq(companyMembers.companyId, companyId), eq(companyMembers.role, 'admin')),
    })
    if (admins.length <= 1) {
      return c.json(
        { error: 'You are the only admin', hint: 'Make someone else an admin first, or delete the company.' },
        400,
      )
    }
  }

  // Из проектов компании тоже выходим: доступ к ним держался на членстве.
  const projectIds = (await db.select({ id: projects.id }).from(projects).where(eq(projects.companyId, companyId))).map(
    (p) => p.id,
  )
  if (projectIds.length) {
    await db
      .delete(projectMembers)
      .where(and(inArray(projectMembers.projectId, projectIds), eq(projectMembers.userId, sub)))
  }

  await db.delete(companyMembers).where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, sub)))
  return c.json({ ok: true })
})

// Пригласить в компанию (email + роль) — с подтверждением (SPEC §3.1)
companiesRoute.post(
  '/:companyId/invites',
  zValidator(
    'json',
    z.object({
      email: z.string().email().toLowerCase(),
      role: z.enum(['admin', 'manager', 'member']).default('member'),
      // Необязательный: приглашая в компанию, можно сразу позвать в проект
      projectId: z.string().optional(),
    }),
  ),
  async (c) => {
    const { sub } = c.get('session')
    const companyId = c.req.param('companyId')
    const myRole = await memberRoleIn(companyId, sub)
    if (!canManageInvites(myRole)) return c.json({ error: 'Forbidden' }, 403)

    const { email, role, projectId } = c.req.valid('json')

    // Проект принимаем только из этой же компании: иначе приглашение стало бы
    // способом раздать доступ куда угодно.
    let inviteProjectId: string | null = null
    if (projectId) {
      const p = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
      if (p?.companyId === companyId) inviteProjectId = p.id
    }

// Состав команды ведётся во внешней системе (SPEC §8.42).
    if (await membersLockedForCompany(companyId)) return c.json(MEMBERS_LOCKED, 403)

    const existing = await db.query.companyInvites.findFirst({
      where: and(eq(companyInvites.companyId, companyId), eq(companyInvites.email, email), eq(companyInvites.status, 'pending')),
    })
    if (existing) return c.json({ error: 'Invite already pending' }, 409)

    const token = nanoid(32)
    const [invite] = await db
      .insert(companyInvites)
      .values({ companyId, email, role, token, invitedById: sub, projectId: inviteProjectId })
      .returning()

    const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) })
    // Язык компании, а не приглашающего: русский админ израильской фирмы
    // приглашал израильтянина, и письмо уходило по-русски. Своих настроек у
    // приглашённого ещё нет — он в системе не существует.
    await sendInviteMail({
      to: email,
      companyId,
      companyName: company?.name ?? '',
      role,
      token,
      inviterLocale: inviteProjectId ? await projectLocale(inviteProjectId) : company?.locale,
    })

    return c.json(invite, 201)
  },
)

// Список инвайтов компании
companiesRoute.get('/:companyId/invites', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  if (!canManageInvites(await memberRoleIn(companyId, sub))) return c.json({ error: 'Forbidden' }, 403)
  const invites = await db.query.companyInvites.findMany({
    where: and(eq(companyInvites.companyId, companyId), eq(companyInvites.status, 'pending')),
  })
  return c.json(invites)
})

// Переслать инвайт (повторное письмо)
companiesRoute.post('/:companyId/invites/:inviteId/resend', async (c) => {
  const { sub } = c.get('session')
  const { companyId, inviteId } = c.req.param()
  if (!canManageInvites(await memberRoleIn(companyId, sub))) return c.json({ error: 'Forbidden' }, 403)

  const invite = await db.query.companyInvites.findFirst({
    where: and(eq(companyInvites.id, inviteId), eq(companyInvites.companyId, companyId), eq(companyInvites.status, 'pending')),
  })
  if (!invite) return c.json({ error: 'Not found' }, 404)

  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) })
  const inviter = await db.query.users.findFirst({ where: eq(users.id, sub) })
  await sendInviteMail({
    to: invite.email,
    companyName: company?.name ?? '',
    role: invite.role,
    token: invite.token,
    inviterLocale: inviter?.locale,
  })
  return c.json({ ok: true })
})

// Отозвать инвайт
companiesRoute.delete('/:companyId/invites/:inviteId', async (c) => {
  const { sub } = c.get('session')
  const { companyId, inviteId } = c.req.param()
  if (!canManageInvites(await memberRoleIn(companyId, sub))) return c.json({ error: 'Forbidden' }, 403)

  await db
    .update(companyInvites)
    .set({ status: 'revoked' })
    .where(and(eq(companyInvites.id, inviteId), eq(companyInvites.companyId, companyId)))
  return c.json({ ok: true })
})

// Принять инвайт (по токену) — подтверждение приглашённым
companiesRoute.post('/invites/:token/accept', async (c) => {
  const { sub, email } = c.get('session')
  const token = c.req.param('token')

  const invite = await db.query.companyInvites.findFirst({
    where: and(eq(companyInvites.token, token), eq(companyInvites.status, 'pending')),
  })
  if (!invite) return c.json({ error: 'Invite not found or expired' }, 404)
  if (invite.email !== email) return c.json({ error: 'Invite was sent to a different email' }, 403)

  const already = await db.query.companyMembers.findFirst({
    where: and(eq(companyMembers.companyId, invite.companyId), eq(companyMembers.userId, sub)),
  })
  if (!already) {
    await db.insert(companyMembers).values({ companyId: invite.companyId, userId: sub, role: invite.role })
  }
  await db.update(companyInvites).set({ status: 'accepted' }).where(eq(companyInvites.id, invite.id))

  // Звали сразу в проект — исполняем обещание теперь, когда человек появился.
  // Молча пропускаем, если проект успели удалить: приглашение в компанию от
  // этого не должно ломаться.
  if (invite.projectId) {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, invite.projectId) })
    if (project?.companyId === invite.companyId) {
      const inProject = await db.query.projectMembers.findFirst({
        where: and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, sub)),
      })
      if (!inProject) {
        await db.insert(projectMembers).values({ projectId: project.id, userId: sub, role: 'member' })
      }
    }
  }

  const company = await db.query.companies.findFirst({ where: eq(companies.id, invite.companyId) })
  return c.json({ ok: true, company })
})
