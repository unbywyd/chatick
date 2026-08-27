import { and, eq, gte, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { aiUsageLog, spendAlerts } from '../db/schema.js'
import { env } from '../env.js'
import { notifySpendThreshold } from './admin-alert.js'

/**
 * Предупреждение о тратах на ИИ.
 *
 * Счёт за модели растёт тихо: каждый вызов стоит доли цента, и заметить рост
 * можно только сложив всё за месяц — то есть уже постфактум, из выписки.
 *
 * Считаем по ВСЕМ проектам сервера, а не по компании: платит владелец
 * площадки, и вопрос у него один — «сколько ушло всего».
 *
 * Одно письмо на месяц. Планировщик тикает каждые пять минут, и без этого
 * ограничения писем было бы 288 в сутки — человек отключил бы их на второй
 * день, вместе с настоящими предупреждениями. Отметка живёт в базе
 * (spend_alerts) с уникальным ключом на период: два процесса тикают
 * независимо, и проверка «посмотрели, потом вставили» пропустила бы второе
 * письмо между этими шагами.
 */

/** Текущий месяц как «2026-08» — ключ периода. */
function currentPeriod(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Начало текущего месяца по UTC. */
function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

/** Сколько потрачено с начала месяца, в долларах. */
export async function spentThisMonth(now = new Date()): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${aiUsageLog.costUsd}::numeric), 0)::text` })
    .from(aiUsageLog)
    .where(gte(aiUsageLog.createdAt, monthStart(now)))
  return Number(row?.total ?? 0)
}

/**
 * Проверить траты и написать, если перевалили за порог.
 *
 * Зовётся из планировщика. Ошибку глушим: сторож расходов не должен ронять
 * тик, в котором рядом идут напоминания и бэкапы.
 */
export async function checkSpendAlert(now = new Date()): Promise<void> {
  try {
    const limit = env.AI_SPEND_ALERT_USD
    // Ноль — выключено. Нет адреса — писать некому, и это обычное состояние
    // на локальной машине.
    if (!limit || limit <= 0 || !env.ADMIN_EMAIL) return

    const spent = await spentThisMonth(now)
    if (spent < limit) return

    const period = currentPeriod(now)
    // Вставка ПЕРЕД письмом, и в ней же проверка: уникальный индекс не даст
    // второму процессу вставить строку, и он просто ничего не отправит.
    // Обратный порядок — «отправили, потом записали» — дал бы два письма при
    // одновременном тике.
    const [claimed] = await db
      .insert(spendAlerts)
      .values({
        period,
        kind: 'monthly_threshold',
        amountUsd: spent.toFixed(4),
        sentTo: env.ADMIN_EMAIL,
      })
      .onConflictDoNothing()
      .returning({ id: spendAlerts.id })
    if (!claimed) return

    await notifySpendThreshold({ to: env.ADMIN_EMAIL, period, spent, limit, breakdown: await breakdownThisMonth(now) })
  } catch (err) {
    console.error('[spend-alert] check failed:', err)
  }
}

/** Разбивка по моделям — чтобы из письма было видно, на что ушло. */
export async function breakdownThisMonth(
  now = new Date(),
): Promise<{ model: string; feature: string; costUsd: number; calls: number }[]> {
  const rows = await db
    .select({
      model: aiUsageLog.model,
      feature: sql<string>`coalesce(${aiUsageLog.feature}, '—')`,
      costUsd: sql<string>`coalesce(sum(${aiUsageLog.costUsd}::numeric), 0)::text`,
      calls: sql<number>`count(*)::int`,
    })
    .from(aiUsageLog)
    .where(gte(aiUsageLog.createdAt, monthStart(now)))
    .groupBy(aiUsageLog.model, aiUsageLog.feature)
    .orderBy(sql`sum(${aiUsageLog.costUsd}::numeric) desc nulls last`)
    .limit(20)
  return rows.map((r) => ({ model: r.model, feature: r.feature, costUsd: Number(r.costUsd), calls: r.calls }))
}

/** Было ли письмо за этот месяц — для тестов и страницы расходов. */
export async function alertSentFor(period: string): Promise<boolean> {
  const row = await db.query.spendAlerts.findFirst({
    where: and(eq(spendAlerts.period, period), eq(spendAlerts.kind, 'monthly_threshold')),
    columns: { id: true },
  })
  return Boolean(row)
}
