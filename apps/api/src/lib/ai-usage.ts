import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { aiUsageLog, modelPricing, projects } from '../db/schema.js'
import { env } from '../env.js'

// Учёт использования ИИ + прайсинг моделей (SPEC §8.11).

// Встроенный прайсинг: USD за 1M токенов (input/output). Наследуется по умолчанию.
// Для моделей, которых тут нет, цена не считается, пока пользователь её не задаст.
export const DEFAULT_PRICING: Record<string, { in: number; out: number }> = {
  // Anthropic
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
  'claude-3-5-haiku-20241022': { in: 0.8, out: 4 },
  'claude-3-5-sonnet-20241022': { in: 3, out: 15 },
  'claude-sonnet-4-20250514': { in: 3, out: 15 },
  'claude-opus-4-20250514': { in: 15, out: 75 },
  // OpenAI
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4.1': { in: 2, out: 8 },
  // Google
  'gemini-2.0-flash': { in: 0.1, out: 0.4 },
  'gemini-1.5-flash': { in: 0.075, out: 0.3 },
  'gemini-1.5-pro': { in: 1.25, out: 5 },
  /**
   * DeepSeek — цены пиковые, и это выбор, а не небрежность.
   *
   * У провайдера две ставки: ночная вдвое дешевле дневной (пик — 01:00–04:00 и
   * 06:00–10:00 UTC). Одним числом обе не выразить, а по этим ценам считается
   * не только отчёт, но и лимит пробного периода. Занизить — значит потратить
   * вдвое больше денег, чем обещано; завысить — лишь оборвать пробу чуть
   * раньше. Цена ошибки несимметрична, поэтому берём дорогую ставку.
   *
   * Вход считаем по «промаху кэша». Попадание дешевле в тридцать раз, но мы
   * не разделяем эти токены при учёте, и предполагать дешёвый вариант значило
   * бы занижать. Сверено с прайсом 21.08.2026.
   */
  'deepseek-v4-flash': { in: 0.44, out: 1.32 },
  'deepseek-v4-pro': { in: 1.32, out: 3.96 },
  'deepseek-chat': { in: 0.27, out: 1.1 }, // снята провайдером, оставлена для истории
  'deepseek-reasoner': { in: 0.55, out: 2.19 }, // снята провайдером, оставлена для истории
  // Groq
  'llama-3.3-70b-versatile': { in: 0.59, out: 0.79 },
  /**
   * Эмбеддинги — поиск по смыслу, а не разговор.
   *
   * Выхода у них нет вовсе: модель принимает текст и возвращает числа, за
   * которые платить нечем. out: 0 — не заглушка, а правда, и она нужна,
   * чтобы отчёт не показывал прочерк вместо цены.
   *
   * Цена ниже разговорных в сотню раз: вся текущая база Chatick — задачи,
   * комментарии и документы, 1.7 МБ — обходится примерно в полтора цента.
   * Дорого здесь может стать только от объёма, и за этим следит порог с
   * письмом (см. lib/spend-alert.ts).
   */
  'text-embedding-3-small': { in: 0.02, out: 0 },
  'text-embedding-3-large': { in: 0.13, out: 0 },
}

export type TokenUsage = { tokensIn: number; tokensOut: number }

/** Эффективная цена модели: per-project override → глобальный override → встроенный дефолт → null. */
export async function pricingFor(projectId: string, model: string): Promise<{ in: number; out: number } | null> {
  const rows = await db.query.modelPricing.findMany({ where: eq(modelPricing.model, model) })
  const projectRow = rows.find((r) => r.projectId === projectId)
  const globalRow = rows.find((r) => r.projectId === null)
  const row = projectRow ?? globalRow
  if (row) return { in: Number(row.inputPerM), out: Number(row.outputPerM) }
  return DEFAULT_PRICING[model] ?? null
}

/** Стоимость вызова в USD (или null, если цена модели неизвестна). */
export async function costFor(projectId: string, model: string, usage: TokenUsage): Promise<number | null> {
  const price = await pricingFor(projectId, model)
  if (!price) return null
  return (usage.tokensIn / 1_000_000) * price.in + (usage.tokensOut / 1_000_000) * price.out
}

/** Записать использование ИИ (fail-safe — не роняет основной флоу). */
export async function logAiUsage(params: {
  projectId: string
  source: 'company' | 'trial' | 'custom'
  model: string
  usage: TokenUsage
  feature?: string
}): Promise<void> {
  try {
    if (!params.usage.tokensIn && !params.usage.tokensOut) return
    const cost = await costFor(params.projectId, params.model, params.usage)
    await db.insert(aiUsageLog).values({
      projectId: params.projectId,
      source: params.source,
      model: params.model,
      tokensIn: String(params.usage.tokensIn),
      tokensOut: String(params.usage.tokensOut),
      costUsd: cost === null ? null : cost.toFixed(8),
      feature: params.feature ?? null,
    })
  } catch (err) {
    console.error('[ai-usage] log failed:', err)
  }
}

/** Суммарные траты проекта в USD (только строки с известной ценой). */
export async function projectSpendUsd(projectId: string): Promise<number> {
  const [{ total }] = (await db
    .select({ total: sql<string>`coalesce(sum(cast(${aiUsageLog.costUsd} as numeric)), 0)` })
    .from(aiUsageLog)
    .where(and(eq(aiUsageLog.projectId, projectId), sql`${aiUsageLog.costUsd} is not null`))) as [{ total: string }]
  return Number(total) || 0
}

/**
 * Сколько компания уже потратила пробного бюджета.
 *
 * Считаем по компании, а не по проекту: регистрация бесплатна, проектов можно
 * создать сколько угодно, и бюджет «на проект» означал бы столько же раз по
 * столько же долларов. Компания — верхний уровень, за которым стоит человек.
 */
export async function companyTrialSpendUsd(companyId: string): Promise<number> {
  const [{ total }] = (await db
    .select({ total: sql<string>`coalesce(sum(cast(${aiUsageLog.costUsd} as numeric)), 0)` })
    .from(aiUsageLog)
    .innerJoin(projects, eq(projects.id, aiUsageLog.projectId))
    .where(
      and(
        eq(projects.companyId, companyId),
        eq(aiUsageLog.source, 'trial'),
        sql`${aiUsageLog.costUsd} is not null`,
      ),
    )) as [{ total: string }]
  return Number(total) || 0
}

/** Достигнут ли лимит пробного бюджета компании (SPEC §8.11). */
export async function trialBudgetExceeded(projectId: string): Promise<boolean> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return true
  const spent = await companyTrialSpendUsd(project.companyId)
  return spent >= env.AI_TRIAL_BUDGET_USD
}
