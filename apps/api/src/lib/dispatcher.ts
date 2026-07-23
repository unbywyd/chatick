import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { messages, projects, sandboxMessages, users } from '../db/schema.js'
import { projectLlm, complete, type LlmConfig } from './llm.js'

// ИИ-диспетчер (SPEC §5.5): оценка сообщений группы (PASS/HOLD) и sandbox-диалог.
// Все ответы модели — строгий JSON; парсинг устойчив к ```json обёрткам.

type AiConfig = {
  mode?: 'observer' | 'assistant' | 'moderator'
  language?: string
  answerRepeats?: boolean
  offtopic?: 'ignore' | 'remind' | 'hold'
}

const LANG_NAMES: Record<string, string> = { en: 'English', ru: 'Russian', he: 'Hebrew' }

function parseJson<T>(text: string | null): T | null {
  if (!text) return null
  try {
    return JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) as T
  } catch {
    console.error('[dispatcher] bad JSON from LLM:', text.slice(0, 200))
    return null
  }
}

async function recentContext(projectId: string, excludeId: string, limit = 15): Promise<string> {
  const rows = await db
    .select({ msg: messages, author: users })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorId))
    .where(and(eq(messages.projectId, projectId), eq(messages.mode, 'group'), eq(messages.status, 'delivered')))
    .orderBy(desc(messages.createdAt))
    .limit(limit)
  return rows
    .reverse()
    .filter((r) => r.msg.id !== excludeId)
    .map((r) => `${r.author?.name ?? 'AI'}: ${r.msg.text}`)
    .join('\n')
}

function dispatcherSystem(project: { chatRules: string }, ai: AiConfig, authorName: string): string {
  const lang = LANG_NAMES[ai.language ?? 'en'] ?? ai.language ?? 'English'
  return [
    `You are the AI dispatcher of a team project chat. Project language: ${lang}.`,
    `Author of the incoming message: ${authorName}.`,
    ai.mode === 'moderator'
      ? 'Mode: MODERATOR — hold messages that are unclear, duplicate already-answered questions, or violate the rules.'
      : 'Mode: ASSISTANT — be permissive; hold ONLY messages that clearly violate the rules or are impossible to understand. When unsure, PASS.',
    project.chatRules ? `Chat rules set by the team: "${project.chatRules}"` : 'No special chat rules.',
    ai.offtopic === 'hold'
      ? 'Off-topic messages must be held.'
      : 'Off-topic is tolerated (do not hold for off-topic alone).',
    '',
    'Decide: PASS (deliver to the group as-is) or HOLD (needs a private clarification with the author).',
    'Respond with ONLY JSON:',
    '{"verdict":"pass"} or {"verdict":"hold","reason":"<short reason in the AUTHOR\'S language>","questions":"<what to clarify, author\'s language>","suggestion":"<improved message in the PROJECT language, or empty>"}',
    'Keep reason/questions to 1-2 sentences. Suggestion must preserve the author\'s meaning.',
  ].join('\n')
}

export type Verdict =
  | { verdict: 'pass' }
  | { verdict: 'hold'; reason: string; questions?: string; suggestion?: string }

/** Оценка входящего группового сообщения. Fail-open: нет LLM / сбой → pass. */
export async function evaluateMessage(messageId: string): Promise<Verdict> {
  const msg = await db.query.messages.findFirst({ where: eq(messages.id, messageId) })
  if (!msg) return { verdict: 'pass' }
  const project = await db.query.projects.findFirst({ where: eq(projects.id, msg.projectId) })
  if (!project) return { verdict: 'pass' }

  const ai = JSON.parse(project.aiConfig || '{}') as AiConfig
  // observer не фильтрует вовсе
  if ((ai.mode ?? 'assistant') === 'observer') return { verdict: 'pass' }

  const cfg = await projectLlm(msg.projectId)
  if (!cfg) return { verdict: 'pass' }

  const author = msg.authorId ? await db.query.users.findFirst({ where: eq(users.id, msg.authorId) }) : null
  const context = await recentContext(msg.projectId, msg.id)

  const raw = await complete(cfg, {
    system: dispatcherSystem(project, ai, author?.name ?? 'Unknown'),
    user: `Recent chat:\n${context || '(empty)'}\n\nIncoming message:\n${msg.text}`,
    maxTokens: 500,
  })
  const parsed = parseJson<Verdict>(raw)
  if (!parsed || (parsed.verdict !== 'pass' && parsed.verdict !== 'hold')) return { verdict: 'pass' }
  return parsed
}

/** Ответ ИИ в sandbox-диалоге: помогает довести сообщение, предлагает варианты. */
export async function sandboxReply(messageId: string): Promise<{
  text: string
  suggestion: string | null
  approved: boolean
} | null> {
  const msg = await db.query.messages.findFirst({ where: eq(messages.id, messageId) })
  if (!msg) return null
  const project = await db.query.projects.findFirst({ where: eq(projects.id, msg.projectId) })
  if (!project) return null
  const cfg = await projectLlm(msg.projectId)
  if (!cfg) return null

  const ai = JSON.parse(project.aiConfig || '{}') as AiConfig
  const lang = LANG_NAMES[ai.language ?? 'en'] ?? 'English'
  const history = await db.query.sandboxMessages.findMany({
    where: eq(sandboxMessages.messageId, messageId),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  })
  const context = await recentContext(msg.projectId, msg.id, 10)

  const raw = await complete(cfg, {
    system: [
      `You help an author finalize a held chat message. Project language: ${lang}.`,
      project.chatRules ? `Chat rules: "${project.chatRules}"` : '',
      'Talk to the author in THEIR language. Be brief and practical.',
      'When you have a message version ready for the group chat (in the project language, respecting the rules), include it as "suggestion" and set "approved":true if it is good to send.',
      'Respond with ONLY JSON: {"text":"<your reply to the author>","suggestion":"<message version or empty>","approved":true|false}',
    ]
      .filter(Boolean)
      .join('\n'),
    user: [
      `Group chat context:\n${context || '(empty)'}`,
      `Original held message:\n${msg.text}`,
      `Sandbox conversation so far:`,
      ...history.map((h) => `${h.role === 'user' ? 'Author' : 'You'}: ${h.text}`),
    ].join('\n\n'),
    maxTokens: 800,
  })

  const parsed = parseJson<{ text?: string; suggestion?: string; approved?: boolean }>(raw)
  if (!parsed?.text) return null
  return {
    text: parsed.text,
    suggestion: parsed.suggestion?.trim() || null,
    approved: Boolean(parsed.approved && parsed.suggestion?.trim()),
  }
}
