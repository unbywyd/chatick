import { Hono } from 'hono'
import { desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { reviews, users, platformSettings } from '../db/schema.js'
import { verifyToken } from '../auth.js'
import { sendReviewMail } from '../lib/mails.js'

// Отзывы с сайта (SPEC §8.37).
//
// Маршрут публичный: отзыв оставляют и те, кто не завёл аккаунт, а читают его
// вообще все. Поэтому здесь та же защита, что и в форме обращения: приманка
// для ботов, ограничения на длину и на частоту.

export const reviewsRoute = new Hono()

/** Опубликованные отзывы — для сайта. */
reviewsRoute.get('/', async (c) => {
  const rows = await db
    .select({
      id: reviews.id,
      name: reviews.name,
      role: reviews.role,
      rating: reviews.rating,
      body: reviews.body,
      createdAt: reviews.createdAt,
    })
    .from(reviews)
    .where(eq(reviews.status, 'published'))
    .orderBy(desc(reviews.createdAt))
    .limit(50)
  // Почту не отдаём: она нужна, чтобы ответить, а не чтобы её собирали со страницы.
  return c.json({ items: rows })
})

reviewsRoute.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>

  // Приманка: поле спрятано от людей, заполнить его может только тот, кто
  // заполняет всё подряд. Отвечаем 200, чтобы бот не подбирал форму.
  if (typeof body.website === 'string' && body.website.trim()) return c.json({ ok: true })

  const text = typeof body.body === 'string' ? body.body.trim() : ''
  if (text.length < 20) return c.json({ error: 'Please write a little more' }, 400)
  if (text.length > 2000) return c.json({ error: 'Review is too long' }, 400)

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
  if (name.length < 2) return c.json({ error: 'Name is required' }, 400)

  const role = typeof body.role === 'string' ? body.role.trim().slice(0, 80) : ''
  const ratingRaw = Number(body.rating)
  const rating = Number.isFinite(ratingRaw) ? Math.min(5, Math.max(1, Math.round(ratingRaw))) : 5

  // Вошедшего узнаём по сессии: иначе кто угодно подпишется чужим именем.
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
  const payload = token ? await verifyToken(token) : null
  const session = payload?.typ === 'session' ? payload : null
  const me = session ? await db.query.users.findFirst({ where: eq(users.id, session.sub) }) : null

  const email = me?.email ?? (typeof body.email === 'string' ? body.email.trim().toLowerCase() : '')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'Valid email is required' }, 400)

  // Не чаще двух отзывов в сутки с одной почты: без этого форма превращается
  // в способ засыпать страницу.
  const [{ recent }] = (await db
    .select({ recent: sql<number>`count(*)::int` })
    .from(reviews)
    .where(sql`${reviews.email} = ${email} and ${reviews.createdAt} > now() - interval '1 day'`)) as [
    { recent: number },
  ]
  if (recent >= 2) return c.json({ error: 'Thanks — you have already left a review recently.' }, 429)

  const [row] = await db
    .insert(reviews)
    .values({
      name,
      email,
      role,
      rating,
      body: text,
      userId: me?.id ?? null,
      // status по умолчанию 'pending' — на сайт попадёт только после проверки
      meta: JSON.stringify({
        ua: c.req.header('user-agent')?.slice(0, 300) ?? '',
        lang: typeof body.lang === 'string' ? body.lang.slice(0, 10) : '',
      }),
    })
    .returning()

  // Письмо админам в фоне: ответ не должен ждать почтовый сервер.
  void notifyAdmins(row!.id, name, email, rating, text)

  return c.json({ ok: true, pending: true }, 201)
})

async function notifyAdmins(id: string, name: string, email: string, rating: number, text: string) {
  const rows = await db.select().from(platformSettings)
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  const list = (s['feedback.admins'] ?? '')
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
  if (!list.length) return
  for (const to of list) void sendReviewMail({ to, id, name, email, rating, body: text })
}
