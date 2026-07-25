import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import sharp from 'sharp'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { signSessionToken, requireSession, type SessionEnv } from '../auth.js'
import { env } from '../env.js'
import { s3Client, s3Bucket, getObjectStream, S3_KEY_PREFIX } from '../lib/s3.js'

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

// PATCH /api/v1/auth/me — смена имени
auth.patch('/me', requireSession, zValidator('json', z.object({ name: z.string().min(1).max(120) })), async (c) => {
  const { sub } = c.get('session')
  const { name } = c.req.valid('json')
  await db.update(users).set({ name: name.trim() }).where(eq(users.id, sub))
  return c.json({ ok: true, name: name.trim() })
})

// POST /api/v1/auth/me/avatar — загрузка аватара (webp, приватный бакет; раздаём через /avatar/:userId)
auth.post('/me/avatar', requireSession, async (c) => {
  const { sub } = c.get('session')
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
    const key = `${S3_KEY_PREFIX}/avatars/${sub}-${nanoid(6)}.webp`
    await s3Client().send(new PutObjectCommand({ Bucket: s3Bucket(), Key: key, Body: buffer, ContentType: 'image/webp' }))
    // версия в URL, чтобы обойти кэш при смене
    const url = `${process.env.API_PUBLIC_URL || 'https://api.chatick.com'}/api/v1/auth/avatar/${sub}?v=${Date.now()}`
    await db.update(users).set({ avatarUrl: url, avatarKey: key }).where(eq(users.id, sub))
    return c.json({ avatarUrl: url })
  } catch (e) {
    console.error('[avatar] upload failed:', e)
    return c.json({ error: 'Failed to process image' }, 500)
  }
})

// GET /api/v1/auth/avatar/:userId — публичная прокси-раздача аватара из приватного бакета
auth.get('/avatar/:userId', async (c) => {
  const user = await db.query.users.findFirst({ where: eq(users.id, c.req.param('userId')) })
  if (!user?.avatarKey) return c.json({ error: 'Not found' }, 404)
  try {
    const { body, contentType } = await getObjectStream({ client: s3Client(), bucket: s3Bucket(), keyPrefix: S3_KEY_PREFIX, isCustom: false, publicUrl: null }, user.avatarKey)
    c.header('Content-Type', contentType || 'image/webp')
    c.header('Cache-Control', 'public, max-age=86400')
    const { Readable } = await import('node:stream')
    return c.body(Readable.toWeb(body) as ReadableStream)
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
})

// --- Подтверждение доступа для внешнего ИИ (SPEC §8.27, device flow) --------
// Человек вводит код в браузере; здесь он видит, что именно одобряет, и выбирает проект.

auth.get('/bridge/code/:code', requireSession, async (c) => {
  const { lookupUserCode } = await import('../lib/bridge-auth.js')
  const found = await lookupUserCode(c.req.param('code'))
  if (!found) return c.json({ error: 'Code not found or expired' }, 404)
  return c.json({ clientName: found.clientName })
})

auth.post('/bridge/approve', requireSession, async (c) => {
  const { sub } = c.get('session')
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const code = typeof body.code === 'string' ? body.code : ''
  const projectId = typeof body.projectId === 'string' ? body.projectId : ''
  if (!code || !projectId) return c.json({ error: 'code and projectId are required' }, 400)

  // одобрять можно только тот проект, в котором человек реально состоит
  const { memberDomains } = await import('./projects.js')
  if (!(await memberDomains(projectId, sub))) return c.json({ error: 'You are not a member of this project' }, 403)

  const { approveUserCode } = await import('../lib/bridge-auth.js')
  const ok = await approveUserCode(code, sub, projectId)
  if (!ok) return c.json({ error: 'Code not found or expired' }, 404)
  return c.json({ ok: true })
})

auth.post('/bridge/deny', requireSession, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const { denyUserCode } = await import('../lib/bridge-auth.js')
  await denyUserCode(typeof body.code === 'string' ? body.code : '')
  return c.json({ ok: true })
})

// Активные туннели пользователя + закрытие
auth.get('/bridge/sessions', requireSession, async (c) => {
  const { sub } = c.get('session')
  const { listSessions } = await import('../lib/bridge-auth.js')
  return c.json({ items: await listSessions(sub) })
})

auth.delete('/bridge/sessions/:id', requireSession, async (c) => {
  const { sub } = c.get('session')
  const { closeSession } = await import('../lib/bridge-auth.js')
  await closeSession(c.req.param('id'), sub)
  return c.json({ ok: true })
})
