import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notifications, projects, users, userNotificationPrefs } from '../db/schema.js'
import { sendDigestMail } from './mails.js'
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

      // непрочитанные этого юзера, сгруппированные по проекту
      const items = await db
        .select({ n: notifications, project: projects })
        .from(notifications)
        .innerJoin(projects, eq(projects.id, notifications.projectId))
        .where(and(eq(notifications.userId, r.userId), isNull(notifications.readAt)))
        .limit(100)
      if (!items.length) continue

      const byProject = new Map<string, { name: string; lines: string[] }>()
      for (const it of items) {
        const g = byProject.get(it.project.id) ?? { name: it.project.name, lines: [] }
        g.lines.push(`  • ${it.n.title}${it.n.body ? ` — ${it.n.body.slice(0, 120)}` : ''}`)
        byProject.set(it.project.id, g)
      }

      await sendDigestMail({
        to: user.email,
        locale: user.locale,
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
