import { and, eq, inArray, isNull } from 'drizzle-orm'
import { htmlToText } from './sanitize-html.js'
import { db } from '../db/client.js'
import { users, projects, projectMembers, notificationOptOuts, notificationLog, notifications } from '../db/schema.js'
import { sendToUserAnywhere } from '../ws.js'
import { projectLlm, complete } from './llm.js'

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
  | 'note_mention'
  | 'note_reminder'
  | 'timer_running'
  | 'release_status'

/**
 * Извлекает id упомянутых пользователей.
 *
 * Форматов ДВА, и это не избыточность:
 *
 * - `@[Label](id)` — так пишут ассистенты через мост, обычным текстом;
 * - `<span data-type="mention" data-id="…">` — так сохраняет редактор в вебе.
 *
 * Долгое время распознавался только первый. Из-за этого ни одно упоминание,
 * поставленное человеком из интерфейса, никого не уведомляло: люди ставили
 * @Имя, видели его на экране подсвеченным и ждали ответа, которого не будет.
 * Тихо — ошибки нигде не возникало, просто список получателей выходил пустым.
 */
export function extractMentions(text: string): string[] {
  const ids = new Set<string>()
  const add = (raw: string | undefined) => {
    const id = (raw ?? '').trim()
    if (id && id !== 'ai') ids.add(id) // @ai — это диспетчер, не пользователь
  }

  const markdown = /@\[[^\]]*\]\(([^)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = markdown.exec(text))) add(m[1])

  // Атрибуты у разных редакторов идут в разном порядке, поэтому ищем data-id
  // внутри тега со data-type="mention", а не по жёсткой строке целиком.
  const span = /<span\b[^>]*\bdata-type=["']mention["'][^>]*>/gi
  while ((m = span.exec(text))) {
    add(/\bdata-id=["']([^"']+)["']/i.exec(m[0])?.[1])
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
    note_mention: '{actor} mentioned you in a note in {project}',
    note_reminder: 'Reminder from {project}',
    timer_running: 'Your timer in {project} has been running for {hours}h',
    release_status: '{actor} moved {ref} to {status} in {project}',
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
    note_mention: '{actor} упомянул(а) вас в заметке в проекте «{project}»',
    note_reminder: 'Напоминание из проекта «{project}»',
    timer_running: 'Таймер в проекте «{project}» идёт уже {hours} ч',
    release_status: '{actor} перевёл(а) {ref} на стадию «{status}» в проекте «{project}»',
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
    note_mention: '{actor} הזכיר/ה אותך בהערה בפרויקט «{project}»',
    note_reminder: 'תזכורת מפרויקט «{project}»',
    timer_running: 'הטיימר בפרויקט «{project}» פועל כבר {hours} שעות',
    release_status: '{actor} העביר את {ref} לשלב {status} בפרויקט {project}',
    open: 'פתח',
    footer: 'ניתן לנהל התראות בהגדרות הפרויקט.',
  },
}


/**
 * Формулирует, ЧЕГО от человека хотят: «Саша просит прислать APK последней сборки»
 * вместо «Саша упомянул вас». Пишется в notifications.summary после создания —
 * уведомление появляется мгновенно, текст уточняется через секунду.
 */
async function summarizeAsk(
  notificationId: string,
  projectId: string,
  text: string,
  actorName: string,
  lang: Lang,
): Promise<void> {
  const cfg = await projectLlm(projectId, 'notification')
  if (!cfg) return
  const langName = lang === 'ru' ? 'Russian' : lang === 'he' ? 'Hebrew' : 'English'

  const raw = await complete(cfg, {
    system: [
      `Summarise what is being ASKED OF THE READER in ONE short sentence, in ${langName}.`,
      'Focus on the action expected from them. If nothing is asked, describe what happened instead.',
      'No greetings, no quotes, no preamble. Max 100 characters.',
    ].join('\n'),
    user: `${actorName} wrote:\n${text.slice(0, 1500)}`,
    // одно предложение, но на иврите/русском оно дороже — 200 хватало впритык
    maxTokens: 400,
  })
  const summary = raw?.trim().replace(/^["'«]|["'»]$/g, '').slice(0, 200)
  if (!summary) return

  await db.update(notifications).set({ summary }).where(eq(notifications.id, notificationId))
  // подсказать колокольчику, что текст уточнился
  const row = await db.query.notifications.findFirst({ where: eq(notifications.id, notificationId) })
  if (row) sendToUserAnywhere(row.userId, 'notification', { projectId, id: row.id })
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
/** «@[Имя](id)» → «@Имя»: разметка нужна редактору, а не читателю. */
export function stripMentions(text: string): string {
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
  /** относительный путь для ссылки «Открыть», напр. `/c/<company>/p/<id>?msg=<id>` — собирайте его projectPath (SPEC §8.45) */
  link?: string
  /** превью-текст (сообщение/комментарий/заголовок задачи) */
  preview?: string
  /** доп. переменные для шаблона: ref, status */
  vars?: Record<string, string>
  /** на какую сущность ведёт уведомление (для иконки/навигации) */
  entityType?: 'task' | 'message' | 'comment' | 'note' | 'time' | 'release'
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
    // Сначала теги, потом упоминания: разметка обрамляет их снаружи, и в
    // обратном порядке @[…](…) внутри <strong> осталось бы неразобранным.
    const previewText = params.preview ? stripMentions(htmlToText(params.preview)) : ''

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
      const [created] = await db
        .insert(notifications)
        .values({
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
        .returning()

      // «X упомянул вас» не говорит, что от вас нужно. Просим ИИ сформулировать
      // суть запроса — фоном, чтобы задержка модели не тормозила отправку.
      if (created && previewText.trim().length > 15) {
        void summarizeAsk(created.id, projectId, previewText, actorName, lang).catch(() => {})
      }

      // фиксируем в логе дедупа
      if (params.dedupeKey) {
        await db.insert(notificationLog).values({ userId: user.id, projectId, event, dedupeKey }).onConflictDoNothing()
      }

      // realtime: колокольчик и системное уведомление у получателя, где бы
      // он сейчас ни находился — уведомление адресовано ему, а не проекту.
      sendToUserAnywhere(user.id, 'notification', { projectId })
    }
  } catch (err) {
    console.error('[notify] failed:', err)
  }
}

/**
 * Снять уведомление, которое перестало быть правдой.
 *
 * Задачу назначили на человека — он получил «вам назначили задачу». Потом её
 * переназначили на другого, а уведомление продолжало висеть в колокольчике:
 * человек открывал его и обнаруживал задачу, к которой уже не имеет отношения.
 *
 * Удаляем ТОЛЬКО непрочитанное. Прочитанное — часть истории: человек это уже
 * видел, и стирать у него из-под носа то, на что он смотрел, хуже, чем оставить.
 *
 * Заодно снимаем запись из журнала дедупа. Без этого повторное назначение той
 * же задачи тому же человеку проходило молча: ключ уже был занят, и второе
 * уведомление не создавалось никогда.
 */
export async function dropNotice(opts: {
  userId: string
  event: NotificationEvent
  entityId: string
  dedupeKey: string
}): Promise<void> {
  try {
    const removed = await db
      .delete(notifications)
      .where(
        and(
          eq(notifications.userId, opts.userId),
          eq(notifications.event, opts.event),
          eq(notifications.entityId, opts.entityId),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id })

    await db.delete(notificationLog).where(eq(notificationLog.dedupeKey, `${opts.dedupeKey}:${opts.userId}`))

    // Колокольчик пересчитывается у получателя, где бы он ни был.
    if (removed.length) sendToUserAnywhere(opts.userId, 'notification', {})
  } catch (err) {
    console.error('[notify] не удалось снять уведомление:', err)
  }
}
