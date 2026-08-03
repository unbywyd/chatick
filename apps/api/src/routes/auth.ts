import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import sharp from 'sharp'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { db } from '../db/client.js'
import { companyMembers, users } from '../db/schema.js'
import { signSessionToken, requireSession, type SessionEnv } from '../auth.js'
import { env } from '../env.js'
import { s3Client, s3Bucket, getObjectStream, S3_KEY_PREFIX } from '../lib/s3.js'
import { notifySignup } from '../lib/admin-alert.js'
import { sendLoginCode, verifyLoginCode } from '../lib/otp.js'

export const auth = new Hono<SessionEnv>()

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'

/**
 * Переносит аватарку из Google в наше хранилище.
 *
 * Прямые ссылки lh3.googleusercontent.com ненадёжны как основа: они отдают
 * картинку только запросам без referrer, живут не вечно и меняются вместе с
 * фото в аккаунте. Панель в трее из-за этого показывала пустой кружок.
 * Забираем один раз при входе — дальше картинка наша.
 *
 * Fail-open: не смогли скачать — вход не должен из-за этого падать.
 */
async function adoptGoogleAvatar(userId: string, pictureUrl: string): Promise<{ url: string; key: string } | null> {
  try {
    const res = await fetch(pictureUrl, { signal: AbortSignal.timeout(7000) })
    if (!res.ok) return null
    const raw = Buffer.from(await res.arrayBuffer())
    if (!raw.length || raw.length > 5 * 1024 * 1024) return null

    const buffer = await sharp(raw, { failOn: 'none' })
      .rotate()
      .resize(256, 256, { fit: 'cover' })
      .webp({ quality: 85 })
      .toBuffer()

    const key = `${S3_KEY_PREFIX}/avatars/${userId}-${nanoid(6)}.webp`
    await s3Client().send(
      new PutObjectCommand({ Bucket: s3Bucket(), Key: key, Body: buffer, ContentType: 'image/webp' }),
    )
    const url = `${process.env.API_PUBLIC_URL || 'https://api.chatick.com'}/api/v1/auth/avatar/${userId}?v=${Date.now()}`
    return { url, key }
  } catch (e) {
    console.error('[avatar] не удалось забрать аватарку из Google:', e)
    return null
  }
}

// GET /api/v1/auth/google — редирект на Google consent screen
auth.get('/google', (c) => {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
  })
  // Код десктопного входа возвращаем себе же через state: браузер может
  // открыть колбэк в новой вкладке, и на sessionStorage полагаться нельзя.
  const desktop = c.req.query('desktop')
  if (desktop) params.set('state', `desktop:${desktop}`)
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
        // Аватарку здесь НЕ трогаем: раньше каждый вход перезаписывал её
        // ссылкой из Google — и фото, загруженное человеком вручную,
        // молча заменялось гугловским. Ниже разберёмся отдельно.
        .set({ googleId: info.sub, name: user.name || info.name || '' })
        .where(eq(users.id, user.id))
        .returning()
      user = updated!
    } else {
      const [created] = await db
        .insert(users)
        .values({ email, name: info.name ?? '', googleId: info.sub })
        .returning()
      user = created!
      // Кто-то зарегистрировался — сообщаем владельцу площадки.
      // Через void: письмо не должно задерживать вход, а сбой почты —
      // ломать регистрацию.
      void notifySignup(created!.email, created!.name)
    }

    // Своя картинка (avatarKey) — неприкосновенна. Забираем гугловскую только
    // когда её нет вовсе: один раз, при первом входе.
    if (info.picture && !user.avatarKey) {
      const moved = await adoptGoogleAvatar(user.id, info.picture)
      if (moved) {
        const [withAvatar] = await db
          .update(users)
          .set({ avatarUrl: moved.url, avatarKey: moved.key })
          .where(eq(users.id, user.id))
          .returning()
        user = withAvatar!
      } else if (!user.avatarUrl) {
        // Не получилось — пусть будет хотя бы прямая ссылка, чем ничего.
        const [fallback] = await db
          .update(users)
          .set({ avatarUrl: info.picture })
          .where(eq(users.id, user.id))
          .returning()
        user = fallback!
      }
    }

    const token = await signSessionToken({ sub: user.id, email: user.email })
    const desktop = c.req.query('state')?.startsWith('desktop:')
      ? c.req.query('state')!.slice('desktop:'.length)
      : null
    const suffix = desktop ? `&desktop=${encodeURIComponent(desktop)}` : ''
    return c.redirect(`${env.APP_URL}/#/auth?token=${token}${suffix}`)
  } catch (err) {
    console.error('google oauth error:', err)
    return c.redirect(`${env.APP_URL}/#/auth?error=oauth_failed`)
  }
})

// --- вход из десктопа (SPEC §8.33) -------------------------------------------
//
// Google не даёт показывать свой экран согласия внутри окна Electron, поэтому
// вход всегда уходит в системный браузер. Оттуда токен надо как-то вернуть
// приложению: оно заранее берёт код, открывает браузер с ним, а потом
// опрашивает сервер, пока код не обменяется на токен.
//
// Коды живут в памяти: они одноразовые и короткоживущие, переживать перезапуск
// им незачем — человек просто нажмёт «Войти» ещё раз.

type PendingLogin = { token: string | null; expiresAt: number }
const desktopLogins = new Map<string, PendingLogin>()
const DESKTOP_LOGIN_TTL_MS = 10 * 60 * 1000

function sweepDesktopLogins() {
  const now = Date.now()
  for (const [code, entry] of desktopLogins) if (entry.expiresAt < now) desktopLogins.delete(code)
}

// --- вход по коду на почту (SPEC §8.38) --------------------------------------
//
// Второй способ входа рядом с Google: у корпоративной почты часто нет
// Google-аккаунта, а заводить пароли ради этого не хочется — их пришлось бы
// хранить, восстанавливать и однажды потерять.
//
// Аккаунт при этом НЕ создаётся: код уходит только тому, кто уже есть в
// системе. Регистрация — через Google или через API компании.

auth.post('/otp/request', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: unknown }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!email || !email.includes('@')) return c.json({ error: 'Email required' }, 400)

  const user = await db.query.users.findFirst({ where: eq(users.email, email) })

  // Отвечаем одинаково и когда человек есть, и когда его нет. Иначе форма
  // входа превращается в способ проверять, зарегистрирован ли адрес.
  const answer = { sent: true, expiresInSec: 600 }
  if (!user) return c.json(answer)

  const res = await sendLoginCode(email, user.locale)
  if (!res.ok) return c.json({ error: 'Too soon', retryInSec: res.retryInSec }, 429)
  return c.json(answer)
})

auth.post('/otp/verify', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; code?: unknown }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const code = typeof body.code === 'string' ? body.code : ''
  if (!email || !code) return c.json({ error: 'Email and code required' }, 400)

  const result = verifyLoginCode(email, code)
  if (result === 'too-many') return c.json({ error: 'Too many attempts. Request a new code.' }, 429)
  if (result !== 'ok') return c.json({ error: 'Wrong or expired code' }, 401)

  const user = await db.query.users.findFirst({ where: eq(users.email, email) })
  // Код верен, а человека нет — такое бывает, если его удалили, пока письмо
  // шло. Пускать некого.
  if (!user) return c.json({ error: 'Wrong or expired code' }, 401)

  const token = await signSessionToken({ sub: user.id, email: user.email })
  return c.json({ token, user: { id: user.id, name: user.name, email: user.email } })
})

// POST /api/v1/auth/desktop — приложение берёт код перед открытием браузера
auth.post('/desktop', (c) => {
  sweepDesktopLogins()
  const code = nanoid(32)
  desktopLogins.set(code, { token: null, expiresAt: Date.now() + DESKTOP_LOGIN_TTL_MS })
  return c.json({
    code,
    url: `${env.APP_URL}/#/login?desktop=${code}`,
    expiresInSec: DESKTOP_LOGIN_TTL_MS / 1000,
  })
})

// POST /api/v1/auth/desktop/claim — браузер отдаёт добытый токен под кодом.
// Требует валидной сессии: иначе кто угодно подложил бы чужой токен в чужой код.
auth.post('/desktop/claim', requireSession, async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
  const code = typeof body.code === 'string' ? body.code : ''
  const entry = desktopLogins.get(code)
  if (!entry || entry.expiresAt < Date.now()) {
    desktopLogins.delete(code)
    return c.json({ error: 'Code expired' }, 410)
  }

  // Кладём не присланный клиентом токен, а свежий для того, кто подтвердил
  // вход: так десктоп не может получить сессию шире, чем у самого человека.
  const { sub } = c.get('session')
  const user = await db.query.users.findFirst({ where: eq(users.id, sub) })
  if (!user) return c.json({ error: 'Not found' }, 404)
  entry.token = await signSessionToken({ sub: user.id, email: user.email })
  return c.json({ ok: true })
})

// GET /api/v1/auth/desktop/poll?code=... — приложение ждёт подтверждения
auth.get('/desktop/poll', (c) => {
  const code = c.req.query('code') ?? ''
  const entry = desktopLogins.get(code)
  if (!entry || entry.expiresAt < Date.now()) {
    desktopLogins.delete(code)
    return c.json({ status: 'expired' })
  }
  if (!entry.token) return c.json({ status: 'pending' })

  // Одноразовость: код сгорает вместе с выдачей токена.
  desktopLogins.delete(code)
  return c.json({ status: 'approved', token: entry.token })
})

// --- где человек сейчас (SPEC §8.33) -----------------------------------------
//
// Ассистенту с доступом на всю компанию нужно знать, в каком проекте человек
// работает прямо сейчас: иначе он либо переспрашивает, либо угадывает. Клиент
// отмечается при переходе между проектами, мост читает это в /x/whoami.
//
// Держим в памяти: знание живёт минуты и переживать перезапуск ему незачем.

type Presence = { projectId: string; at: number }
const presence = new Map<string, Presence>()
const PRESENCE_TTL_MS = 15 * 60 * 1000

export function readPresence(userId: string): Presence | null {
  const p = presence.get(userId)
  if (!p) return null
  if (Date.now() - p.at > PRESENCE_TTL_MS) {
    presence.delete(userId)
    return null
  }
  return p
}

// POST /api/v1/auth/presence — «я сейчас здесь»
auth.post('/presence', requireSession, async (c) => {
  const { sub } = c.get('session')
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const projectId = typeof body.projectId === 'string' ? body.projectId : ''
  if (!projectId) {
    presence.delete(sub)
    return c.json({ ok: true })
  }
  presence.set(sub, { projectId, at: Date.now() })
  return c.json({ ok: true })
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
  const companyId = typeof body.companyId === 'string' ? body.companyId : ''
  const all = body.all === true
  if (!code || (!projectId && !companyId && !all)) {
    return c.json({ error: 'code and either projectId, companyId or all:true are required' }, 400)
  }

  const { approveUserCode } = await import('../lib/bridge-auth.js')

  // Мастер-доступ: все проекты человека во всех его компаниях. Ничего сверх
  // собственного он так не выдаёт — каждый запрос всё равно проверяет членство
  // в конкретном проекте и права в нём. Отдельный режим нужен потому, что
  // приложение мультикомпанейское: держать по туннелю на компанию неудобно.
  if (all) {
    const ok = await approveUserCode(code, sub, { all: true })
    return ok ? c.json({ ok: true }) : c.json({ error: 'Code not found or expired' }, 404)
  }

  // Подключиться к компании может любой её участник. Раньше это давали только
  // админам и менеджерам — из опасения, что участник «раздаст ассистенту
  // проекты, которыми не управляет». Опасение неверное: туннель компании
  // открывает ровно те проекты, где человек СОСТОИТ (resolveProject проверяет
  // членство), и с ровно его правами (hasPermission на каждом запросе).
  // Больше, чем есть у самого человека, ассистент так не получит.
  //
  // Взамен ограничение загоняло обычного участника — то есть большинство — в
  // туннель на один проект, хотя приложение мультипроектное: переподключаться
  // при каждом переходе между проектами никто не станет.
  if (companyId) {
    const membership = await db.query.companyMembers.findFirst({
      where: and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, sub)),
    })
    if (!membership) return c.json({ error: 'You are not a member of this company' }, 403)
    const ok = await approveUserCode(code, sub, { companyId })
    return ok ? c.json({ ok: true }) : c.json({ error: 'Code not found or expired' }, 404)
  }

  // одобрять можно только тот проект, в котором человек реально состоит
  const { memberDomains } = await import('./projects.js')
  if (!(await memberDomains(projectId, sub))) return c.json({ error: 'You are not a member of this project' }, 403)

  const ok = await approveUserCode(code, sub, { projectId })
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
