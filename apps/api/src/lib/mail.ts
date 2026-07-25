import nodemailer from 'nodemailer'
import { env } from '../env.js'

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
}) {
  if (!transport) {
    console.log(`[mail:noop] to=${opts.to} subject="${opts.subject}"\n${opts.text}`)
    return
  }
  const { unsubscribeUrl, ...mail } = opts
  try {
    await transport.sendMail({
      from: { name: FROM_NAME, address: env.SMTP_FROM_EMAIL! },
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
