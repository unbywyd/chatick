import { count } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { sendMail } from './mail.js'
import { env } from '../env.js'

// Письма владельцу площадки о том, что происходит снаружи.
//
// Событий два: кто-то зарегистрировался и траты на ИИ перевалили за порог.
// Продукт молодой, и каждая регистрация — новость; когда людей станет много,
// это превратится в сводку, а не в письмо на каждого.
//
// Адрес берётся из ADMIN_EMAIL. Не задан — просто молчим: на своём стенде
// и при локальной разработке такие письма только мешают.

const adminEmail = () => env.ADMIN_EMAIL?.trim() || null

/** Кто-то зарегистрировался. Ошибки глушим: это уведомление, а не часть входа. */
export async function notifySignup(email: string, name: string): Promise<void> {
  const to = adminEmail()
  if (!to) return

  try {
    // Демо-пользователей заводит сид пачками — сообщать о них незачем.
    if (email.endsWith('@demo.chatick.com')) return

    const rows = await db.select({ total: count() }).from(users)
    const total = rows[0]?.total ?? 0

    const who = name?.trim() ? `${name} <${email}>` : email
    const when = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Berlin' })

    await sendMail({
      to,
      subject: `Chatick: новый пользователь — ${email}`,
      text: [
        `Зарегистрировался: ${who}`,
        `Когда: ${when}`,
        `Всего в системе: ${total}`,
        '',
        'Письмо приходит на каждую регистрацию. Отключить — убрать ADMIN_EMAIL из .env.',
      ].join('\n'),
    })
  } catch (e) {
    // Молча: сорванное уведомление не повод ломать человеку вход.
    console.warn('[admin-alert] не удалось отправить письмо о регистрации:', e instanceof Error ? e.message : e)
  }
}

/** Сколько людей уже зарегистрировано — для быстрой проверки из скриптов. */
export async function signupCount(): Promise<number> {
  const rows = await db.select({ total: count() }).from(users)
  return rows[0]?.total ?? 0
}

/**
 * Траты на ИИ за месяц перевалили за порог.
 *
 * Одно письмо на месяц — за этим следит spend-alert.ts, который и зовёт эту
 * функцию. Здесь только текст: разбивка по моделям, чтобы из письма было
 * видно, на что ушло, а не только «много».
 *
 * По-русски и без перевода: это письмо владельцу площадки, а не участнику.
 * Рядом лежит письмо о регистрации — тот же адресат и тот же язык.
 */
export async function notifySpendThreshold(p: {
  to: string
  period: string
  spent: number
  limit: number
  breakdown: { model: string; feature: string; costUsd: number; calls: number }[]
}): Promise<void> {
  try {
    const lines = p.breakdown
      .filter((b) => b.costUsd > 0)
      .map((b) => `  ${b.model} · ${b.feature} — $${b.costUsd.toFixed(4)} (${b.calls} вызовов)`)

    await sendMail({
      to: p.to,
      subject: `Chatick: траты на ИИ за ${p.period} — $${p.spent.toFixed(2)}`,
      text: [
        `За ${p.period} потрачено: $${p.spent.toFixed(4)}`,
        `Порог: $${p.limit}`,
        '',
        lines.length ? 'На что ушло:' : 'Разбивки нет — цены моделей не заданы.',
        ...lines,
        '',
        // Говорим, что письмо больше не придёт: иначе человек ждёт второго и
        // считает, что траты остановились.
        'Это письмо приходит ОДИН раз за месяц — следующее будет только в следующем.',
        'Порог задаётся в AI_SPEND_ALERT_USD, отключается нулём.',
      ].join('\n'),
    })
  } catch (e) {
    console.warn('[admin-alert] не удалось отправить письмо о тратах:', e instanceof Error ? e.message : e)
  }
}
