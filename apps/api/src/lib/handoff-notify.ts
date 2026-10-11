import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notifications, tasks, users, type HandoffAction } from '../db/schema.js'
import { notify } from './notify.js'
import { companyOf, projectPath } from './links.js'
import { lastReviewFrom, type HandoffRow } from './ball.js'
import { sendToUserAnywhere } from '../ws.js'

/**
 * Уведомления из журнала передач (v2): одно на ход, с запиской.
 *
 * Раньше человек узнавал о задаче из двух-трёх уведомлений сразу («назначили»,
 * «статус сменён», «прокомментировал») и ни одно не говорило, чего от него
 * хотят. Передача говорит: «вернул на доработку — кнопка уехала», «спрашивает —
 * какой цвет?». Записка и есть тело уведомления.
 *
 * Работает для ходов (POST /handoff в вебе и мосте). Старые пути — правка
 * статуса и исполнителя — уведомляют по-прежнему (task_assigned/task_status):
 * старые клиенты на них рассчитаны, и двойных уведомлений быть не должно.
 */

/**
 * Кому сказать о ходе. Чистая функция — правило проверяется тестом.
 *
 *   review, return, ask, answer, pass, reopen — тому, к кому ушёл мяч;
 *   accept — тому, кто сдавал работу: мяч остаётся у владельца, но ждал
 *            ответа именно сдавший;
 *   cancel, take — прежнему держателю: он работал над задачей, и ему надо
 *            перестать;
 *   wait_client, client_replied, create — никому: мяч не двигался (create
 *            уведомляет назначением, как и раньше).
 *
 * Себе не пишем: кто нажал, тот знает.
 */
export function handoffRecipients(
  h: { action: HandoffAction; actorId: string | null; fromId: string | null; toId: string | null },
  reviewFrom: string | null,
): string[] {
  let to: (string | null)[]
  switch (h.action) {
    case 'review':
    case 'return':
    case 'ask':
    case 'answer':
    case 'pass':
    case 'reopen':
      to = [h.toId]
      break
    case 'accept':
      to = [reviewFrom]
      break
    case 'cancel':
    case 'take':
      to = [h.fromId]
      break
    default:
      to = []
  }
  return [...new Set(to.filter((x): x is string => Boolean(x) && x !== h.actorId))]
}

/** События, которые говорят «задача на тебе» — их снимаем, когда мяч ушёл. */
const HOLDER_EVENTS = ['task_handoff', 'task_assigned'] as const

/**
 * Снять непрочитанные «задача на тебе» у человека по этой задаче.
 *
 * Мяч ушёл — «вам передали» стало неправдой; мяч пришёл снова — старое
 * уведомление заменяет новое с новой запиской. Прочитанное не трогаем: это
 * история, которую человек уже видел.
 */
async function dropHolderNotices(userId: string, taskId: string): Promise<void> {
  const removed = await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.entityId, taskId),
        inArray(notifications.event, [...HOLDER_EVENTS]),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id })
  if (removed.length) sendToUserAnywhere(userId, 'notification', {})
}

export async function notifyHandoff(task: typeof tasks.$inferSelect, h: HandoffRow): Promise<void> {
  try {
    if (!h.action || h.action === 'create') return
    const moved = h.fromId && h.fromId !== h.toId
    if (moved) await dropHolderNotices(h.fromId!, task.id)

    const recipients = handoffRecipients(
      { action: h.action, actorId: h.actorId ?? null, fromId: h.fromId ?? null, toId: h.toId ?? null },
      h.action === 'accept' ? await lastReviewFrom(task.id) : null,
    )
    if (!recipients.length) return
    // Новая передача заменяет прежнюю непрочитанную: в ленте — последняя записка.
    for (const r of recipients) if (r === h.toId) await dropHolderNotices(r, task.id)

    const actor = h.actorId ? await db.query.users.findFirst({ where: eq(users.id, h.actorId) }) : null
    const title = task.title.length > 60 ? `${task.title.slice(0, 59)}…` : task.title
    await notify({
      projectId: task.projectId,
      event: 'task_handoff',
      titleKey: `handoff_${h.action}`,
      recipientIds: recipients,
      actorId: h.actorId,
      actorName: actor?.name || 'Someone',
      entityType: 'task',
      entityId: task.id,
      link: projectPath((await companyOf(task.projectId)) ?? '', task.projectId, `/tasks/${task.id}`),
      preview: h.note ?? '',
      vars: { ref: `${task.number} «${title}»`, round: String(h.round ?? task.round) },
    })
  } catch (e) {
    console.error('[handoff-notify] failed:', e)
  }
}
