import { sendMail } from './mail.js'
import { mailLang, renderMail, renderMailText } from './mail-template.js'
import { env } from '../env.js'

// «Вас добавили» — письмо ПОСТФАКТУМ (SPEC-INTEGRATION §3).
//
// Не приглашение: подтверждать нечего, человек уже внутри. Так и просили —
// список людей ведёт сама компания в своей системе, и спрашивать согласия
// второй раз незачем.
//
// Но промолчать нельзя: человек должен узнать, что у него появился доступ, и
// от кого. Иначе первое, что он увидит, — непонятные уведомления из проекта,
// о котором он не слышал.

const STR = {
  en: {
    title: 'You have been added to a project',
    p1: (company: string, project: string) => `You now have access to «${project}» in ${company}.`,
    p2: 'Nothing to confirm — everything is ready, just sign in.',
    action: 'Open the project',
    note: 'Signing in: use Google or ask for a code by email — no password needed.',
  },
  ru: {
    title: 'Вас добавили в проект',
    p1: (company: string, project: string) => `У вас появился доступ к «${project}» в компании ${company}.`,
    p2: 'Подтверждать ничего не нужно — всё готово, просто войдите.',
    action: 'Открыть проект',
    note: 'Вход: через Google или по коду на почту — пароль не нужен.',
  },
  he: {
    title: 'הוספת לפרויקט',
    p1: (company: string, project: string) => `יש לך גישה ל«${project}» בחברת ${company}.`,
    p2: 'אין מה לאשר — הכל מוכן, פשוט התחברו.',
    action: 'פתיחת הפרויקט',
    note: 'כניסה: דרך Google או עם קוד למייל — בלי סיסמה.',
  },
} as const

/**
 * Сообщить человеку, что его добавили. Ошибки глушим: недоставленное письмо не
 * повод отменять уже выданный доступ — он либо есть, либо нет, и это решил не
 * почтовый сервер.
 */
export async function sendAddedToProjectMail(params: {
  to: string
  companyName: string
  projectName: string
  projectId: string
  locale?: string | null
}): Promise<void> {
  try {
    const lang = mailLang(params.locale)
    const s = STR[lang]

    const content = {
      lang,
      title: s.title,
      paragraphs: [s.p1(params.companyName, params.projectName), s.p2],
      action: { label: s.action, url: `${env.APP_URL}/#/p/${params.projectId}` },
      note: s.note,
    }

    await sendMail({
      to: params.to,
      // С домена компании, а не с нашего: письмо про их работу «от Chatick»
      // читается как фишинг.
      projectId: params.projectId,
      subject: `${s.title}: ${params.projectName}`,
      text: renderMailText(content),
      html: renderMail(content),
    })
  } catch (e) {
    console.warn('[mail-added] не удалось отправить:', e instanceof Error ? e.message : e)
  }
}
