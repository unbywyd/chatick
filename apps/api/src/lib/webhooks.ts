import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull, lte, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companyWebhooks, webhookDeliveries } from '../db/schema.js'
import { assertPublic } from './ssrf.js'

// Вебхуки во внешнюю систему (SPEC-INTEGRATION §7).
//
// Событие кладётся в очередь и уходит отдельно от запроса, который его
// породил: их сервер может лежать, а человек, закрывший задачу, не должен
// ждать чужую сеть.
//
// БЕЗОПАСНОСТЬ. Мы ходим по адресу, который назвал заказчик, — это тот же
// SSRF, что и с иконками сайтов. Проверки те же: только http(s), внутренние
// адреса запрещены, время ограничено. Разница в том, что адрес здесь задаёт
// админ компании, а не случайный участник, — но ошибиться он может так же.

export type WebhookEvent =
  | 'task.created'
  | 'task.status_changed'
  | 'task.assigned'
  | 'time.logged'
  | 'project.updated'

const MAX_ATTEMPTS = 6
const TIMEOUT_MS = 8000

/** Секрет вебхука. Показывается один раз, как и ключ API. */
export const newSecret = () => `whsec_${randomBytes(24).toString('base64url')}`

/**
 * Подпись тела запроса.
 *
 * Принимающая сторона считает то же самое своим секретом и сравнивает: без
 * этого любой, кто узнал адрес, мог бы слать им выдуманные события.
 */
export function sign(secret: string, body: string, timestamp: number): string {
  // Время внутри подписи: иначе перехваченный запрос можно повторять вечно.
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

/** Проверка подписи — для тех, кто принимает наши вебхуки (и для наших тестов). */
export function verify(secret: string, body: string, timestamp: number, signature: string): boolean {
  const want = Buffer.from(sign(secret, body, timestamp))
  const got = Buffer.from(signature)
  return want.length === got.length && timingSafeEqual(want, got)
}

/**
 * Поставить событие в очередь всем подписанным вебхукам компании.
 *
 * Ничего не отправляет сам: отправкой занимается фоновый проход. Вызывать
 * можно откуда угодно, в том числе из горячего пути — это одна вставка.
 */
export async function enqueue(companyId: string, event: WebhookEvent, payload: Record<string, unknown>): Promise<void> {
  try {
    const hooks = await db.query.companyWebhooks.findMany({
      where: and(eq(companyWebhooks.companyId, companyId), eq(companyWebhooks.active, true)),
    })
    if (!hooks.length) return

    const body = JSON.stringify({ event, at: new Date().toISOString(), data: payload })

    for (const hook of hooks) {
      const events = JSON.parse(hook.events || '[]') as string[]
      // Пустой список — подписка на всё: так начинают, а сужают потом.
      if (events.length && !events.includes(event)) continue
      await db.insert(webhookDeliveries).values({ webhookId: hook.id, event, payload: body })
    }
  } catch (e) {
    // Вебхук — уведомление о том, что уже случилось. Сбой очереди не должен
    // отменять само действие.
    console.warn('[webhooks] не удалось поставить в очередь:', e instanceof Error ? e.message : e)
  }
}

/** Пауза перед следующей попыткой: 1 мин, 5, 25… до примерно двух часов. */
const backoffMs = (attempt: number) => Math.min(60_000 * 5 ** (attempt - 1), 2 * 3600_000)

/**
 * Отправить то, что накопилось. Зовётся по расписанию.
 *
 * @returns сколько доставлено и сколько не удалось — для журнала.
 */
export async function flush(limit = 50): Promise<{ sent: number; failed: number }> {
  const due = await db
    .select({ delivery: webhookDeliveries, hook: companyWebhooks })
    .from(webhookDeliveries)
    .innerJoin(companyWebhooks, eq(companyWebhooks.id, webhookDeliveries.webhookId))
    .where(and(isNull(webhookDeliveries.deliveredAt), lte(webhookDeliveries.nextTryAt, new Date())))
    .limit(limit)

  let sent = 0
  let failed = 0

  for (const { delivery, hook } of due) {
    const attempt = delivery.attempts + 1
    const ts = Math.floor(Date.now() / 1000)

    try {
      // Адрес назвал админ компании — проверяем так же, как любой чужой:
      // ошибиться он может не хуже случайного участника, а наш сервер
      // постучится туда его руками.
      await assertPublic(new URL(hook.url))

      const res = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-chatick-event': delivery.event,
          'x-chatick-timestamp': String(ts),
          'x-chatick-signature': sign(hook.secret, delivery.payload, ts),
        },
        body: delivery.payload,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })

      if (res.ok) {
        await db
          .update(webhookDeliveries)
          .set({ deliveredAt: new Date(), attempts: attempt, lastStatus: res.status })
          .where(eq(webhookDeliveries.id, delivery.id))
        await db.update(companyWebhooks).set({ lastOkAt: new Date(), lastError: null }).where(eq(companyWebhooks.id, hook.id))
        sent++
        continue
      }

      throw new Error(`HTTP ${res.status}`)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      failed++

      if (attempt >= MAX_ATTEMPTS) {
        // Сдаёмся, но помечаем доставленной, чтобы очередь не росла вечно.
        // Причина остаётся в записи: почему не дошло, видно и через неделю.
        await db
          .update(webhookDeliveries)
          .set({ attempts: attempt, deliveredAt: new Date(), lastError: `giving up: ${message}` })
          .where(eq(webhookDeliveries.id, delivery.id))
      } else {
        await db
          .update(webhookDeliveries)
          .set({ attempts: attempt, nextTryAt: new Date(Date.now() + backoffMs(attempt)), lastError: message })
          .where(eq(webhookDeliveries.id, delivery.id))
      }

      await db
        .update(companyWebhooks)
        .set({ lastFailAt: new Date(), lastError: message })
        .where(eq(companyWebhooks.id, hook.id))
    }
  }

  return { sent, failed }
}

/** Убрать доставленное старше недели: журнал полезен, но не вечно. */
export async function sweepDeliveries(): Promise<void> {
  await db
    .delete(webhookDeliveries)
    .where(sql`${webhookDeliveries.deliveredAt} is not null and ${webhookDeliveries.deliveredAt} < now() - interval '7 days'`)
}
