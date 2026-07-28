import { Hono } from 'hono'
import { eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { feedback, platformSettings, users } from '../db/schema.js'
import { verifyToken } from '../auth.js'
import { sendFeedbackMail } from '../lib/mails.js'
import sharp from 'sharp'
import { nanoid } from 'nanoid'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'
import { s3Client, s3Bucket, S3_KEY_PREFIX } from '../lib/s3.js'

// «О проекте» и обратная связь (SPEC §8.35).
//
// Маршрут публичный: страницу «О проекте» показываем и до входа, а вопрос
// может быть как раз у того, кто ещё не завёл аккаунт.

export const aboutRoute = new Hono()

/** Версия сборки: тот же отпечаток, что видит клиент. */
const VERSION = process.env.npm_package_version ?? '0.1.0'

async function settings(): Promise<Record<string, string>> {
  const rows = await db.select().from(platformSettings)
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

aboutRoute.get('/', async (c) => {
  const s = await settings()
  return c.json({
    version: VERSION,
    text: s['about.text'] ?? '',
    website: s['about.website'] ?? '',
  })
})

/** Темы обращения: фиксированный список, чтобы письма были разбираемы. */
const TOPICS = ['question', 'bug', 'feature', 'billing', 'other'] as const
type Topic = (typeof TOPICS)[number]

aboutRoute.post('/feedback', async (c) => {
  // Форма шлёт либо JSON, либо multipart — когда приложен скриншот.
  const contentType = c.req.header('content-type') ?? ''
  let screenshot: File | null = null
  let body: Record<string, unknown>
  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.parseBody()
    const file = form['screenshot']
    if (file instanceof File && file.size > 0) screenshot = file
    body = form as Record<string, unknown>
  } else {
    body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  }

  // Приманка для ботов: поле спрятано от людей, и заполнить его может только
  // тот, кто заполняет всё подряд. Отвечаем 200, чтобы бот не подбирал форму.
  if (typeof body.website === 'string' && body.website.trim()) return c.json({ ok: true })

  const text = typeof body.body === 'string' ? body.body.trim() : ''
  if (text.length < 10) return c.json({ error: 'Message is too short' }, 400)
  if (text.length > 5000) return c.json({ error: 'Message is too long' }, 400)

  const topic: Topic = TOPICS.includes(body.topic as Topic) ? (body.topic as Topic) : 'question'

  // Вошедшего узнаём по сессии, а не по присланным полям: иначе кто угодно
  // подписался бы чужим именем.
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
  const payload = token ? await verifyToken(token) : null
  const session = payload?.typ === 'session' ? payload : null
  const me = session ? await db.query.users.findFirst({ where: eq(users.id, session.sub) }) : null

  const email = me?.email ?? (typeof body.email === 'string' ? body.email.trim().toLowerCase() : '')
  const name = me?.name ?? (typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'Valid email is required' }, 400)

  // Простое ограничение частоты: три обращения в час с одной почты. Без него
  // форма превращается в способ засыпать почтовый ящик.
  const [{ recent }] = (await db
    .select({ recent: sql<number>`count(*)::int` })
    .from(feedback)
    .where(sql`${feedback.email} = ${email} and ${feedback.createdAt} > now() - interval '1 hour'`)) as [
    { recent: number },
  ]
  if (recent >= 3) return c.json({ error: 'Too many messages. Try again later.' }, 429)

  // Скриншот кладём до записи: если хранилище недоступно, обращение всё равно
  // должно дойти — текст важнее картинки.
  let screenshotKey: string | null = null
  if (screenshot) {
    if (screenshot.size > 8 * 1024 * 1024) return c.json({ error: 'Screenshot is too large (max 8MB)' }, 413)
    try {
      const buf = await sharp(Buffer.from(await screenshot.arrayBuffer()), { failOn: 'none' })
        .rotate()
        // Ограничиваем ширину: снимок экрана 4K весит мегабайты, а для
        // понимания проблемы хватает и полутора тысяч точек.
        .resize({ width: 1600, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer()
      const key = `${S3_KEY_PREFIX}/feedback/${nanoid(12)}.webp`
      await s3Client().send(new PutObjectCommand({ Bucket: s3Bucket(), Key: key, Body: buf, ContentType: 'image/webp' }))
      screenshotKey = key
    } catch (e) {
      console.error('[feedback] screenshot upload failed:', e)
    }
  }

  const [row] = await db
    .insert(feedback)
    .values({
      screenshotKey,
      topic,
      body: text,
      email,
      name,
      userId: me?.id ?? null,
      meta: JSON.stringify({
        // Помогает воспроизвести жалобу на интерфейс, не переспрашивая.
        ua: c.req.header('user-agent')?.slice(0, 300) ?? '',
        page: typeof body.page === 'string' ? body.page.slice(0, 300) : '',
      }),
    })
    .returning()

  // Письмо админам в фоне: ответ не должен ждать почтовый сервер.
  void notifyAdmins(row!.id, topic, text, name, email, Boolean(me), Boolean(screenshotKey))

  return c.json({ ok: true }, 201)
})

async function notifyAdmins(
  id: string,
  topic: Topic,
  text: string,
  name: string,
  email: string,
  registered: boolean,
  hasScreenshot: boolean,
) {
  const s = await settings()
  const list = (s['feedback.admins'] ?? '')
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
  if (!list.length) return

  // Имя получателей берём из базы, если они наши пользователи — письмо на
  // родном языке читается легче.
  const admins = await db.query.users.findMany({ where: inArray(users.email, list) })
  const localeOf = (mail: string) => admins.find((a) => a.email === mail)?.locale ?? null

  for (const to of list) {
    void sendFeedbackMail({ to, locale: localeOf(to), id, topic, body: text, name, email, registered, hasScreenshot })
  }
}

/**
 * Скриншот обращения. Бакет приватный, поэтому раздаём прокси — по прямой
 * ссылке из письма, которую открывает тот, кто разбирает обращения.
 */
aboutRoute.get('/feedback/:id/screenshot', async (c) => {
  const row = await db.query.feedback.findFirst({ where: eq(feedback.id, c.req.param('id')) })
  if (!row?.screenshotKey) return c.json({ error: 'Not found' }, 404)
  try {
    const res = await s3Client().send(new GetObjectCommand({ Bucket: s3Bucket(), Key: row.screenshotKey }))
    c.header('Content-Type', 'image/webp')
    c.header('Cache-Control', 'private, max-age=3600')
    return c.body(Readable.toWeb(res.Body as Readable) as ReadableStream)
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
})
