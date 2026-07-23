import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { messages, projects, sandboxMessages, users } from '../db/schema.js'
import { projectLlm, complete, completeStream } from './llm.js'

// ИИ-диспетчер (SPEC §5.5): оценка сообщений группы (PASS/HOLD) и sandbox-диалог.
// Все ответы модели — строгий JSON; парсинг устойчив к ```json обёрткам.

type AiConfig = {
  mode?: 'observer' | 'assistant' | 'moderator'
  language?: string
  answerRepeats?: boolean
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
    `You are the AI dispatcher of a team project chat. PROJECT LANGUAGE: ${lang} — the chat is conducted ONLY in it.`,
    `Author of the incoming message: ${authorName}.`,
    ai.mode === 'moderator'
      ? 'Mode: MODERATOR — hold messages that are unclear, off-topic, duplicate already-answered questions, or violate the rules.'
      : 'Mode: ASSISTANT — be permissive with content; hold ONLY messages that clearly violate the rules, are off-topic, or impossible to understand. When unsure, PASS.',
    `LANGUAGE RULE (always enforced): if the message is NOT in ${lang}, HOLD it and provide a faithful ${lang} translation as the suggestion (mark it good to send).`,
    project.chatRules ? `Chat rules set by the team: "${project.chatRules}"` : 'No special chat rules.',
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

/**
 * Ответ ИИ в sandbox-диалоге: помогает довести сообщение, предлагает варианты.
 * onChunk — стриминг «text»-части ответа для постепенной печати (SPEC: streaming).
 */
export async function sandboxReply(
  messageId: string,
  onChunk?: (delta: string) => void,
): Promise<{
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

  // формат под стриминг: свободный ответ (стримится) → маркеры с вариантом
  const system = [
    `You help an author finalize a held chat message. Project language: ${lang}.`,
    project.chatRules ? `Chat rules: "${project.chatRules}"` : '',
    'Talk to the author in THEIR language. Be brief and practical.',
    'Format your response EXACTLY like this:',
    '<your reply to the author>',
    'Then, if you have a message version ready for the group chat (project language, rules respected), add:',
    '---SUGGESTION---',
    '<the message version>',
    '---APPROVED--- (add this line ONLY if the version is good to send as-is)',
  ]
    .filter(Boolean)
    .join('\n')
  const user = [
    `Group chat context:\n${context || '(empty)'}`,
    `Original held message:\n${msg.text}`,
    `Sandbox conversation so far:`,
    ...history.map((h) => `${h.role === 'user' ? 'Author' : 'You'}: ${h.text}`),
  ].join('\n\n')

  let streamedPastMarker = false
  let buffer = ''
  const raw = await completeStream(
    cfg,
    { system, user, maxTokens: 800 },
    (delta) => {
      if (streamedPastMarker || !onChunk) return
      buffer += delta
      const idx = buffer.indexOf('---SUGGESTION---')
      if (idx >= 0) {
        streamedPastMarker = true
        const before = buffer.slice(0, idx)
        // дослать хвост до маркера (сколько ещё не ушло)
        const sentLen = buffer.length - delta.length
        if (before.length > sentLen) onChunk(before.slice(sentLen))
      } else {
        onChunk(delta)
      }
    },
  )
  if (!raw) return null

  const [textPart, rest] = raw.split('---SUGGESTION---')
  const approved = rest?.includes('---APPROVED---') ?? false
  const suggestion = rest?.replace('---APPROVED---', '').trim() || null
  return { text: (textPart ?? '').trim(), suggestion, approved: Boolean(approved && suggestion) }
}
