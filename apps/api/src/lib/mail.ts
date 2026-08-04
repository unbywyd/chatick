import nodemailer from 'nodemailer'
import { env } from '../env.js'
import { companyMail, sendVia } from './company-mail.js'

const transport =
  env.SMTP_HOST && env.SMTP_USER
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: false, // 587 STARTTLS
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
      })
    : null

// Домен отправителя должен совпадать с доменом ссылок в письме (chatick.com),
// иначе Gmail считает письмо подозрительным даже при валидных SPF/DKIM.
const FROM_NAME = env.SMTP_FROM_NAME || 'Chatick'

export async function sendMail(opts: {
  to: string
  subject: string
  text: string
  html?: string
  unsubscribeUrl?: string
  /** Компания-отправитель: если у неё настроена своя почта, письмо уйдёт с
   *  её домена. Не указана — общая почта, как раньше. */
  companyId?: string | null
}) {
  // Своя почта компании (SPEC §8.41). При поломке — откат на общую: чужие
  // настройки не должны отрезать людей от писем о входе и приглашениях.
  if (opts.companyId) {
    try {
      const m = await companyMail(opts.companyId)
      if (m) {
        await sendVia(m, opts, opts.companyId)
        return
      }
    } catch (err) {
      console.error(`[mail] company ${opts.companyId} transport failed, falling back:`, err)
    }
  }

  if (!transport) {
    console.log(`[mail:noop] to=${opts.to} subject="${opts.subject}"\n${opts.text}`)
    return
  }
  const { unsubscribeUrl, companyId: _companyId, ...mail } = opts
  try {
    await transport.sendMail({
      from: { name: FROM_NAME, address: env.SMTP_FROM_EMAIL! },
      // Кодировку задаём явно. Без неё nodemailer определяет её сам и на
      // кириллице промахивается: письмо приходит ромбами. Тег <meta charset>
      // внутри HTML не спасает — почтовый клиент смотрит на заголовок письма.
      textEncoding: 'base64',
      // отвечать на noreply бессмысленно — уводим ответы на реальный ящик
      ...(env.SMTP_REPLY_TO ? { replyTo: env.SMTP_REPLY_TO } : {}),
      // почтовики понижают рейтинг рассылкам без штатной отписки
      ...(unsubscribeUrl
        ? {
            headers: {
              'List-Unsubscribe': `<${unsubscribeUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
          }
        : {}),
      ...mail,
    })
  } catch (err) {
    // письмо не должно ронять основной флоу
    console.error('[mail] send failed:', err)
  }
}
