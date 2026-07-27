import { Hono } from 'hono'
import { eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { feedback, platformSettings, users } from '../db/schema.js'
import { verifyToken } from '../auth.js'
import { sendFeedbackMail } from '../lib/mails.js'

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
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>

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

  const [row] = await db
    .insert(feedback)
    .values({
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
  void notifyAdmins(row!.id, topic, text, name, email, Boolean(me))

  return c.json({ ok: true }, 201)
})

async function notifyAdmins(
  id: string,
  topic: Topic,
  text: string,
  name: string,
  email: string,
  registered: boolean,
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
    void sendFeedbackMail({ to, locale: localeOf(to), id, topic, body: text, name, email, registered })
  }
}
