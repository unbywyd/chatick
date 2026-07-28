import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { projectAi, aiUsageLog, modelPricing, projects } from '../db/schema.js'
import { requireProject, type ProjectEnv } from '../auth.js'
import { encrypt } from '../lib/crypto.js'
import { env } from '../env.js'
import { LLM_PROVIDERS, projectLlm } from '../lib/llm.js'
import { DEFAULT_PRICING, projectSpendUsd, companyTrialSpendUsd } from '../lib/ai-usage.js'

// Настройка ИИ-агента проекта + учёт использования (SPEC §8.11). Project-токен, owner/admin.
export const aiRoute = new Hono<ProjectEnv>()
aiRoute.use('*', requireProject)

const isAdmin = (role: string) => role === 'owner' || role === 'admin'

// Текущий источник ИИ + пробный бюджет/трата
aiRoute.get('/config', async (c) => {
  const { projectId } = c.get('auth')
  const ai = await db.query.projectAi.findFirst({ where: eq(projectAi.projectId, projectId) })
  const spent = await projectSpendUsd(projectId)

  // Что работает НА САМОМ ДЕЛЕ. Выбранный источник и действующий расходятся:
  // при source='company' без ключа компании чат обслуживает пробный ИИ. В
  // интерфейсе подсвечивался выбор, и человек видел «Ключ компании» там, где
  // отвечал пробный.
  const actual = await projectLlm(projectId)
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  const trialSpent = project ? await companyTrialSpendUsd(project.companyId) : 0

  return c.json({
    source: ai?.source ?? 'company',
    /** company | trial | custom — по факту, а не по настройке */
    activeSource: actual?.usage?.source ?? null,
    trialSpentUsd: trialSpent,
    provider: ai?.provider ?? '',
    model: ai?.model ?? '',
    hasKey: Boolean(ai?.keyEncrypted),
    trialBudget: env.AI_TRIAL_BUDGET_USD,
    trialAvailable: Boolean(env.AI_TRIAL_KEY),
    spentUsd: spent,
    providers: Object.entries(LLM_PROVIDERS).map(([id, p]) => ({ id, label: p.label, defaultModel: p.defaultModel })),
  })
})

const configSchema = z.object({
  source: z.enum(['company', 'trial', 'custom']),
  provider: z.string().optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
})

aiRoute.put('/config', zValidator('json', configSchema), async (c) => {
  const { projectId, role } = c.get('auth')
  if (!isAdmin(role)) return c.json({ error: 'Forbidden' }, 403)
  const b = c.req.valid('json')
  const existing = await db.query.projectAi.findFirst({ where: eq(projectAi.projectId, projectId) })

  if (b.source === 'custom') {
    if (!b.provider || !(b.provider in LLM_PROVIDERS)) return c.json({ error: 'Unknown provider' }, 400)
    const hasKey = Boolean(existing?.keyEncrypted)
    if (!b.apiKey && !hasKey) return c.json({ error: 'API key is required' }, 400)
  }

  const values = {
    source: b.source,
    provider: b.source === 'custom' ? b.provider ?? null : null,
    model: b.source === 'custom' ? b.model || null : null,
    ...(b.source === 'custom' && b.apiKey ? { keyEncrypted: encrypt(b.apiKey) } : {}),
    ...(b.source !== 'custom' ? { keyEncrypted: null } : {}),
  }
  if (existing) await db.update(projectAi).set(values).where(eq(projectAi.projectId, projectId))
  else await db.insert(projectAi).values({ projectId, ...values })
  return c.json({ ok: true, source: b.source })
})

// Сводка использования + разбивка по моделям
aiRoute.get('/usage', async (c) => {
  const { projectId } = c.get('auth')
  const byModel = await db
    .select({
      model: aiUsageLog.model,
      source: aiUsageLog.source,
      calls: sql<number>`count(*)::int`,
      tokensIn: sql<string>`coalesce(sum(cast(${aiUsageLog.tokensIn} as bigint)),0)`,
      tokensOut: sql<string>`coalesce(sum(cast(${aiUsageLog.tokensOut} as bigint)),0)`,
      costUsd: sql<string>`coalesce(sum(cast(${aiUsageLog.costUsd} as numeric)),0)`,
      hasCost: sql<boolean>`bool_or(${aiUsageLog.costUsd} is not null)`,
    })
    .from(aiUsageLog)
    .where(eq(aiUsageLog.projectId, projectId))
    .groupBy(aiUsageLog.model, aiUsageLog.source)
    .orderBy(desc(sql`count(*)`))

  const spent = await projectSpendUsd(projectId)
  return c.json({
    spentUsd: spent,
    byModel: byModel.map((r) => ({
      model: r.model,
      source: r.source,
      calls: r.calls,
      tokensIn: Number(r.tokensIn),
      tokensOut: Number(r.tokensOut),
      costUsd: r.hasCost ? Number(r.costUsd) : null,
    })),
  })
})

// Последние вызовы (лог)
aiRoute.get('/usage/log', async (c) => {
  const { projectId } = c.get('auth')
  const rows = await db
    .select()
    .from(aiUsageLog)
    .where(eq(aiUsageLog.projectId, projectId))
    .orderBy(desc(aiUsageLog.createdAt))
    .limit(100)
  return c.json(
    rows.map((r) => ({
      id: r.id,
      model: r.model,
      source: r.source,
      feature: r.feature,
      tokensIn: Number(r.tokensIn),
      tokensOut: Number(r.tokensOut),
      costUsd: r.costUsd === null ? null : Number(r.costUsd),
      createdAt: r.createdAt,
    })),
  )
})

// Прайсинг: эффективные цены (per-project override → default) + флаг источника
aiRoute.get('/pricing', async (c) => {
  const { projectId } = c.get('auth')
  // модели, которые реально использовались + известные дефолты
  const used = await db
    .selectDistinct({ model: aiUsageLog.model })
    .from(aiUsageLog)
    .where(eq(aiUsageLog.projectId, projectId))
  const overrides = await db.query.modelPricing.findMany({ where: eq(modelPricing.projectId, projectId) })
  const models = new Set<string>([...Object.keys(DEFAULT_PRICING), ...used.map((u) => u.model), ...overrides.map((o) => o.model)])
  const overrideMap = new Map(overrides.map((o) => [o.model, o]))
  return c.json(
    [...models].sort().map((model) => {
      const ov = overrideMap.get(model)
      const def = DEFAULT_PRICING[model]
      return {
        model,
        inputPerM: ov ? Number(ov.inputPerM) : def ? def.in : null,
        outputPerM: ov ? Number(ov.outputPerM) : def ? def.out : null,
        custom: Boolean(ov),
        hasDefault: Boolean(def),
      }
    }),
  )
})

// Задать/сбросить цену модели для проекта (owner/admin)
aiRoute.put(
  '/pricing',
  zValidator('json', z.object({ model: z.string().min(1), inputPerM: z.number().min(0).nullable(), outputPerM: z.number().min(0).nullable() })),
  async (c) => {
    const { projectId, role } = c.get('auth')
    if (!isAdmin(role)) return c.json({ error: 'Forbidden' }, 403)
    const { model, inputPerM, outputPerM } = c.req.valid('json')
    // null/null → сброс override (вернуться к дефолту)
    if (inputPerM === null || outputPerM === null) {
      await db.delete(modelPricing).where(and(eq(modelPricing.projectId, projectId), eq(modelPricing.model, model)))
      return c.json({ ok: true, reset: true })
    }
    const existing = await db.query.modelPricing.findFirst({ where: and(eq(modelPricing.projectId, projectId), eq(modelPricing.model, model)) })
    if (existing) {
      await db.update(modelPricing).set({ inputPerM: String(inputPerM), outputPerM: String(outputPerM) }).where(eq(modelPricing.id, existing.id))
    } else {
      await db.insert(modelPricing).values({ projectId, model, inputPerM: String(inputPerM), outputPerM: String(outputPerM) })
    }
    return c.json({ ok: true })
  },
)
