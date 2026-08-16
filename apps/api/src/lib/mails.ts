import { sendMail } from './mail.js'
import { companyOf, projectUrl } from './links.js'
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
/**
 * Общая отправка. Компанию или проект пробрасываем всегда, когда они известны:
 * без них письмо уходит с нашего домена, хотя у компании настроена своя почта.
 */
async function send(
  to: string,
  subject: string,
  content: Omit<MailContent, 'footer'>,
  opts?: { unsubscribeUrl?: string; companyId?: string | null; projectId?: string | null },
) {
  const full: MailContent = { ...content, footer: FOOTER[content.lang] }
  await sendMail({
    to,
    subject,
    text: renderMailText(full),
    html: renderMail(full),
    unsubscribeUrl: opts?.unsubscribeUrl,
    companyId: opts?.companyId,
    projectId: opts?.projectId,
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
  // Адрес проекта включает компанию (SPEC §8.45). Здесь оставался старый
  // формат `/#/p/<id>` — такого маршрута во фронте нет, и человек, пришедший
  // из письма, открывал белый экран: роутер не находит путь и не рисует
  // ничего. Собираем адрес общим projectUrl, как во всех остальных письмах.
  const companyId = (await companyOf(p.projectId)) ?? ''
  await send(
    p.to,
    fmt(s.subject, v),
    {
      lang,
      title: fmt(s.title, v),
      paragraphs: [fmt(s.body, v)],
      action: { label: s.cta, url: projectUrl(appUrl(), companyId, p.projectId) },
    },
    // С почты компании, а не с нашей: письмо про их проект «от Chatick»
    // читается как чужое. Остальные письма о проекте уже уходят так.
    { projectId: p.projectId },
  )
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

// --- Проект или компания удалены ------------------------------------------
//
// Человек должен узнать, а не обнаружить пропажу: он мог держать там задачи,
// файлы и переписку. Пишем прямо, что удалено безвозвратно, и называем того,
// кто это сделал — вопросы будут к нему, а не к нам.

const DELETED: Record<MailLang, { subject: string; title: string; body: string; gone: string; ask: string }> = {
  en: {
    subject: '{{what}} «{{name}}» has been deleted',
    title: '{{what}} «{{name}}» is gone',
    body: '{{actor}} deleted it. We are sorry — this cannot be undone.',
    gone: 'Tasks, chat history, documents, notes, files and tracked hours were removed along with it.',
    ask: 'If this looks like a mistake, talk to {{actor}} — only they can create it anew.',
  },
  ru: {
    subject: '{{what}} «{{name}}» удалён',
    title: '{{what}} «{{name}}» больше нет',
    body: '{{actor}} удалил его. Нам жаль — восстановить это нельзя.',
    gone: 'Вместе с ним исчезли задачи, переписка, документы, заметки, файлы и учтённые часы.',
    ask: 'Если это ошибка, поговорите с {{actor}} — создать заново может только он.',
  },
  he: {
    subject: '{{what}} «{{name}}» נמחק',
    title: '{{what}} «{{name}}» כבר לא קיים',
    body: '{{actor}} מחק אותו. מצטערים — לא ניתן לשחזר.',
    gone: 'יחד איתו נמחקו משימות, היסטוריית צ׳אט, מסמכים, רשומות, קבצים ושעות שנרשמו.',
    ask: 'אם זו טעות, דברו עם {{actor}} — רק הוא יכול ליצור מחדש.',
  },
}

const WHAT: Record<MailLang, { project: string; company: string }> = {
  en: { project: 'Project', company: 'Company' },
  ru: { project: 'Проект', company: 'Компания' },
  he: { project: 'הפרויקט', company: 'החברה' },
}

/**
 * Письмо об удалении проекта или компании.
 * Отправляем каждому участнику, кроме того, кто удалил: он и так знает.
 */
export async function sendDeletedMail(p: {
  to: string
  locale?: string | null
  kind: 'project' | 'company'
  name: string
  actorName: string
  /** Проекта уже нет — компанию узнать неоткуда, передаём снаружи. */
  companyId?: string | null
}) {
  const lang = mailLang(p.locale)
  const s = DELETED[lang]
  const v = { what: WHAT[lang][p.kind], name: p.name, actor: p.actorName }
  await send(
    p.to,
    fmt(s.subject, v),
    { lang, title: fmt(s.title, v), paragraphs: [fmt(s.body, v), fmt(s.gone, v), fmt(s.ask, v)] },
    // Компания ещё жива, когда удаляют проект; при удалении самой компании
    // её почта уже недоступна — письмо уйдёт с общей, и это верно.
    { companyId: p.kind === 'project' ? p.companyId : null },
  )
}

// --- Обращение из формы обратной связи --------------------------------------
//
// Письмо админам, а не пользователю: он и так знает, что написал. Здесь важно
// не оформление, а чтобы всё нужное было на виду — тема, кто, откуда, текст.

const FEEDBACK_TOPIC: Record<MailLang, Record<string, string>> = {
  en: { question: 'Question', bug: 'Bug', feature: 'Feature request', billing: 'Billing', other: 'Other' },
  ru: { question: 'Вопрос', bug: 'Ошибка', feature: 'Предложение', billing: 'Оплата', other: 'Другое' },
  he: { question: 'שאלה', bug: 'תקלה', feature: 'הצעה', billing: 'תשלום', other: 'אחר' },
}

const FEEDBACK: Record<MailLang, { subject: string; title: string; from: string; guest: string; user: string }> = {
  en: {
    subject: '[{{topic}}] message from {{name}}',
    title: 'New message: {{topic}}',
    from: 'From: {{name}} <{{email}}>',
    guest: 'Not signed in — reply by email.',
    user: 'Registered user.',
  },
  ru: {
    subject: '[{{topic}}] обращение от {{name}}',
    title: 'Новое обращение: {{topic}}',
    from: 'От кого: {{name}} <{{email}}>',
    guest: 'Не авторизован — отвечать по почте.',
    user: 'Зарегистрированный пользователь.',
  },
  he: {
    subject: '[{{topic}}] פנייה מ־{{name}}',
    title: 'פנייה חדשה: {{topic}}',
    from: 'מאת: {{name}} <{{email}}>',
    guest: 'לא מחובר — להשיב במייל.',
    user: 'משתמש רשום.',
  },
}

export async function sendFeedbackMail(p: {
  to: string
  locale?: string | null
  id: string
  topic: string
  body: string
  name: string
  email: string
  registered: boolean
  /** приложен ли скриншот — ссылку кладём в письмо, иначе картинку не увидят */
  hasScreenshot?: boolean
}) {
  const lang = mailLang(p.locale)
  const s = FEEDBACK[lang]
  const topic = FEEDBACK_TOPIC[lang][p.topic] ?? p.topic
  const v = { topic, name: p.name || p.email, email: p.email }
  const shot = p.hasScreenshot
    ? `${process.env.API_PUBLIC_URL || 'https://api.chatick.com'}/api/v1/about/feedback/${p.id}/screenshot`
    : null
  await send(p.to, fmt(s.subject, v), {
    lang,
    title: fmt(s.title, v),
    // Тело разбиваем по пустым строкам: в письме абзацы задаются массивом, и
    // целиком оно склеивалось в одну простыню. У репортов ассистента там ещё
    // и раздел «что пытались сделать» — он прилипал к концу предыдущей фразы.
    paragraphs: [fmt(s.from, v), p.registered ? s.user : s.guest, ...p.body.split(/\n{2,}/).filter(Boolean)],
    ...(shot ? { action: { label: 'Screenshot', url: shot } } : {}),
  })
}

/**
 * Новый отзыв с сайта — письмо администраторам.
 *
 * Только на английском: получатель здесь один — тот, кто ведёт площадку, и
 * гадать про его язык незачем.
 */
export async function sendReviewMail(p: {
  to: string
  id: string
  name: string
  email: string
  rating: number
  body: string
}) {
  const stars = '★'.repeat(Math.max(1, Math.min(5, p.rating))) + '☆'.repeat(5 - Math.max(1, Math.min(5, p.rating)))
  await send(p.to, `New review from ${p.name} (${p.rating}/5)`, {
    lang: 'en',
    title: 'New review awaiting moderation',
    paragraphs: [
      `${p.name} <${p.email}> left a review: ${stars}`,
      p.body,
      'It is not visible on the site yet — publish it once you have read it.',
    ],
  })
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
  const companyId = await companyOf(p.projectId)
  await send(
    p.to,
    fmt(s.subject, v),
    {
      lang,
      title: fmt(s.title, v),
      paragraphs: [s.intro, list],
      // Адрес проекта включает компанию (SPEC §8.45).
      action: { label: s.cta, url: projectUrl(appUrl(), companyId ?? '', p.projectId, '/tasks') },
    },
    { projectId: p.projectId },
  )
}

// --- Суточный дайджест ----------------------------------------------------

const DIGEST: Record<
  MailLang,
  { subject: string; title: string; intro: string; cta: string; unsubscribe: string; more: string }
> = {
  en: {
    subject: 'Your Chatick digest — {{count}} unread',
    title: 'While you were away',
    intro: 'Here is what happened in your projects:',
    cta: 'Open Chatick',
    unsubscribe: 'One email a day. <a href="{{url}}" style="color:#6b6b73">Turn it off</a>.',
    more: 'and {{n}} more',
  },
  ru: {
    subject: 'Сводка Chatick — {{count}} непрочитанных',
    title: 'Пока вас не было',
    intro: 'Вот что произошло в ваших проектах:',
    cta: 'Открыть Chatick',
    unsubscribe: 'Одно письмо в сутки. <a href="{{url}}" style="color:#6b6b73">Отключить</a>.',
    more: 'и ещё {{n}}',
  },
  he: {
    subject: 'סיכום Chatick — {{count}} שלא נקראו',
    title: 'בזמן שלא היית',
    intro: 'הנה מה שקרה בפרויקטים שלך:',
    cta: 'פתיחת Chatick',
    unsubscribe: 'מייל אחד ביום. <a href="{{url}}" style="color:#6b6b73">לכבות</a>.',
    more: 'ועוד {{n}}',
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

  // Показываем по нескольку событий на проект, остальное — счётчиком.
  //
  // Раньше в письмо вываливались все непрочитанные: у человека с 83
  // уведомлениями получалась простыня на несколько экранов, которую он просто
  // не читал — и пожаловался ровно на это. Сводка должна отвечать «где меня
  // ждут», а не пересказывать каждое событие: за подробностями всё равно идут
  // в приложение, и кнопка для этого прямо под текстом.
  const PER_PROJECT = 4
  const blocks = p.groups.map((g) => {
    const shown = g.lines.slice(0, PER_PROJECT)
    const rest = g.lines.length - shown.length
    const tail = rest > 0 ? `<br><span style="color:#8a8a93">${fmt(s.more, { n: String(rest) })}</span>` : ''
    return (
      `<b>${g.name}</b> <span style="color:#8a8a93">(${g.lines.length})</span><br>` +
      shown.map((l) => `<span style="color:#55555d">• ${l}</span>`).join('<br>') +
      tail
    )
  })
  // Прямо на экран, где дайджест выключается. Раньше вело на /#/start —
  // человек попадал на список компаний и не понимал, куда дальше: настройка
  // личная, одна на все проекты, и искать её внутри проекта неоткуда.
  const unsubscribeUrl = `${appUrl()}/#/settings/notifications`
  await send(
    p.to,
    fmt(s.subject, { count: String(p.count) }),
    {
      lang,
      title: s.title,
      paragraphs: [s.intro, ...blocks],
      action: { label: s.cta, url: appUrl() },
      note: fmt(s.unsubscribe, { url: unsubscribeUrl }),
    },
    { unsubscribeUrl },
  )
}
