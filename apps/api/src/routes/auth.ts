import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { signSessionToken, requireSession, type SessionEnv } from '../auth.js'
import { env } from '../env.js'

export const auth = new Hono<SessionEnv>()

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'

// GET /api/v1/auth/google — редирект на Google consent screen
auth.get('/google', (c) => {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
  })
  return c.redirect(`${GOOGLE_AUTH_URL}?${params}`)
})

// GET /api/v1/auth/google/callback — обмен кода, upsert юзера, редирект в app с session-токеном
auth.get('/google/callback', async (c) => {
  const code = c.req.query('code')
  if (!code) return c.redirect(`${env.APP_URL}/#/auth?error=no_code`)

  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: env.GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    })
    if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`)
    const { access_token } = (await tokenRes.json()) as { access_token: string }

    const infoRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${access_token}` },
    })
    if (!infoRes.ok) throw new Error(`userinfo failed: ${infoRes.status}`)
    const info = (await infoRes.json()) as {
      sub: string
      email: string
      name?: string
      picture?: string
    }

    const email = info.email.toLowerCase()

    // upsert: сперва по googleId, затем по email (линкуем существующего)
    let user =
      (await db.query.users.findFirst({ where: eq(users.googleId, info.sub) })) ??
      (await db.query.users.findFirst({ where: eq(users.email, email) }))

    if (user) {
      const [updated] = await db
        .update(users)
        .set({ googleId: info.sub, avatarUrl: info.picture ?? user.avatarUrl, name: user.name || info.name || '' })
        .where(eq(users.id, user.id))
        .returning()
      user = updated!
    } else {
      const [created] = await db
        .insert(users)
        .values({ email, name: info.name ?? '', googleId: info.sub, avatarUrl: info.picture })
        .returning()
      user = created!
    }

    const token = await signSessionToken({ sub: user.id, email: user.email })
    return c.redirect(`${env.APP_URL}/#/auth?token=${token}`)
  } catch (err) {
    console.error('google oauth error:', err)
    return c.redirect(`${env.APP_URL}/#/auth?error=oauth_failed`)
  }
})

// GET /api/v1/auth/me — профиль по любому валидному токену
auth.get('/me', requireSession, async (c) => {
  const { sub } = c.get('session')
  const user = await db.query.users.findFirst({ where: eq(users.id, sub) })
  if (!user) return c.json({ error: 'Not found' }, 404)
  return c.json({
    id: user.id,
    email: user.email,
    name: user.name,
    locale: user.locale,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
  })
})
