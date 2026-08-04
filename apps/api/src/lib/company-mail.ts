import nodemailer, { type Transporter } from 'nodemailer'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companies } from '../db/schema.js'
import { decrypt } from './crypto.js'

// Своя почта компании (SPEC §8.41).
//
// Компании со своей системой не хотят, чтобы их сотрудники получали письма от
// чужого бренда. Дело не только в логотипе: SPF/DKIM нашего домена к их адресу
// отношения не имеют, поэтому письмо про их внутренние задачи и выглядит как
// фишинг, и чаще попадает в спам.
//
// Секреты (пароль SMTP, ключ SendGrid) лежат зашифрованными и наружу не
// отдаются никогда — ни админу компании, ни в API. Расшифровываются только
// здесь, в момент отправки.

export type MailProvider = 'smtp' | 'sendgrid'

export type CompanyMail = {
  provider: MailProvider
  fromEmail: string
  fromName: string | null
  replyTo: string | null
  host: string | null
  port: number | null
  user: string | null
  password: string | null
  apiKey: string | null
}

/**
 * Настройки почты компании — уже расшифрованные. null, если компания шлёт
 * через общую почту (обычный случай).
 */
export async function companyMail(companyId: string): Promise<CompanyMail | null> {
  const c = await db.query.companies.findFirst({
    where: eq(companies.id, companyId),
    columns: {
      mailProvider: true,
      mailFromEmail: true,
      mailFromName: true,
      mailReplyTo: true,
      mailHost: true,
      mailPort: true,
      mailUser: true,
      mailPasswordEnc: true,
      mailApiKeyEnc: true,
    },
  })
  if (!c?.mailProvider || !c.mailFromEmail) return null

  // Битый шифротекст (сменили ENCRYPTION_KEY, правили строку руками) не должен
  // ронять отправку: пусть письмо уйдёт с общей почты, чем не уйдёт вовсе.
  const safe = (v: string | null) => {
    if (!v) return null
    try {
      return decrypt(v)
    } catch {
      console.error(`[company-mail] cannot decrypt secret for company ${companyId}`)
      return null
    }
  }

  const provider = c.mailProvider as MailProvider
  const password = safe(c.mailPasswordEnc)
  const apiKey = safe(c.mailApiKeyEnc)
  if (provider === 'smtp' && (!c.mailHost || !password)) return null
  if (provider === 'sendgrid' && !apiKey) return null

  return {
    provider,
    fromEmail: c.mailFromEmail,
    fromName: c.mailFromName,
    replyTo: c.mailReplyTo,
    host: c.mailHost,
    port: c.mailPort,
    user: c.mailUser,
    password,
    apiKey,
  }
}

// Соединения переиспользуем: на каждое письмо новый TLS-хендшейк — это лишняя
// секунда и лишний повод для сервера счесть нас перебором.
const transports = new Map<string, Transporter>()

/** Сбросить соединение — после смены настроек оно ходит со старым паролем. */
export function dropTransport(companyId: string) {
  transports.get(companyId)?.close()
  transports.delete(companyId)
}

function smtpTransport(companyId: string, m: CompanyMail): Transporter {
  const cached = transports.get(companyId)
  if (cached) return cached
  const port = m.port ?? 587
  const t = nodemailer.createTransport({
    host: m.host!,
    port,
    // 465 — TLS с первого байта, 587 и 25 — STARTTLS поверх открытого.
    secure: port === 465,
    auth: m.user ? { user: m.user, pass: m.password! } : undefined,
    pool: true,
    maxConnections: 3,
  })
  transports.set(companyId, t)
  return t
}

export type MailPayload = {
  to: string
  subject: string
  text: string
  html?: string
  unsubscribeUrl?: string
}

/**
 * Отправка через почту компании. Бросает — вызывающий решает, промолчать или
 * откатиться на общую почту; для проверки настроек ошибка нужна целиком.
 */
export async function sendVia(m: CompanyMail, opts: MailPayload, companyId = 'probe'): Promise<void> {
  const headers = opts.unsubscribeUrl
    ? {
        'List-Unsubscribe': `<${opts.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      }
    : undefined

  if (m.provider === 'sendgrid') {
    // Обычный HTTPS-запрос — SDK ради одной ручки не нужен.
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${m.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: opts.to }], ...(headers ? { headers } : {}) }],
        from: { email: m.fromEmail, ...(m.fromName ? { name: m.fromName } : {}) },
        ...(m.replyTo ? { reply_to: { email: m.replyTo } } : {}),
        subject: opts.subject,
        content: [
          { type: 'text/plain', value: opts.text },
          ...(opts.html ? [{ type: 'text/html', value: opts.html }] : []),
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      // SendGrid отвечает 202 и пустым телом; при ошибке — JSON с причиной,
      // и человеку нужна именно она, а не «не отправилось».
      const body = await res.text().catch(() => '')
      const reason =
        (() => {
          try {
            return (JSON.parse(body) as { errors?: { message?: string }[] }).errors?.[0]?.message
          } catch {
            return null
          }
        })() ?? body.slice(0, 200)
      throw new Error(`SendGrid ${res.status}: ${reason || res.statusText}`)
    }
    return
  }

  await smtpTransport(companyId, m).sendMail({
    from: { name: m.fromName || '', address: m.fromEmail },
    ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    // Явная кодировка: без неё nodemailer промахивается на кириллице и иврите,
    // письмо приходит ромбами. <meta charset> внутри HTML не спасает.
    textEncoding: 'base64',
    ...(headers ? { headers } : {}),
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    ...(opts.html ? { html: opts.html } : {}),
  })
}
