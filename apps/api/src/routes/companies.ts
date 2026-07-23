import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../db/client.js'
import { companies, companyMembers, companyInvites, users } from '../db/schema.js'
import { requireSession, type SessionEnv } from '../auth.js'
import { sendMail } from '../lib/mail.js'
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
    await sendMail({
      to: email,
      subject: `You've been invited to ${company?.name} on Chatick`,
      text: `You've been invited to join "${company?.name}" on Chatick as ${role}.\n\nAccept the invite: ${env.APP_URL}/#/invite/${token}\n\nIf you don't have an account yet, sign in with Google using this email.`,
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
  await sendMail({
    to: invite.email,
    subject: `Reminder: invitation to ${company?.name} on Chatick`,
    text: `You've been invited to join "${company?.name}" on Chatick as ${invite.role}.\n\nAccept the invite: ${env.APP_URL}/#/invite/${invite.token}`,
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
