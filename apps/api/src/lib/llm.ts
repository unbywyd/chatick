import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companies, projects } from '../db/schema.js'
import { decrypt } from './crypto.js'

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
    defaultModel: 'deepseek-chat',
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

export type LlmConfig = { provider: LlmProvider; model: string; apiKey: string }

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

/** Настройки LLM по проекту (через его компанию). */
export async function projectLlm(projectId: string): Promise<LlmConfig | null> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  return project ? companyLlm(project.companyId) : null
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
          max_tokens: opts.maxTokens ?? 1024,
          system: opts.system,
          messages: [{ role: 'user', content: opts.user }],
        }),
      })
      if (!res.ok) {
        console.error('[llm] anthropic failed:', res.status, await res.text().catch(() => ''))
        return null
      }
      const data = (await res.json()) as { content?: { type: string; text?: string }[] }
      return data.content?.find((b) => b.type === 'text')?.text ?? null
    }

    // OpenAI-compatible (openai / google / deepseek / groq)
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: opts.maxTokens ?? 1024,
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
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
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
  const maxIter = opts.maxIterations ?? 5
  try {
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
        }
        if (data.stop_reason !== 'tool_use') {
          return data.content.find((b) => b.type === 'text')?.text ?? null
        }
        msgs.push({ role: 'assistant', content: data.content })
        const results = await Promise.all(
          data.content
            .filter((b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => b.type === 'tool_use')
            .map(async (b) => ({
              type: 'tool_result',
              tool_use_id: b.id,
              content: (await opts.handlers[b.name]?.(b.input).catch((e) => `Error: ${e}`)) ?? 'Unknown tool',
            })),
        )
        msgs.push({ role: 'user', content: results })
      }
      return null // не сошлось за maxIter
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
      }
      const msg = data.choices?.[0]?.message
      if (!msg) return null
      if (!msg.tool_calls?.length) return msg.content ?? null
      msgs.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls })
      for (const call of msg.tool_calls) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(call.function.arguments || '{}')
        } catch { /* пустые аргументы */ }
        const result = (await opts.handlers[call.function.name]?.(args).catch((e) => `Error: ${e}`)) ?? 'Unknown tool'
        msgs.push({ role: 'tool', tool_call_id: call.id, content: result })
      }
    }
    return null
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
              max_tokens: opts.maxTokens ?? 1024,
              system: opts.system,
              messages: [{ role: 'user', content: opts.user }],
              stream: true,
            }
          : {
              model: cfg.model,
              max_tokens: opts.maxTokens ?? 1024,
              messages: [
                { role: 'system', content: opts.system },
                { role: 'user', content: opts.user },
              ],
              stream: true,
            },
      ),
    })
    if (!res.ok || !res.body) {
      console.error('[llm] stream failed:', res.status, await res.text().catch(() => ''))
      return null
    }

    let full = ''
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
          const delta = isAnthropic
            ? ((json as { type?: string; delta?: { type?: string; text?: string } }).type === 'content_block_delta'
                ? (json as { delta?: { text?: string } }).delta?.text
                : undefined)
            : (json as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content
          if (delta) {
            full += delta
            onChunk(delta)
          }
        } catch {
          /* пропускаем неполные чанки */
        }
      }
    }
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
  const cfg = await projectLlm(projectId)
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
    maxTokens: 600,
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
