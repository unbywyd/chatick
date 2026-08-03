import { count } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { sendMail } from './mail.js'
import { env } from '../env.js'

// Письма владельцу площадки о том, что происходит снаружи.
//
// Пока событие одно: кто-то зарегистрировался. Продукт молодой, и каждая
// регистрация — новость; когда людей станет много, это превратится в сводку,
// а не в письмо на каждого.
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
