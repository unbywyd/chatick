import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { signToken, requireAuth, type AuthEnv } from '../auth.js'
import { hashPassword, verifyPassword } from '../lib/password.js'

export const auth = new Hono<AuthEnv>()

const credentialsSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(8),
})

auth.post('/register', zValidator('json', credentialsSchema.extend({ name: z.string().min(1) })), async (c) => {
  const { email, password, name } = c.req.valid('json')

  const existing = await db.query.users.findFirst({ where: eq(users.email, email) })
  if (existing) return c.json({ error: 'Email already registered' }, 409)

  const [user] = await db
    .insert(users)
    .values({ email, name, passwordHash: await hashPassword(password) })
    .returning()

  const token = await signToken({ sub: user!.id, email: user!.email, isAdmin: user!.isAdmin })
  return c.json({ token, user: { id: user!.id, email: user!.email, name: user!.name } }, 201)
})

auth.post('/login', zValidator('json', credentialsSchema), async (c) => {
  const { email, password } = c.req.valid('json')

  const user = await db.query.users.findFirst({ where: eq(users.email, email) })
  if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  const token = await signToken({ sub: user.id, email: user.email, isAdmin: user.isAdmin })
  return c.json({ token, user: { id: user.id, email: user.email, name: user.name } })
})

auth.get('/me', requireAuth, async (c) => {
  const { sub } = c.get('user')
  const user = await db.query.users.findFirst({ where: eq(users.id, sub) })
  if (!user) return c.json({ error: 'Not found' }, 404)
  return c.json({ id: user.id, email: user.email, name: user.name, locale: user.locale, phone: user.phone })
})
