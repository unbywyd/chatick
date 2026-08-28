import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companyMembers, notifications, projectMembers, users } from '../db/schema.js'
import { sendMail } from './mail.js'
import { htmlToText } from './sanitize-html.js'
import { sendToUserAnywhere } from '../ws.js'
import { env } from '../env.js'

/**
 * Объявление компании — то, что не выросло ни из задачи, ни из проекта.
 *
 * «Завтра отдыхаем», «изменили политику отпусков», «сервер переезжает в
 * субботу». Сейчас такое пишут в мессенджер, а через неделю никто не помнит,
 * кому написали и дошло ли до всех.
 *
 * Почему не через notify(): та функция проверяет членство В ПРОЕКТЕ и
 * уважает отписки — и то, и другое здесь вредно. Человек, не состоящий ни в
 * одном проекте, объявление получить обязан; отписаться от «завтра отдыхаем»
 * нельзя, иначе это перестаёт быть объявлением.
 *
 * Отсюда и отдельная функция, а не флаг в notify: у неё другие правила, и
 * смешать их значило бы однажды применить не те.
 */

export type AnnounceTarget =
  /** Всем сотрудникам компании. */
  | { kind: 'company' }
  /** Команде одного проекта — «завтра стенд не работает». */
  | { kind: 'project'; projectId: string }
  /** Названным поимённо. */
  | { kind: 'users'; userIds: string[] }

/** Кому уйдёт объявление. Возвращает id, отсеяв автора: себе не шлём. */
export async function resolveRecipients(
  companyId: string,
  target: AnnounceTarget,
  actorId: string,
): Promise<string[]> {
  let ids: string[] = []

  if (target.kind === 'company') {
    const rows = await db
      .select({ userId: companyMembers.userId })
      .from(companyMembers)
      .where(eq(companyMembers.companyId, companyId))
    ids = rows.map((r) => r.userId)
  } else if (target.kind === 'project') {
    const rows = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, target.projectId))
    ids = rows.map((r) => r.userId)
  } else {
    // Поимённо — но только своих: чужой id в списке отправил бы объявление
    // компании человеку со стороны.
    const rows = await db
      .select({ userId: companyMembers.userId })
      .from(companyMembers)
      .where(and(eq(companyMembers.companyId, companyId), inArray(companyMembers.userId, target.userIds)))
    ids = rows.map((r) => r.userId)
  }

  return [...new Set(ids)].filter((id) => id !== actorId)
}

/**
 * Разослать объявление.
 *
 * Письмо — по флагу, а не всегда: «завтра отдыхаем» стоит письма, «в пятницу
 * пицца» — вряд ли. Решает тот, кто пишет, потому что только он знает
 * срочность.
 *
 * Ошибку письма глушим: объявление уже в приложении, и сорванная отправка не
 * повод терять его целиком.
 */
export async function announce(input: {
  companyId: string
  companyName: string
  actorId: string
  actorName: string
  title: string
  body?: string
  target: AnnounceTarget
  /** Слать ли письмо. По умолчанию нет: колокольчика хватает почти всегда. */
  email?: boolean
}): Promise<{ sent: number; emailed: number }> {
  const recipientIds = await resolveRecipients(input.companyId, input.target, input.actorId)
  if (!recipientIds.length) return { sent: 0, emailed: 0 }

  const preview = input.body ? htmlToText(input.body).slice(0, 500) : ''
  const rows = recipientIds.map((userId) => ({
    userId,
    // Проекта нет намеренно: объявление к нему не привязано. Компания есть —
    // инбокс группирует по ней.
    projectId: null,
    companyId: input.companyId,
    event: 'announcement' as const,
    actorId: input.actorId,
    title: input.title.slice(0, 300),
    body: preview,
    // Ссылка ведёт на инбокс: открывать нечего, объявление и есть текст.
    link: '/inbox',
    entityType: 'announcement',
    entityId: null,
  }))
  await db.insert(notifications).values(rows)

  // Колокольчик у каждого, где бы он ни был.
  for (const userId of recipientIds) sendToUserAnywhere(userId, 'notification', {})

  let emailed = 0
  if (input.email) {
    const people = await db.query.users.findMany({ where: inArray(users.id, recipientIds) })
    for (const person of people) {
      try {
        await sendMail({
          to: person.email,
          subject: `${input.companyName}: ${input.title.slice(0, 120)}`,
          text: [
            input.title,
            '',
            preview,
            '',
            `— ${input.actorName}, ${input.companyName}`,
            '',
            // Говорим прямо, что отписаться нельзя: иначе человек будет
            // искать настройку, которой нет.
            'Объявления компании приходят всем и не отключаются.',
            `${env.APP_URL}/#/inbox`,
          ].join('\n'),
          companyId: input.companyId,
        })
        emailed++
      } catch (err) {
        console.warn('[announce] письмо не ушло:', person.email, err instanceof Error ? err.message : err)
      }
    }
  }

  return { sent: recipientIds.length, emailed }
}
