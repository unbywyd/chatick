import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companies, projectAi, projects } from '../db/schema.js'
import { decrypt } from './crypto.js'
import { env } from '../env.js'
import { logAiUsage, trialBudgetExceeded, type TokenUsage } from './ai-usage.js'

// BYO-LLM: каждая компания подключает своего провайдера (ключ шифрован в БД).
// Единый тонкий адаптер: anthropic — нативный API, остальные — OpenAI-compatible.
// Схема настроек (provider/model/apiKey) совместима по духу с Vercel AI SDK —
// миграция на него позже не потребует смены модели данных.

export const LLM_PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    defaultModel: 'claude-haiku-4-5-20251001',
    kind: 'anthropic' as const,
    baseUrl: 'https://api.anthropic.com/v1',
  },
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    kind: 'openai' as const,
    baseUrl: 'https://api.openai.com/v1',
  },
  google: {
    label: 'Google (Gemini)',
    defaultModel: 'gemini-2.0-flash',
    kind: 'openai' as const, // OpenAI-compatible endpoint
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  deepseek: {
    label: 'DeepSeek',
    // deepseek-chat снят провайдером: остались только v4-pro и v4-flash
    defaultModel: 'deepseek-v4-flash',
    kind: 'openai' as const,
    baseUrl: 'https://api.deepseek.com/v1',
  },
  groq: {
    label: 'Groq',
    defaultModel: 'llama-3.3-70b-versatile',
    kind: 'openai' as const,
    baseUrl: 'https://api.groq.com/openai/v1',
  },
} as const

export type LlmProvider = keyof typeof LLM_PROVIDERS

export type LlmConfig = {
  provider: LlmProvider
  model: string
  apiKey: string
  // контекст учёта (SPEC §8.11): если задан — вызовы логируются в ai_usage_log
  usage?: { projectId: string; source: 'company' | 'trial' | 'custom'; feature?: string }
}

/** Настройки LLM компании (расшифрованный ключ) — null, если не настроено. */
export async function companyLlm(companyId: string): Promise<LlmConfig | null> {
  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) })
  if (!company?.llmProvider || !company.llmKeyEncrypted) return null
  const provider = company.llmProvider as LlmProvider
  if (!LLM_PROVIDERS[provider]) return null
  try {
    return {
      provider,
      model: company.llmModel || LLM_PROVIDERS[provider].defaultModel,
      apiKey: decrypt(company.llmKeyEncrypted),
    }
  } catch {
    console.error('[llm] key decryption failed for company', companyId)
    return null
  }
}

/**
 * Настройки LLM по проекту (SPEC §8.11): источник trial | custom | company.
 * - trial: наш пробный ключ (внутри DeepSeek), пока не исчерпан бюджет $ проекта;
 * - custom: свой провайдер/ключ проекта;
 * - company (дефолт): ключ компании.
 * feature — тег для лога использования.
 */
export async function projectLlm(projectId: string, feature?: string): Promise<LlmConfig | null> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return null
  const ai = await db.query.projectAi.findFirst({ where: eq(projectAi.projectId, projectId) })
  const source = ai?.source ?? 'company'

  if (source === 'trial' && env.AI_TRIAL_KEY && !(await trialBudgetExceeded(projectId))) {
    const provider = (env.AI_TRIAL_PROVIDER as LlmProvider) in LLM_PROVIDERS ? (env.AI_TRIAL_PROVIDER as LlmProvider) : 'deepseek'
    return {
      provider,
      model: env.AI_TRIAL_MODEL || LLM_PROVIDERS[provider].defaultModel,
      apiKey: env.AI_TRIAL_KEY,
      usage: { projectId, source: 'trial', feature },
    }
  }

  if (source === 'custom' && ai?.provider && ai.keyEncrypted && LLM_PROVIDERS[ai.provider as LlmProvider]) {
    try {
      const provider = ai.provider as LlmProvider
      return {
        provider,
        model: ai.model || LLM_PROVIDERS[provider].defaultModel,
        apiKey: decrypt(ai.keyEncrypted),
        usage: { projectId, source: 'custom', feature },
      }
    } catch {
      console.error('[llm] custom key decryption failed for project', projectId)
    }
  }

  // company (дефолт / фолбэк, если trial исчерпан или custom не настроен)
  const cfg = await companyLlm(project.companyId)
  return cfg ? { ...cfg, usage: { projectId, source: 'company', feature } } : null
}

// Извлекает токены из ответа (Anthropic / OpenAI-совместимые) и логирует, если задан usage-контекст.
function accumulate(acc: TokenUsage, raw: unknown): void {
  const u = raw as { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number } | undefined
  if (!u) return
  acc.tokensIn += u.input_tokens ?? u.prompt_tokens ?? 0
  acc.tokensOut += u.output_tokens ?? u.completion_tokens ?? 0
}
function flushUsage(cfg: LlmConfig, acc: TokenUsage): void {
  if (cfg.usage && (acc.tokensIn || acc.tokensOut)) {
    void logAiUsage({ projectId: cfg.usage.projectId, source: cfg.usage.source, model: cfg.model, usage: acc, feature: cfg.usage.feature })
  }
}

export async function complete(
  cfg: LlmConfig,
  opts: { system: string; user: string; maxTokens?: number },
): Promise<string | null> {
  const p = LLM_PROVIDERS[cfg.provider]
  try {
    if (p.kind === 'anthropic') {
      const res = await fetch(`${p.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: opts.maxTokens ?? 2000,
          system: opts.system,
          messages: [{ role: 'user', content: opts.user }],
        }),
      })
      if (!res.ok) {
        console.error('[llm] anthropic failed:', res.status, await res.text().catch(() => ''))
        return null
      }
      const data = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: unknown }
      const acc: TokenUsage = { tokensIn: 0, tokensOut: 0 }
      accumulate(acc, data.usage)
      flushUsage(cfg, acc)
      return data.content?.find((b) => b.type === 'text')?.text ?? null
    }

    // OpenAI-compatible (openai / google / deepseek / groq)
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: opts.maxTokens ?? 2000,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
      }),
    })
    if (!res.ok) {
      console.error('[llm] openai-compat failed:', res.status, await res.text().catch(() => ''))
      return null
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: unknown }
    const acc: TokenUsage = { tokensIn: 0, tokensOut: 0 }
    accumulate(acc, data.usage)
    flushUsage(cfg, acc)
    return data.choices?.[0]?.message?.content ?? null
  } catch (err) {
    console.error('[llm] error:', err)
    return null
  }
}

// --- Tool-use (SPEC §5.6): единый формат инструментов, цикл до N итераций ---

export type ToolDef = {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema
}
export type ToolHandler = (args: Record<string, unknown>) => Promise<string>

/**
 * Диалог с инструментами: модель может вызывать tools, результаты возвращаются ей,
 * цикл до maxIterations; итог — финальный текст. Anthropic tool_use / OpenAI functions.
 */
export async function completeWithTools(
  cfg: LlmConfig,
  opts: {
    system: string
    user: string
    tools: ToolDef[]
    handlers: Record<string, ToolHandler>
    maxTokens?: number
    maxIterations?: number
  },
): Promise<string | null> {
  const p = LLM_PROVIDERS[cfg.provider]
  // 12, а не 5: с пакетными инструментами этого хватает почти всегда, а при
  // одиночных вызовах короткий лимит обрывал цепочку на середине — часть задач
  // уже изменена, а пользователь видел пустой ответ.
  const maxIter = opts.maxIterations ?? 12

  /**
   * Вызов инструмента. Ошибку возвращаем модели ЧИТАЕМЫМ текстом и пишем в лог:
   * `Error: [object Object]` не даёт ей понять, чинить запрос или сдаться,
   * а неизвестный инструмент — это наш баг, который иначе теряется.
   */
  const runTool = async (name: string, input: Record<string, unknown>): Promise<string> => {
    const handler = opts.handlers[name]
    if (!handler) {
      console.error('[llm] model called an unknown tool:', name)
      return `ERROR: tool "${name}" does not exist. Available tools: ${opts.tools.map((t) => t.name).join(', ')}.`
    }
    try {
      return await handler(input)
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      console.error(`[llm] tool ${name} failed:`, e)
      return `ERROR while running "${name}": ${detail}. Nothing was changed by this call — tell the user what went wrong.`
    }
  }
  try {
    const acc: TokenUsage = { tokensIn: 0, tokensOut: 0 }
    if (p.kind === 'anthropic') {
      const tools = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
      const msgs: unknown[] = [{ role: 'user', content: opts.user }]
      for (let i = 0; i < maxIter; i++) {
        const res = await fetch(`${p.baseUrl}/messages`, {
          method: 'POST',
          headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, max_tokens: opts.maxTokens ?? 1500, system: opts.system, messages: msgs, tools }),
        })
        if (!res.ok) {
          console.error('[llm] tools failed:', res.status, await res.text().catch(() => ''))
          return null
        }
        const data = (await res.json()) as {
          stop_reason?: string
          content: ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> })[]
          usage?: unknown
        }
        accumulate(acc, data.usage)
        if (data.stop_reason !== 'tool_use') {
          flushUsage(cfg, acc)
          return data.content.find((b) => b.type === 'text')?.text ?? null
        }
        msgs.push({ role: 'assistant', content: data.content })
        const results = await Promise.all(
          data.content
            .filter((b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => b.type === 'tool_use')
            .map(async (b) => ({
              type: 'tool_result',
              tool_use_id: b.id,
              content: await runTool(b.name, b.input),
            })),
        )
        msgs.push({ role: 'user', content: results })
      }
      // Лимит исчерпан. Молча вернуть null нельзя: часть действий уже выполнена.
      // Просим модель отчитаться — БЕЗ инструментов, чтобы она не начала заново.
      msgs.push({
        role: 'user',
        content:
          'TOOL BUDGET EXHAUSTED. Do not call any more tools. Tell the user plainly what you already did, what is left undone, and ask whether to continue.',
      })
      const final = await fetch(`${p.baseUrl}/messages`, {
        method: 'POST',
        headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, max_tokens: opts.maxTokens ?? 1500, system: opts.system, messages: msgs }),
      })
      flushUsage(cfg, acc)
      if (!final.ok) return null
      const fdata = (await final.json()) as { content?: { type: string; text?: string }[] }
      return fdata.content?.find((b) => b.type === 'text')?.text ?? null
    }

    // OpenAI-compatible
    const tools = opts.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    const msgs: unknown[] = [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ]
    for (let i = 0; i < maxIter; i++) {
      const res = await fetch(`${p.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, max_tokens: opts.maxTokens ?? 1500, messages: msgs, tools }),
      })
      if (!res.ok) {
        console.error('[llm] tools failed:', res.status, await res.text().catch(() => ''))
        return null
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[]
        usage?: unknown
      }
      accumulate(acc, data.usage)
      const msg = data.choices?.[0]?.message
      if (!msg) {
        flushUsage(cfg, acc)
        return null
      }
      if (!msg.tool_calls?.length) {
        flushUsage(cfg, acc)
        return msg.content ?? null
      }
      msgs.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls })
      for (const call of msg.tool_calls) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(call.function.arguments || '{}')
        } catch { /* пустые аргументы */ }
        const result = await runTool(call.function.name, args)
        msgs.push({ role: 'tool', tool_call_id: call.id, content: result })
      }
    }
    // то же для OpenAI-совместимых: отчёт вместо тишины
    msgs.push({
      role: 'user',
      content:
        'TOOL BUDGET EXHAUSTED. Do not call any more tools. Tell the user plainly what you already did, what is left undone, and ask whether to continue.',
    })
    const final = await fetch(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, max_tokens: opts.maxTokens ?? 1500, messages: msgs }),
    })
    flushUsage(cfg, acc)
    if (!final.ok) return null
    const fdata = (await final.json()) as { choices?: { message?: { content?: string } }[] }
    return fdata.choices?.[0]?.message?.content ?? null
  } catch (err) {
    console.error('[llm] tools error:', err)
    return null
  }
}

/** Стриминговое дополнение: onChunk получает дельты текста; возвращает полный текст (null при сбое). */
export async function completeStream(
  cfg: LlmConfig,
  opts: { system: string; user: string; maxTokens?: number },
  onChunk: (delta: string) => void,
): Promise<string | null> {
  const p = LLM_PROVIDERS[cfg.provider]
  try {
    const isAnthropic = p.kind === 'anthropic'
    const res = await fetch(isAnthropic ? `${p.baseUrl}/messages` : `${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: isAnthropic
        ? { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
        : { Authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(
        isAnthropic
          ? {
              model: cfg.model,
              max_tokens: opts.maxTokens ?? 2000,
              system: opts.system,
              messages: [{ role: 'user', content: opts.user }],
              stream: true,
            }
          : {
              model: cfg.model,
              max_tokens: opts.maxTokens ?? 2000,
              messages: [
                { role: 'system', content: opts.system },
                { role: 'user', content: opts.user },
              ],
              stream: true,
              stream_options: { include_usage: true }, // токены в финальном чанке
            },
      ),
    })
    if (!res.ok || !res.body) {
      console.error('[llm] stream failed:', res.status, await res.text().catch(() => ''))
      return null
    }

    let full = ''
    const acc: TokenUsage = { tokensIn: 0, tokensOut: 0 }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          const json = JSON.parse(data) as Record<string, unknown>
          if (isAnthropic) {
            // usage: message_start.message.usage (input) + message_delta.usage (output)
            const j = json as { type?: string; message?: { usage?: unknown }; usage?: unknown; delta?: { text?: string } }
            if (j.type === 'message_start') accumulate(acc, j.message?.usage)
            if (j.type === 'message_delta') accumulate(acc, j.usage)
            const delta = j.type === 'content_block_delta' ? (json as { delta?: { text?: string } }).delta?.text : undefined
            if (delta) {
              full += delta
              onChunk(delta)
            }
          } else {
            const j = json as { choices?: { delta?: { content?: string } }[]; usage?: unknown }
            if (j.usage) accumulate(acc, j.usage) // финальный чанк с include_usage
            const delta = j.choices?.[0]?.delta?.content
            if (delta) {
              full += delta
              onChunk(delta)
            }
          }
        } catch {
          /* пропускаем неполные чанки */
        }
      }
    }
    flushUsage(cfg, acc)
    return full || null
  } catch (err) {
    console.error('[llm] stream error:', err)
    return null
  }
}

/** Быстрая проверка ключа при сохранении настроек. */
export async function testLlm(cfg: LlmConfig): Promise<boolean> {
  const r = await complete(cfg, { system: 'Reply with exactly: ok', user: 'ping', maxTokens: 8 })
  return r !== null
}

const LANG_NAMES: Record<string, string> = { en: 'English', ru: 'Russian', he: 'Hebrew' }

/**
 * Улучшение задачи при создании (aiConfig.improveTasks):
 * перевод на язык проекта + лёгкая доводка формулировки, суть неизменна.
 * Fail-open: нет ключа компании / сбой → null, используется оригинал.
 */
export async function improveTask(
  projectId: string,
  input: { title: string; description: string; language: string },
): Promise<{ title: string; description: string } | null> {
  const cfg = await projectLlm(projectId, 'improve_task')
  if (!cfg) return null

  const lang = LANG_NAMES[input.language] ?? input.language
  const text = await complete(cfg, {
    system: [
      `You polish task titles/descriptions for a task tracker. Target language: ${lang}.`,
      'Rules: translate into the target language if needed; fix grammar; make the title concise and action-oriented.',
      'NEVER change the meaning, scope or add new requirements. Keep it terse — no fluff.',
      'Respond with ONLY a JSON object: {"title": "...", "description": "..."} (description may be ""). No markdown, no extra text.',
    ].join('\n'),
    user: JSON.stringify({ title: input.title, description: input.description }),
    // JSON на языке проекта: кириллица/иврит дороже латиницы по токенам,
    // при тесном лимите ответ обрывается и результат теряется целиком
    maxTokens: 1500,
  })
  if (!text) return null
  try {
    // некоторые модели заворачивают в ```json — срежем
    const clean = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
    const parsed = JSON.parse(clean) as { title?: string; description?: string }
    if (!parsed.title || typeof parsed.title !== 'string') return null
    return { title: parsed.title.slice(0, 300), description: (parsed.description ?? '').slice(0, 10_000) }
  } catch {
    console.error('[llm] improveTask: bad JSON:', text.slice(0, 200))
    return null
  }
}

/**
 * Валидация задачи в форме («Проверить мою задачу», SPEC §8.6):
 * ИИ даёт короткий совет по улучшению + предлагает улучшенный вариант title/description
 * (для «применить»). Ничего не сохраняет. Fail-open: null → «ИИ недоступен».
 */
/**
 * Достаёт строковые поля из ответа модели, даже если JSON оборван.
 *
 * Модель упирается в maxTokens посреди строки — и JSON.parse отказывается
 * читать весь ответ целиком, хотя первые поля пришли полностью. Кириллица
 * стоит дороже в токенах, поэтому обрыв случается именно на русском тексте.
 */
function looseJsonFields(raw: string, fields: string[]): Record<string, string> {
  const clean = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  try {
    const parsed = JSON.parse(clean) as Record<string, unknown>
    return Object.fromEntries(fields.map((f) => [f, typeof parsed[f] === 'string' ? (parsed[f] as string) : '']))
  } catch {
    // вытаскиваем каждое поле по отдельности: оборванное останется частичным,
    // но всё, что успело прийти до обрыва, читается нормально
    const out: Record<string, string> = {}
    for (const field of fields) {
      const m = clean.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, 's'))
      out[field] = m?.[1] ? m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') : ''
    }
    return out
  }
}

export async function validateTask(
  projectId: string,
  input: { title: string; description: string; language: string },
): Promise<{ advice: string; suggestedTitle: string; suggestedDescription: string } | null> {
  const cfg = await projectLlm(projectId, 'validate_task')
  if (!cfg) return null
  const lang = LANG_NAMES[input.language] ?? input.language
  const text = await complete(cfg, {
    system: [
      `You review a task before it is saved to a tracker. Target language: ${lang}.`,
      'Give brief, actionable feedback: is the title clear and action-oriented? is the description specific enough (acceptance criteria, scope)? what is missing or ambiguous?',
      'Then propose an improved title and description WITHOUT inventing new requirements — only clarify and tidy what is given.',
      `Write "advice" and the suggestions in ${lang}.`,
      'Respond with ONLY a JSON object: {"advice": "...", "suggestedTitle": "...", "suggestedDescription": "..."}. No markdown, no extra text.',
    ].join('\n'),
    user: JSON.stringify({ title: input.title, description: input.description }),
    // 800 не хватало: на русском ответ обрывался посреди строки и JSON не читался
    maxTokens: 2000,
  })
  if (!text) return null
  {
    const f = looseJsonFields(text, ['advice', 'suggestedTitle', 'suggestedDescription'])
    // совет — единственное обязательное поле: без него показывать нечего
    if (f.advice) {
      return {
        advice: f.advice.slice(0, 2000),
        suggestedTitle: (f.suggestedTitle || input.title).slice(0, 300),
        suggestedDescription: (f.suggestedDescription || input.description).slice(0, 10_000),
      }
    }
    console.error('[llm] validateTask: unreadable response:', text.slice(0, 200))
    return null
  }
}

/**
 * Заметки ИИ к задаче (SPEC §8.14): факты / проблемы / рекомендации / опровержения.
 * Генерирует ТОЛЬКО при реальной необходимости — иначе пустой массив.
 * Тело заметки — markdown. Fail-open: null → нет заметок.
 */
export async function generateTaskNotes(
  projectId: string,
  input: { title: string; description: string; language: string; teamContext?: string },
): Promise<{ kind: 'fact' | 'issue' | 'recommendation' | 'rebuttal'; body: string }[] | null> {
  const cfg = await projectLlm(projectId, 'task_notes')
  if (!cfg) return null
  const lang = LANG_NAMES[input.language] ?? input.language
  const text = await complete(cfg, {
    system: [
      `You are a senior reviewer helping a team turn a raw task into a well-formed one. Target language: ${lang}.`,
      'People often oversimplify, over-complicate, or ask for things that cannot be done. Your job is to sanity-check and help.',
      'Produce NOTES only when GENUINELY useful — do NOT pad. If the task is clear and fine, return an empty array.',
      'Note kinds: "fact" (a relevant fact you know that helps), "issue" (a real problem/risk/ambiguity), "recommendation" (a concrete suggestion), "rebuttal" (something stated that is wrong or not feasible, with why).',
      input.teamContext ? `Team context:\n${input.teamContext}` : '',
      'Each note body is short markdown (you may use **bold**, lists, `code`).',
      `Write all note bodies in ${lang}.`,
      'Respond with ONLY a JSON array: [{"kind":"issue","body":"..."}]. Empty array [] if nothing worth noting. No extra text.',
    ]
      .filter(Boolean)
      .join('\n'),
    user: JSON.stringify({ title: input.title, description: input.description }),
    maxTokens: 2000, // массив заметок на языке проекта — см. комментарий выше
  })
  if (!text) return null
  try {
    const clean = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
    const parsed = JSON.parse(clean) as { kind?: string; body?: string }[]
    if (!Array.isArray(parsed)) return []
    const kinds = ['fact', 'issue', 'recommendation', 'rebuttal']
    return parsed
      .filter((n) => n && kinds.includes(String(n.kind)) && typeof n.body === 'string' && n.body.trim())
      .slice(0, 8)
      .map((n) => ({ kind: n.kind as 'fact', body: n.body!.slice(0, 2000) }))
  } catch {
    console.error('[llm] generateTaskNotes: bad JSON:', text.slice(0, 200))
    return null
  }
}
