import { sendMail } from './mail.js'
import { renderMail, renderMailText, mailLang, type MailLang, type MailContent } from './mail-template.js'
import { env } from '../env.js'

// Все письма продукта в одном месте и в одном стиле (SPEC §8.22).
// Каждое письмо: заголовок, текст, кнопка-действие, подпись. Локализовано.

const fmt = (s: string, v: Record<string, string>) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? '')
const appUrl = () => env.APP_URL.replace(/\/$/, '')

const FOOTER: Record<MailLang, string> = {
  en: 'Chatick — your team workspace.',
  ru: 'Chatick — рабочее пространство вашей команды.',
  he: 'Chatick — מרחב העבודה של הצוות שלך.',
}

/** Отправка по готовому содержимому: и HTML, и text/plain. */
async function send(to: string, subject: string, content: Omit<MailContent, 'footer'>, unsubscribeUrl?: string) {
  const full: MailContent = { ...content, footer: FOOTER[content.lang] }
  await sendMail({
    to,
    subject,
    text: renderMailText(full),
    html: renderMail(full),
    unsubscribeUrl,
  })
}

// --- Добавлен в проект ---------------------------------------------------

const ADDED: Record<MailLang, { subject: string; title: string; body: string; cta: string }> = {
  en: {
    subject: 'You were added to {{project}}',
    title: 'You were added to {{project}}',
    body: 'You now have access to the <b>{{project}}</b> project on Chatick — tasks, files and the team chat.',
    cta: 'Open project',
  },
  ru: {
    subject: 'Вас добавили в проект {{project}}',
    title: 'Вас добавили в проект {{project}}',
    body: 'Теперь у вас есть доступ к проекту <b>{{project}}</b> в Chatick — задачи, файлы и командный чат.',
    cta: 'Открыть проект',
  },
  he: {
    subject: 'נוספת לפרויקט {{project}}',
    title: 'נוספת לפרויקט {{project}}',
    body: 'קיבלת גישה לפרויקט <b>{{project}}</b> ב-Chatick — משימות, קבצים וצ׳אט צוות.',
    cta: 'פתיחת הפרויקט',
  },
}

export async function sendAddedToProjectMail(p: { to: string; locale?: string | null; projectId: string; projectName: string }) {
  const lang = mailLang(p.locale)
  const s = ADDED[lang]
  const v = { project: p.projectName }
  await send(p.to, fmt(s.subject, v), {
    lang,
    title: fmt(s.title, v),
    paragraphs: [fmt(s.body, v)],
    action: { label: s.cta, url: `${appUrl()}/#/p/${p.projectId}` },
  })
}

// --- Исключён из проекта -------------------------------------------------

const REMOVED: Record<MailLang, { subject: string; title: string; body: string }> = {
  en: {
    subject: 'You were removed from {{project}}',
    title: 'You no longer have access to {{project}}',
    body: 'Your access to the <b>{{project}}</b> project on Chatick has been removed. Other projects are unaffected.',
  },
  ru: {
    subject: 'Вас исключили из проекта {{project}}',
    title: 'Доступ к проекту {{project}} закрыт',
    body: 'Ваш доступ к проекту <b>{{project}}</b> в Chatick закрыт. Остальные проекты остаются доступны.',
  },
  he: {
    subject: 'הוסרת מהפרויקט {{project}}',
    title: 'הגישה לפרויקט {{project}} הוסרה',
    body: 'הגישה שלך לפרויקט <b>{{project}}</b> ב-Chatick הוסרה. פרויקטים אחרים לא הושפעו.',
  },
}

export async function sendRemovedFromProjectMail(p: { to: string; locale?: string | null; projectName: string }) {
  const lang = mailLang(p.locale)
  const s = REMOVED[lang]
  const v = { project: p.projectName }
  await send(p.to, fmt(s.subject, v), { lang, title: fmt(s.title, v), paragraphs: [fmt(s.body, v)] })
}

// --- Напоминание о задачах ------------------------------------------------

const REMIND: Record<MailLang, { subject: string; title: string; intro: string; cta: string }> = {
  en: {
    subject: 'Open tasks in {{project}}',
    title: 'Open tasks in {{project}}',
    intro: 'These tasks are still waiting:',
    cta: 'Open tasks',
  },
  ru: {
    subject: 'Незакрытые задачи в {{project}}',
    title: 'Незакрытые задачи в {{project}}',
    intro: 'Эти задачи всё ещё ждут:',
    cta: 'Открыть задачи',
  },
  he: {
    subject: 'משימות פתוחות ב-{{project}}',
    title: 'משימות פתוחות ב-{{project}}',
    intro: 'המשימות הבאות עדיין ממתינות:',
    cta: 'פתיחת המשימות',
  },
}

export async function sendTaskReminderMail(p: {
  to: string
  locale?: string | null
  projectId: string
  projectName: string
  tasks: { number: string; title: string; status: string }[]
}) {
  const lang = mailLang(p.locale)
  const s = REMIND[lang]
  const v = { project: p.projectName }
  const list = p.tasks
    .map((t) => `<b>${t.number}</b> — ${t.title} <span style="color:#8a8a93">[${t.status}]</span>`)
    .join('<br>')
  await send(p.to, fmt(s.subject, v), {
    lang,
    title: fmt(s.title, v),
    paragraphs: [s.intro, list],
    action: { label: s.cta, url: `${appUrl()}/#/p/${p.projectId}/tasks` },
  })
}

// --- Суточный дайджест ----------------------------------------------------

const DIGEST: Record<MailLang, { subject: string; title: string; intro: string; cta: string; unsubscribe: string }> = {
  en: {
    subject: 'Your Chatick digest — {{count}} unread',
    title: 'While you were away',
    intro: 'Here is what happened in your projects:',
    cta: 'Open Chatick',
    unsubscribe: 'You get one digest a day. Turn it off in notification settings.',
  },
  ru: {
    subject: 'Сводка Chatick — {{count}} непрочитанных',
    title: 'Пока вас не было',
    intro: 'Вот что произошло в ваших проектах:',
    cta: 'Открыть Chatick',
    unsubscribe: 'Это одно письмо в сутки. Отключить можно в настройках уведомлений.',
  },
  he: {
    subject: 'סיכום Chatick — {{count}} שלא נקראו',
    title: 'בזמן שלא היית',
    intro: 'הנה מה שקרה בפרויקטים שלך:',
    cta: 'פתיחת Chatick',
    unsubscribe: 'זהו סיכום יומי אחד. ניתן לכבות בהגדרות ההתראות.',
  },
}

export async function sendDigestMail(p: {
  to: string
  locale?: string | null
  count: number
  groups: { name: string; lines: string[] }[]
}) {
  const lang = mailLang(p.locale)
  const s = DIGEST[lang]
  // каждый проект — подзаголовок со списком событий
  const blocks = p.groups.map(
    (g) =>
      `<b>${g.name}</b> <span style="color:#8a8a93">(${g.lines.length})</span><br>` +
      g.lines.map((l) => `<span style="color:#55555d">• ${l}</span>`).join('<br>'),
  )
  const unsubscribeUrl = `${appUrl()}/#/start`
  await send(
    p.to,
    fmt(s.subject, { count: String(p.count) }),
    {
      lang,
      title: s.title,
      paragraphs: [s.intro, ...blocks],
      action: { label: s.cta, url: appUrl() },
      note: s.unsubscribe,
    },
    unsubscribeUrl,
  )
}
