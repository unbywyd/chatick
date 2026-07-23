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

export async function sendMail(opts: { to: string; subject: string; text: string }) {
  if (!transport) {
    console.log(`[mail:noop] to=${opts.to} subject="${opts.subject}"\n${opts.text}`)
    return
  }
  try {
    await transport.sendMail({ from: env.SMTP_FROM_EMAIL, ...opts })
  } catch (err) {
    // письмо не должно ронять основной флоу
    console.error('[mail] send failed:', err)
  }
}
