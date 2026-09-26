import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notifications, projects, users, userNotificationPrefs } from '../db/schema.js'
import { sendDigestMail } from './mails.js'
import { localeFor } from './locale.js'
import { env } from '../env.js'

// Суточный email-дайджест непрочитанных уведомлений (SPEC §8.22).
// Мгновенных писем НЕТ — одно письмо в сутки со сводкой по проектам.

type Lang = 'en' | 'ru' | 'he'
const STR: Record<Lang, { subject: string; intro: string; open: string; footer: string; unsubscribe: string }> = {
  en: {
    subject: 'Your Chatick digest — {{count}} unread',
    intro: 'While you were away:',
    open: 'Open Chatick',
    footer: 'You get one digest a day. Turn it off in notification settings.',
    unsubscribe: 'Unsubscribe',
  },
  ru: {
    subject: 'Сводка Chatick — {{count}} непрочитанных',
    intro: 'Пока вас не было:',
    open: 'Открыть Chatick',
    footer: 'Это одно письмо в сутки. Отключить можно в настройках уведомлений.',
    unsubscribe: 'Отписаться',
  },
  he: {
    subject: 'סיכום Chatick — {{count}} שלא נקראו',
    intro: 'בזמן שלא היית:',
    open: 'פתח את Chatick',
    footer: 'זהו סיכום יומי אחד. ניתן לכבות בהגדרות ההתראות.',
    unsubscribe: 'ביטול הרשמה',
  },
}
const langOf = (l: string | null | undefined): Lang => {
  const s = (l || 'en').slice(0, 2)
  return s === 'ru' || s === 'he' ? s : 'en'
}
const fmt = (s: string, v: Record<string, string>) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? '')

const DIGEST_MIN_GAP_MS = 20 * 60 * 60 * 1000 // не чаще раза в ~сутки

/**
 * Сколько человек может не заходить, прежде чем сводки прекратятся.
 *
 * Сводка зовёт вернуться. Тому, кто не заходит, она зовёт вернуться КАЖДЫЙ
 * день одним и тем же текстом: на проде нашёлся адрес, получавший письмо про
 * ОДНО непрочитанное больше месяца подряд — человек последний раз заходил
 * 21 августа. Это не напоминание, это то, на что жмут «спам».
 *
 * Уведомления при этом никуда не деваются: зайдёт — увидит всё, и письма
 * возобновятся сами.
 *
 * СЕМЬ дней, а не двое. Двое суток казались разумными, пока не проверил на
 * живых: порог в 48 часов заткнул бы ПЯТЕРЫХ из шести получателей, включая
 * тех, кто работает каждую неделю, — люди работают рывками, и одни выходные
 * уже перекрывают двое суток. Семь дней отсекают заброшенные адреса и не
 * задевают работающих:
 *
 *   marsel81   36 дней  — молчим (за этим и затевалось)
 *   tal         9 дней  — молчим
 *   hadeel      3.8 дня — пишем
 *   artyom      2.6 дня — пишем
 *   elisha      2.0 дня — пишем
 */
const DIGEST_INACTIVE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Когда человек в последний раз что-то делал в Chatick.
 *
 * Отдельного «последнего визита» в базе нет, и заводить колонку ради письма
 * дорого: её пришлось бы обновлять на каждом запросе. Складываем из следов,
 * которые и так остаются:
 *
 *   • открыл чат проекта     (project_members.last_seen_group_at)
 *   • прочитал уведомление   (notifications.read_at)
 *   • сделал что угодно      (activity_log — задачи, комментарии, файлы)
 *   • вёл время             (time_entries.started_at)
 *   • работал через мост     (bridge_sessions.last_used_at) — так работает
 *                            команда: руками в интерфейс заходят реже, чем
 *                            ассистент ходит в API от их имени
 *
 * Одним запросом, а не четырьмя: дайджест проходит по всем получателям, и
 * лишние обращения множатся на их число.
 *
 * Null означает «следов нет вовсе» — человек зарегистрировался и не сделал
 * ничего. Такому не шлём тем более.
 */
async function lastActivityAt(userId: string): Promise<Date | null> {
  const [row] = await db.execute<{ at: Date | null }>(sql`
    select greatest(
      (select max(pm.last_seen_group_at) from project_members pm where pm.user_id = ${userId}),
      (select max(n.read_at) from notifications n where n.user_id = ${userId}),
      (select max(a.created_at) from activity_log a where a.actor_id = ${userId}),
      (select max(te.started_at) from time_entries te where te.user_id = ${userId}),
      (select max(bs.last_used_at) from bridge_sessions bs where bs.user_id = ${userId})
    ) as at
  `) as unknown as [{ at: Date | null }]
  return row?.at ? new Date(row.at) : null
}

/** Отправляет суточные дайджесты тем, у кого есть непрочитанные и настал их час. */
export async function sendDailyDigests(): Promise<void> {
  try {
    const hourNow = new Date().getUTCHours()

    // пользователи с непрочитанными уведомлениями
    const rows = await db
      .select({ userId: notifications.userId, count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(isNull(notifications.readAt))
      .groupBy(notifications.userId)
    if (!rows.length) return

    for (const r of rows) {
      const user = await db.query.users.findFirst({ where: eq(users.id, r.userId) })
      if (!user?.email) continue
      const prefs = await db.query.userNotificationPrefs.findFirst({ where: eq(userNotificationPrefs.userId, r.userId) })
      const dailyDigest = prefs?.dailyDigest ?? true
      if (!dailyDigest) continue
      const hour = Number(prefs?.digestHourUtc ?? 9)
      if (hourNow !== hour) continue
      if (prefs?.lastDigestAt && Date.now() - new Date(prefs.lastDigestAt).getTime() < DIGEST_MIN_GAP_MS) continue

      /**
       * Молчим, если человек давно не заходил.
       *
       * Проверка стоит ПОСЛЕ дешёвых отсечек (выключено, не тот час, слали
       * недавно) и до сборки письма: она делает запрос в базу, и гонять его
       * для тех, кому и так не пишем, незачем.
       *
       * Это касается ТОЛЬКО сводки. Письма по событию — приглашение в проект,
       * код входа, отчёт — идут всегда: человек их ждёт прямо сейчас, и
       * молчание там означало бы, что он не может войти.
       */
      const seenAt = await lastActivityAt(r.userId)
      const idleMs = seenAt ? Date.now() - seenAt.getTime() : Infinity
      if (idleMs > DIGEST_INACTIVE_MS) {
        console.log(
          `[digest] skip ${user.email}: не заходил ${seenAt ? Math.floor(idleMs / 3600000) + 'ч' : 'ни разу'}`,
        )
        continue
      }

      // непрочитанные этого юзера, сгруппированные по проекту
      const items = await db
        .select({ n: notifications, project: projects })
        .from(notifications)
        .innerJoin(projects, eq(projects.id, notifications.projectId))
        .where(and(eq(notifications.userId, r.userId), isNull(notifications.readAt)))
        .limit(100)
      if (!items.length) continue

      // Компания — из проектов, о которых письмо. Без неё localeFor не имеет
      // куда падать: личный язык у большинства не выбран (колонка NOT NULL
      // DEFAULT 'en'), и сводка уходила по-английски в израильскую фирму, где
      // у компании стоит he. Берём первую: дайджест почти всегда про одну
      // компанию, а при нескольких выбор всё равно произволен.
      const companyId = items[0]!.project.companyId

      const byProject = new Map<string, { name: string; lines: string[] }>()
      for (const it of items) {
        const g = byProject.get(it.project.id) ?? { name: it.project.name, lines: [] }
        g.lines.push(`  • ${it.n.title}${it.n.body ? ` — ${it.n.body.slice(0, 120)}` : ''}`)
        byProject.set(it.project.id, g)
      }

      await sendDigestMail({
        to: user.email,
        // Дайджест охватывает несколько проектов, поэтому только личный язык
        // и язык компании: user.locale сам по себе — дефолтный 'en'.
        locale: await localeFor({ userId: user.id, companyId }),
        count: r.count,
        groups: [...byProject.values()].map((g) => ({
          name: g.name,
          lines: g.lines.map((l) => l.trim().replace(/^• /, '')),
        })),
      })

      // отметить время отправки
      if (prefs) {
        await db.update(userNotificationPrefs).set({ lastDigestAt: new Date() }).where(eq(userNotificationPrefs.userId, r.userId))
      } else {
        await db.insert(userNotificationPrefs).values({ userId: r.userId, lastDigestAt: new Date() })
      }
      console.log(`[digest] sent to ${user.email} (${r.count} unread)`)
    }
  } catch (err) {
    console.error('[digest] failed:', err)
  }
}
