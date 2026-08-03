import { randomInt, timingSafeEqual, createHash } from 'node:crypto'
import { sendMail } from './mail.js'
import { mailLang, renderMail, renderMailText } from './mail-template.js'

// Вход по коду на почту (SPEC §8.38).
//
// Пароля у нас нет и не будет: нечего забывать, нечего красть, нечего хранить.
// Владение почтой — то же доказательство личности, что и «забыли пароль», но
// без хранилища паролей и без письма со сбросом.
//
// Коды живут в памяти процесса: они одноразовые и короткие, переживать
// перезапуск им незачем — человек просто запросит новый.

type Pending = {
  hash: string
  expiresAt: number
  /** Сколько раз ошиблись. Пять — и код сгорает: иначе шестизначный код
   *  подбирается перебором за минуты. */
  attempts: number
  /** Когда код отправлен — чтобы не слать письма чаще, чем раз в минуту. */
  sentAt: number
}

const codes = new Map<string, Pending>()

const TTL_MS = 10 * 60_000
const RESEND_MS = 60_000
const MAX_ATTEMPTS = 5

/** Ключ — почта в нижнем регистре: «Ivan@» и «ivan@» это один человек. */
const keyOf = (email: string) => email.trim().toLowerCase()

// Храним хеш, а не сам код: дамп памяти или случайный лог не должны выдавать
// действующий код.
const hashOf = (code: string) => createHash('sha256').update(code).digest('hex')

function sweep() {
  const now = Date.now()
  for (const [k, v] of codes) if (v.expiresAt < now) codes.delete(k)
}

export type SendResult = { ok: true; expiresInSec: number } | { ok: false; retryInSec: number }

/**
 * Выслать код. Возвращает «подождите», если письмо уже уходило минуту назад:
 * иначе кнопкой «отправить ещё» можно завалить чужой ящик.
 */
export async function sendLoginCode(email: string, locale?: string | null): Promise<SendResult> {
  sweep()
  const key = keyOf(email)
  const existing = codes.get(key)
  if (existing && Date.now() - existing.sentAt < RESEND_MS) {
    return { ok: false, retryInSec: Math.ceil((RESEND_MS - (Date.now() - existing.sentAt)) / 1000) }
  }

  // randomInt из node:crypto, а не Math.random: последний предсказуем, и по
  // нескольким кодам можно вычислить следующий.
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  codes.set(key, { hash: hashOf(code), expiresAt: Date.now() + TTL_MS, attempts: 0, sentAt: Date.now() })

  const lang = mailLang(locale)
  const T = {
    en: {
      title: 'Your sign-in code',
      p1: `Your code for Chatick: ${code}`,
      p2: 'It works for 10 minutes and once only.',
      note: 'Did not ask for it? Then someone typed your address by mistake — you can ignore this email, nobody got in.',
    },
    ru: {
      title: 'Код для входа',
      p1: `Ваш код для Chatick: ${code}`,
      p2: 'Он действует 10 минут и только один раз.',
      note: 'Не запрашивали? Значит кто-то ошибся адресом — письмо можно не читать, в аккаунт никто не вошёл.',
    },
    he: {
      title: 'קוד לכניסה',
      p1: `הקוד שלך ל-Chatick: ${code}`,
      p2: 'הוא תקף ל-10 דקות ולפעם אחת בלבד.',
      note: 'לא ביקשת? כנראה שמישהו טעה בכתובת — אפשר להתעלם מהמייל, אף אחד לא נכנס לחשבון.',
    },
  }[lang]

  const content = { lang, title: T.title, paragraphs: [T.p1, T.p2], note: T.note }
  await sendMail({
    to: email,
    subject: `${T.title}: ${code}`,
    text: renderMailText(content),
    html: renderMail(content),
  })

  return { ok: true, expiresInSec: TTL_MS / 1000 }
}

export type VerifyResult = 'ok' | 'wrong' | 'expired' | 'too-many'

/** Проверить код. Верный — сгорает сразу, повторно им не войти. */
export function verifyLoginCode(email: string, code: string): VerifyResult {
  sweep()
  const key = keyOf(email)
  const pending = codes.get(key)
  if (!pending || pending.expiresAt < Date.now()) return 'expired'

  if (pending.attempts >= MAX_ATTEMPTS) {
    codes.delete(key)
    return 'too-many'
  }

  const given = Buffer.from(hashOf(code.trim()))
  const want = Buffer.from(pending.hash)
  // Сравнение постоянного времени: обычное «===» отвечает тем быстрее, чем
  // раньше расходятся строки, и по времени ответа код подбирается посимвольно.
  const same = given.length === want.length && timingSafeEqual(given, want)

  if (!same) {
    pending.attempts++
    return 'wrong'
  }

  codes.delete(key)
  return 'ok'
}
