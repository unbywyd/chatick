import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { deleteObject, resolveStorage } from '../lib/s3.js'
import { sendDeletedMail } from '../lib/mails.js'
import { db } from '../db/client.js'
import { companies, companyMembers, companyInvites, files, messages, projectMembers, projects, tasks, timeEntries, users } from '../db/schema.js'
import { requireSession, type SessionEnv } from '../auth.js'
import { sendInviteMail } from '../lib/mail-invite.js'
import { encrypt } from '../lib/crypto.js'
import { LLM_PROVIDERS, testLlm, type LlmProvider } from '../lib/llm.js'
import { env } from '../env.js'

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

  return c.json({
    companies: memberships.map((m) => ({ ...m.company, myRole: m.role })),
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
    const own = await db.query.companyMembers.findFirst({
      where: and(eq(companyMembers.userId, sub), eq(companyMembers.role, 'admin')),
    })
    if (own) {
      return c.json(
        { error: 'You already have a company', hint: 'Create projects inside it, or ask to be invited elsewhere.' },
        409,
      )
    }

    const [company] = await db.insert(companies).values({ name, logoUrl }).returning()
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

  // окно в 12 недель: три месяца — тот срок, на котором видно тренд
  const since = new Date()
  since.setDate(since.getDate() - 84)

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
      .where(and(inArray(timeEntries.projectId, ids), sql`${timeEntries.endedAt} is not null`))
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
        and ${timeEntries.startedAt} >= ${since.toISOString()}::timestamptz
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
        sql`${timeEntries.startedAt} >= ${since.toISOString()}::timestamptz`,
      ),
    )
    .groupBy(timeEntries.userId, users.name, users.avatarUrl)
    .orderBy(sql`2 desc`)

  const byId = <T extends { projectId: string }>(rows: T[]) => new Map(rows.map((r) => [r.projectId, r]))
  const taskMap = byId(taskRows)
  const memberMap = byId(memberRows)
  const timeMap = byId(timeRows)
  const msgMap = byId(msgRows)

  const list = projectRows.map((p) => {
    const t = taskMap.get(p.id)
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      logoUrl: p.logoUrl,
      tasksTotal: t?.total ?? 0,
      tasksDone: t?.done ?? 0,
      overdue: t?.overdue ?? 0,
      progress: t?.total ? Math.round(((t.done ?? 0) / t.total) * 100) : 0,
      members: memberMap.get(p.id)?.count ?? 0,
      minutes: timeMap.get(p.id)?.minutes ?? 0,
      messages: msgMap.get(p.id)?.count ?? 0,
    }
  })

  const companyPeople = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(companyMembers)
    .where(eq(companyMembers.companyId, companyId))

  return c.json({
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
    providers: Object.entries(LLM_PROVIDERS).map(([id, p]) => ({ id, label: p.label, defaultModel: p.defaultModel })),
  })
})

companiesRoute.put(
  '/:companyId/llm',
  zValidator(
    'json',
    z.object({
      provider: z.enum(Object.keys(LLM_PROVIDERS) as [LlmProvider, ...LlmProvider[]]),
      model: z.string().min(1).max(120).optional(),
      apiKey: z.string().min(8).max(512),
    }),
  ),
  async (c) => {
    const { sub } = c.get('session')
    const companyId = c.req.param('companyId')
    if ((await memberRoleIn(companyId, sub)) !== 'admin') return c.json({ error: 'Forbidden' }, 403)

    const { provider, model, apiKey } = c.req.valid('json')
    const resolvedModel = model || LLM_PROVIDERS[provider].defaultModel

    // проверяем ключ живым запросом до сохранения
    const ok = await testLlm({ provider, model: resolvedModel, apiKey })
    if (!ok) return c.json({ error: 'LLM check failed — verify the key and model' }, 422)

    await db
      .update(companies)
      .set({ llmProvider: provider, llmModel: resolvedModel, llmKeyEncrypted: encrypt(apiKey) })
      .where(eq(companies.id, companyId))
    return c.json({ ok: true, provider, model: resolvedModel })
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
  zValidator('json', z.object({ email: z.string().email().toLowerCase(), role: z.enum(['admin', 'manager', 'member']).default('member') })),
  async (c) => {
    const { sub } = c.get('session')
    const companyId = c.req.param('companyId')
    const myRole = await memberRoleIn(companyId, sub)
    if (!canManageInvites(myRole)) return c.json({ error: 'Forbidden' }, 403)

    const { email, role } = c.req.valid('json')

    const existing = await db.query.companyInvites.findFirst({
      where: and(eq(companyInvites.companyId, companyId), eq(companyInvites.email, email), eq(companyInvites.status, 'pending')),
    })
    if (existing) return c.json({ error: 'Invite already pending' }, 409)

    const token = nanoid(32)
    const [invite] = await db
      .insert(companyInvites)
      .values({ companyId, email, role, token, invitedById: sub })
      .returning()

    const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) })
    const inviter = await db.query.users.findFirst({ where: eq(users.id, sub) })
    await sendInviteMail({
      to: email,
      companyName: company?.name ?? '',
      role,
      token,
      inviterLocale: inviter?.locale,
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

  const company = await db.query.companies.findFirst({ where: eq(companies.id, invite.companyId) })
  return c.json({ ok: true, company })
})
