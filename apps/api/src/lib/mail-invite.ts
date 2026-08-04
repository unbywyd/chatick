import { sendMail } from './mail.js'
import { renderMail, renderMailText, mailLang, type MailLang } from './mail-template.js'
import { env } from '../env.js'

// Письмо-приглашение в компанию. Язык берём у приглашающего: получателя
// в системе ещё нет, его локаль неизвестна.

const STR: Record<
  MailLang,
  { subject: string; title: string; intro: string; asRole: string; cta: string; note: string; footer: string }
> = {
  en: {
    subject: 'Invitation to {{company}} on Chatick',
    title: 'You have been invited to {{company}}',
    intro: 'You have been invited to join the <b>{{company}}</b> workspace on Chatick.',
    asRole: 'Your role: <b>{{role}}</b>.',
    cta: 'Accept invitation',
    note: 'If you do not have an account yet, sign in with Google using this email address.',
    footer: 'You received this email because someone invited you to Chatick.',
  },
  ru: {
    subject: 'Приглашение в {{company}} на Chatick',
    title: 'Вас пригласили в {{company}}',
    intro: 'Вас пригласили присоединиться к рабочему пространству <b>{{company}}</b> в Chatick.',
    asRole: 'Ваша роль: <b>{{role}}</b>.',
    cta: 'Принять приглашение',
    note: 'Если у вас ещё нет аккаунта — войдите через Google с этим адресом почты.',
    footer: 'Вы получили это письмо, потому что вас пригласили в Chatick.',
  },
  he: {
    subject: 'הזמנה ל-{{company}} ב-Chatick',
    title: 'הוזמנת ל-{{company}}',
    intro: 'הוזמנת להצטרף למרחב העבודה <b>{{company}}</b> ב-Chatick.',
    asRole: 'התפקיד שלך: <b>{{role}}</b>.',
    cta: 'קבלת ההזמנה',
    note: 'אם עדיין אין לך חשבון — התחבר/י עם Google בכתובת אימייל זו.',
    footer: 'קיבלת מייל זה כי הוזמנת ל-Chatick.',
  },
}

const ROLE: Record<MailLang, Record<string, string>> = {
  en: { admin: 'Admin', manager: 'Manager', member: 'Member' },
  ru: { admin: 'Админ', manager: 'Менеджер', member: 'Участник' },
  he: { admin: 'מנהל', manager: "מנג'ר", member: 'חבר' },
}

const fmt = (s: string, v: Record<string, string>) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? '')

export async function sendInviteMail(params: {
  to: string
  companyName: string
  role: string
  token: string
  /** локаль приглашающего — получателя в системе ещё нет */
  inviterLocale?: string | null
  /** Письмо уходит с домена компании, если он у неё настроен. */
  companyId?: string | null
}) {
  const lang = mailLang(params.inviterLocale)
  const s = STR[lang]
  const vars = { company: params.companyName, role: ROLE[lang][params.role] ?? params.role }

  const content = {
    lang,
    title: fmt(s.title, vars),
    paragraphs: [fmt(s.intro, vars), fmt(s.asRole, vars)],
    action: { label: s.cta, url: `${env.APP_URL}/#/invite/${params.token}` },
    note: s.note,
    footer: s.footer,
  }

  await sendMail({
    to: params.to,
    companyId: params.companyId,
    subject: fmt(s.subject, vars),
    text: renderMailText(content),
    html: renderMail(content),
  })
}
