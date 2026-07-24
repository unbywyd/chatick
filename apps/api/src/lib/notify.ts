import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users, projects, projectMembers, notificationOptOuts, notificationLog, notifications } from '../db/schema.js'
import { sendToUser } from '../ws.js'

// Единая точка отправки уведомлений (SPEC §8.9).
// Проверяет: (1) участник проекта, (2) не отписан от события, (3) не дубль.
// Письмо не должно ронять основной флоу — все ошибки глушатся.

export type NotificationEvent =
  | 'chat_mention'
  | 'task_mention'
  | 'comment_mention'
  | 'task_assigned'
  | 'task_status'
  | 'task_comment'

/** Извлекает id упомянутых пользователей из разметки `@[Label](id)`. */
export function extractMentions(text: string): string[] {
  const ids = new Set<string>()
  const re = /@\[[^\]]*\]\(([^)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const id = (m[1] ?? '').trim()
    if (id && id !== 'ai') ids.add(id) // @ai — это диспетчер, не пользователь
  }
  return [...ids]
}

// Мини-i18n для писем — по locale получателя (совпадает с ключами фронта).
type Lang = 'en' | 'ru' | 'he'
const STR: Record<Lang, Record<string, string>> = {
  en: {
    chat_mention: '{actor} mentioned you in {project}',
    task_mention: '{actor} mentioned you in a task in {project}',
    comment_mention: '{actor} mentioned you in a comment in {project}',
    task_assigned: '{actor} assigned you a task in {project}',
    task_status: 'Task {ref} status changed to {status} in {project}',
    task_comment: '{actor} commented on {ref} in {project}',
    open: 'Open',
    footer: 'You can manage notifications in your project settings.',
  },
  ru: {
    chat_mention: '{actor} упомянул(а) вас в чате «{project}»',
    task_mention: '{actor} упомянул(а) вас в задаче в проекте «{project}»',
    comment_mention: '{actor} упомянул(а) вас в комментарии в проекте «{project}»',
    task_assigned: '{actor} назначил(а) вам задачу в проекте «{project}»',
    task_status: 'Статус задачи {ref} изменён на «{status}» в проекте «{project}»',
    task_comment: '{actor} прокомментировал(а) {ref} в проекте «{project}»',
    open: 'Открыть',
    footer: 'Управлять уведомлениями можно в настройках проекта.',
  },
  he: {
    chat_mention: '{actor} הזכיר/ה אותך בצ׳אט «{project}»',
    task_mention: '{actor} הזכיר/ה אותך במשימה בפרויקט «{project}»',
    comment_mention: '{actor} הזכיר/ה אותך בתגובה בפרויקט «{project}»',
    task_assigned: '{actor} הקצה/תה לך משימה בפרויקט «{project}»',
    task_status: 'סטטוס המשימה {ref} שונה ל-«{status}» בפרויקט «{project}»',
    task_comment: '{actor} הגיב/ה על {ref} בפרויקט «{project}»',
    open: 'פתח',
    footer: 'ניתן לנהל התראות בהגדרות הפרויקט.',
  },
}

function tr(lang: Lang, key: string, vars: Record<string, string>): string {
  const s = STR[lang]?.[key] ?? STR.en[key] ?? key
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')
}

function langOf(locale: string | null | undefined): Lang {
  const l = (locale || 'en').slice(0, 2)
  return l === 'ru' || l === 'he' ? l : 'en'
}

/** Убирает mention-разметку из текста для читаемого превью в письме. */
function stripMentions(text: string): string {
  return text.replace(/@\[([^\]]*)\]\([^)]+\)/g, '@$1').replace(/\s+/g, ' ').trim()
}

type NotifyParams = {
  projectId: string
  event: NotificationEvent
  /** id получателей (будут отфильтрованы: только участники, не отписаны, не дубль) */
  recipientIds: string[]
  /** кто инициировал — исключается из получателей (не слать самому себе) */
  actorId?: string | null
  actorName?: string
  /** ключ дедупа (без него дедуп по event+project+recipient — раз в вызов) */
  dedupeKey?: string
  /** относительный путь для ссылки «Открыть», напр. `/p/<id>?msg=<id>` */
  link?: string
  /** превью-текст (сообщение/комментарий/заголовок задачи) */
  preview?: string
  /** доп. переменные для шаблона: ref, status */
  vars?: Record<string, string>
  /** на какую сущность ведёт уведомление (для иконки/навигации) */
  entityType?: 'task' | 'message' | 'comment'
  entityId?: string
}

export async function notify(params: NotifyParams): Promise<void> {
  try {
    const { projectId, event, actorId } = params
    const recipientIds = [...new Set(params.recipientIds)].filter((id) => id && id !== actorId)
    if (recipientIds.length === 0) return

    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
    if (!project) return

    // только реальные участники проекта
    const members = await db.query.projectMembers.findMany({
      where: and(eq(projectMembers.projectId, projectId), inArray(projectMembers.userId, recipientIds)),
    })
    const memberIds = new Set(members.map((m) => m.userId))
    let targets = recipientIds.filter((id) => memberIds.has(id))
    if (targets.length === 0) return

    // отписки от этого события
    const optOuts = await db.query.notificationOptOuts.findMany({
      where: and(
        eq(notificationOptOuts.projectId, projectId),
        eq(notificationOptOuts.event, event),
        inArray(notificationOptOuts.userId, targets),
      ),
    })
    const optedOut = new Set(optOuts.map((o) => o.userId))
    targets = targets.filter((id) => !optedOut.has(id))
    if (targets.length === 0) return

    const recipients = await db.query.users.findMany({ where: inArray(users.id, targets) })
    const actorName = params.actorName || 'Someone'
    const previewText = params.preview ? stripMentions(params.preview) : ''

    for (const user of recipients) {
      // дедуп: один и тот же dedupeKey не создаём повторно
      const dedupeKey = params.dedupeKey ? `${params.dedupeKey}:${user.id}` : `${event}:${projectId}:${user.id}:${Date.now()}`
      if (params.dedupeKey) {
        const exists = await db.query.notificationLog.findFirst({ where: eq(notificationLog.dedupeKey, dedupeKey) })
        if (exists) continue
      }

      const lang = langOf(user.locale)
      const vars = { actor: actorName, project: project.name, ...(params.vars || {}) }

      // ГЛАВНОЕ: создаём ВНУТРЕННЕЕ уведомление (SPEC §8.22). Почта — суточным дайджестом.
      await db.insert(notifications).values({
        userId: user.id,
        projectId,
        event,
        actorId: actorId ?? null,
        title: tr(lang, event, vars),
        body: previewText.slice(0, 500),
        link: params.link ?? '',
        entityType: params.entityType ?? null,
        entityId: params.entityId ?? null,
      })

      // фиксируем в логе дедупа
      if (params.dedupeKey) {
        await db.insert(notificationLog).values({ userId: user.id, projectId, event, dedupeKey }).onConflictDoNothing()
      }

      // realtime: подсветить колокольчик у получателя, если он онлайн
      sendToUser(projectId, user.id, 'notification', { projectId })
    }
  } catch (err) {
    console.error('[notify] failed:', err)
  }
}
