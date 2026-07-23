import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { files, messages, sandboxMessages, users } from '../db/schema.js'
import { requireProject, type ProjectEnv } from '../auth.js'
import { broadcast, sendToUser } from '../ws.js'
import { evaluateMessage, sandboxReply, aiChatReply } from '../lib/dispatcher.js'
import { maybeCompress } from '../lib/memory.js'

// Чат (SPEC §5.5): pending → диспетчер → delivered | held(sandbox) → выбор → delivered.
// Вложения (files.messageId) прикрепляются до отправки и едут с финальным вариантом.
export const messagesRoute = new Hono<ProjectEnv>()
messagesRoute.use('*', requireProject)

type Attachment = { id: string; name: string; mime: string; size: number }

async function attachmentsOf(messageIds: string[]): Promise<Map<string, Attachment[]>> {
  if (messageIds.length === 0) return new Map()
  const rows = await db.select().from(files).where(inArray(files.messageId, messageIds))
  const map = new Map<string, Attachment[]>()
  for (const f of rows) {
    const list = map.get(f.messageId!) ?? []
    list.push({ id: f.id, name: f.name, mime: f.mime, size: Number(f.size) })
    map.set(f.messageId!, list)
  }
  return map
}

function serialize(
  row: typeof messages.$inferSelect,
  author?: typeof users.$inferSelect | null,
  attachments: Attachment[] = [],
) {
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    rawSend: row.rawSend,
    text: row.text,
    replyToId: row.replyToId,
    createdAt: row.createdAt,
    attachments,
    author: author ? { id: author.id, name: author.name, avatarUrl: author.avatarUrl } : null, // null = ИИ
  }
}

// История: delivered группы + свои ai/held/pending; курсор before
messagesRoute.get('/', zValidator('query', z.object({ before: z.string().optional() })), async (c) => {
  const { projectId, sub } = c.get('auth')
  const { before } = c.req.valid('query')

  const base = before
    ? and(eq(messages.projectId, projectId), lt(messages.createdAt, new Date(before)))
    : eq(messages.projectId, projectId)

  const rows = await db
    .select({ msg: messages, author: users })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorId))
    .where(base)
    .orderBy(desc(messages.createdAt))
    .limit(80)

  // видимость: group delivered — всем; свои любые; ai-режим — только участнику диалога
  const visible = rows
    .filter((r) => {
      if (r.msg.mode === 'ai') return r.msg.authorId === sub || r.msg.recipientId === sub
      return r.msg.status === 'delivered' || r.msg.authorId === sub
    })
    .slice(0, 50)
  const atts = await attachmentsOf(visible.map((r) => r.msg.id))
  return c.json(visible.map((r) => serialize(r.msg, r.author, atts.get(r.msg.id))).reverse())
})

// Отправка: pending → (асинхронно) диспетчер → delivered|held
messagesRoute.post(
  '/',
  zValidator(
    'json',
    z.object({
      text: z.string().min(1).max(20_000),
      mode: z.enum(['group', 'ai']).default('group'),
      replyToId: z.string().nullable().optional(),
      attachmentIds: z.array(z.string()).max(10).default([]),
      // raw: минуя диспетчер, с пометкой «без проверки» (split-кнопка «Отправить как есть»)
      raw: z.boolean().default(false),
    }),
  ),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    const { text, replyToId, attachmentIds, raw } = c.req.valid('json')
    let { mode } = c.req.valid('json')

    // @AI в группе → сообщение уходит в личный ИИ-канал, группа его не видит (по решению 2026-07-23)
    const mentionsAi = /@\[[^\]]*\]\(ai\)/.test(text)
    const redirectedToAi = mode === 'group' && mentionsAi
    if (redirectedToAi) mode = 'ai'

    // чисто файловые сообщения (без содержательного текста) не фильтруем — нечего оценивать
    const attachmentOnly = attachmentIds.length > 0 && (!text.trim() || text.trim() === '📎')

    const [row] = await db
      .insert(messages)
      .values({
        projectId,
        authorId: sub,
        recipientId: mode === 'ai' ? sub : null, // ai-диалог приватен
        mode,
        status: mode === 'group' && !raw && !attachmentOnly ? 'pending' : 'delivered',
        rawSend: raw,
        text,
        replyToId: replyToId ?? null,
      })
      .returning()

    // привязать вложения (только свои файлы проекта без владельца-сообщения)
    if (attachmentIds.length) {
      await db
        .update(files)
        .set({ messageId: row!.id })
        .where(and(inArray(files.id, attachmentIds), eq(files.projectId, projectId), eq(files.uploadedById, sub)))
    }

    const author = await db.query.users.findFirst({ where: eq(users.id, sub) })
    const atts = await attachmentsOf([row!.id])
    const message = serialize(row!, author, atts.get(row!.id))

    if (mode === 'ai') {
      // личный диалог с ИИ: память + инструменты, CRUD в пределах пермишенов юзера (SPEC §5.6)
      void (async () => {
        const answer = await aiChatReply(projectId, sub, text)
        if (!answer) return
        const [aiRow] = await db
          .insert(messages)
          .values({ projectId, authorId: null, recipientId: sub, mode: 'ai', status: 'delivered', text: answer })
          .returning()
        // ai-режим приватный: шлём только автору
        sendToUser(projectId, sub, 'message', serialize(aiRow!))
      })()
      return c.json({ ...message, redirectedToAi }, 201)
    }

    if (raw || attachmentOnly) {
      broadcast(projectId, 'message', message)
      void maybeCompress(projectId)
      return c.json(message, 201)
    }

    // остальным: «<имя> пишет…» (typing до вердикта)
    broadcast(projectId, 'checking', { userId: sub, name: author?.name ?? '' }, { except: sub })

    // асинхронная оценка — ответ клиенту не ждёт LLM
    void (async () => {
      const verdict = await evaluateMessage(row!.id)
      if (verdict.verdict === 'pass') {
        const [updated] = await db.update(messages).set({ status: 'delivered' }).where(eq(messages.id, row!.id)).returning()
        broadcast(projectId, 'message', serialize(updated!, author, atts.get(row!.id)))
        broadcast(projectId, 'checking_done', { userId: sub }, { except: sub })
        void maybeCompress(projectId) // фоновое сжатие памяти (SPEC §5.6)
      } else {
        await db.update(messages).set({ status: 'held' }).where(eq(messages.id, row!.id))
        // первый ход ИИ в sandbox: причина + вопросы (+ вариант, если есть)
        const intro = [verdict.reason, verdict.questions].filter(Boolean).join('\n')
        if (intro) await db.insert(sandboxMessages).values({ messageId: row!.id, role: 'ai', text: intro })
        if (verdict.suggestion)
          await db.insert(sandboxMessages).values({
            messageId: row!.id,
            role: 'ai',
            text: verdict.suggestion,
            suggestion: true,
            approved: true,
          })
        sendToUser(projectId, sub, 'held', { messageId: row!.id })
        broadcast(projectId, 'checking_done', { userId: sub }, { except: sub })
      }
    })()

    return c.json(message, 201)
  },
)

// --- Sandbox (только автор held-сообщения) ---------------------------------

async function heldMessageOf(c: { get: (k: 'auth') => ProjectEnv['Variables']['auth'] }, messageId: string) {
  const { projectId, sub } = c.get('auth')
  const msg = await db.query.messages.findFirst({
    where: and(eq(messages.id, messageId), eq(messages.projectId, projectId)),
  })
  if (!msg || msg.authorId !== sub || msg.status !== 'held') return null
  return msg
}

// Содержимое sandbox: исходник + диалог
messagesRoute.get('/:messageId/sandbox', async (c) => {
  const msg = await heldMessageOf(c, c.req.param('messageId'))
  if (!msg) return c.json({ error: 'Not found' }, 404)

  const items = await db.query.sandboxMessages.findMany({
    where: eq(sandboxMessages.messageId, msg.id),
    orderBy: [asc(sandboxMessages.createdAt)],
  })
  const atts = await attachmentsOf([msg.id])
  return c.json({
    original: { id: msg.id, text: msg.text, attachments: atts.get(msg.id) ?? [] },
    items: items.map((i) => ({ id: i.id, role: i.role, text: i.text, suggestion: i.suggestion, approved: i.approved, createdAt: i.createdAt })),
  })
})

// Реплика автора в sandbox → ответ ИИ (могут прийти новые варианты)
messagesRoute.post(
  '/:messageId/sandbox',
  zValidator('json', z.object({ text: z.string().min(1).max(10_000) })),
  async (c) => {
    const msg = await heldMessageOf(c, c.req.param('messageId'))
    if (!msg) return c.json({ error: 'Not found' }, 404)
    const { text } = c.req.valid('json')

    const { projectId, sub } = c.get('auth')
    const [userMsg] = await db.insert(sandboxMessages).values({ messageId: msg.id, role: 'user', text }).returning()

    // стриминг ответа ИИ автору («постепенная печать»)
    const reply = await sandboxReply(msg.id, (delta) =>
      sendToUser(projectId, sub, 'sandbox_chunk', { messageId: msg.id, delta }),
    )
    const created: (typeof sandboxMessages.$inferSelect)[] = [userMsg!]
    if (reply) {
      const [aiMsg] = await db.insert(sandboxMessages).values({ messageId: msg.id, role: 'ai', text: reply.text }).returning()
      created.push(aiMsg!)
      if (reply.suggestion) {
        const [sugg] = await db
          .insert(sandboxMessages)
          .values({ messageId: msg.id, role: 'ai', text: reply.suggestion, suggestion: true, approved: reply.approved })
          .returning()
        created.push(sugg!)
      }
    }
    return c.json(
      created.map((i) => ({ id: i.id, role: i.role, text: i.text, suggestion: i.suggestion, approved: i.approved, createdAt: i.createdAt })),
    )
  },
)

// «Выбрать» / «Отправить как есть» / force=«Послать всё равно» (с пометкой ⚠️ без проверки)
messagesRoute.post(
  '/:messageId/finalize',
  zValidator('json', z.object({ sandboxItemId: z.string().optional(), force: z.boolean().default(false) })),
  async (c) => {
    const { projectId } = c.get('auth')
    const msg = await heldMessageOf(c, c.req.param('messageId'))
    if (!msg) return c.json({ error: 'Not found' }, 404)
    const { sandboxItemId, force } = c.req.valid('json')

    const project = await db.query.projects.findFirst({ where: (p, { eq: e }) => e(p.id, projectId) })
    const mode = (JSON.parse(project?.aiConfig || '{}') as { mode?: string }).mode ?? 'assistant'

    let finalText = msg.text
    let rawSend = false
    if (sandboxItemId) {
      const item = await db.query.sandboxMessages.findFirst({
        where: and(eq(sandboxMessages.id, sandboxItemId), eq(sandboxMessages.messageId, msg.id)),
      })
      if (!item?.suggestion) return c.json({ error: 'Not a suggestion' }, 400)
      if (mode === 'moderator' && !item.approved && !force) return c.json({ error: 'Not approved by AI' }, 403)
      finalText = item.text
      rawSend = !item.approved && force
    } else if (mode === 'moderator' && !force) {
      // модератор: как-есть — только с force («Послать всё равно», уйдёт с пометкой)
      return c.json({ error: 'Moderator mode: choose an approved suggestion or force-send' }, 403)
    } else {
      // отправка исходника: в ассистенте — обычная, с force — помеченная
      rawSend = force
    }

    const [updated] = await db
      .update(messages)
      .set({ status: 'delivered', text: finalText, rawSend, createdAt: new Date() })
      .where(eq(messages.id, msg.id))
      .returning()

    const author = await db.query.users.findFirst({ where: eq(users.id, msg.authorId!) })
    const atts = await attachmentsOf([msg.id])
    const message = serialize(updated!, author, atts.get(msg.id))
    broadcast(projectId, 'message', message)
    return c.json(message)
  },
)

// Очистить личный ИИ-канал юзера — контекст с нуля
messagesRoute.delete('/ai', async (c) => {
  const { projectId, sub } = c.get('auth')
  await db
    .delete(messages)
    .where(
      and(
        eq(messages.projectId, projectId),
        eq(messages.mode, 'ai'),
        sql`(${messages.authorId} = ${sub} or ${messages.recipientId} = ${sub})`,
      ),
    )
  return c.json({ ok: true })
})

// Отменить held-сообщение (discard)
messagesRoute.delete('/:messageId', async (c) => {
  const msg = await heldMessageOf(c, c.req.param('messageId'))
  if (!msg) return c.json({ error: 'Not found' }, 404)
  await db.update(files).set({ messageId: null }).where(eq(files.messageId, msg.id))
  await db.delete(messages).where(eq(messages.id, msg.id))
  return c.json({ ok: true })
})
