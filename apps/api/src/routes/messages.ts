import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, desc, eq, gt, ilike, inArray, lt, lte, sql } from 'drizzle-orm'
import { companyOf, projectPath } from '../lib/links.js'
import { db } from '../db/client.js'
import { chatSummaries, credentials, documents, files, messages, notes, sandboxMessages, tasks, users } from '../db/schema.js'
import { requireProject, type ProjectEnv } from '../auth.js'
import { broadcast, sendToUser } from '../ws.js'
import { evaluateMessage, sandboxReply, aiChatReply } from '../lib/dispatcher.js'
import { imagesForMessage } from '../lib/vision.js'
import { maybeCompress } from '../lib/memory.js'
import { notify, extractMentions } from '../lib/notify.js'
import { projectRoleOf } from './projects.js'

// Письмо тем, кого упомянули в доставленном групповом сообщении (SPEC §8.9).
// Экспортируется: сообщения приходят и через мост, а упоминание должно
// уведомлять одинаково, кем бы оно ни было отправлено (SPEC §8.30).
export async function notifyChatMentions(
  projectId: string,
  messageId: string,
  text: string,
  author: { id: string; name: string } | null | undefined,
  replyToId?: string | null,
) {
  const recipients = new Set(extractMentions(text))

  // Ответ на сообщение — обращение к его автору, даже без @упоминания:
  // человек написал именно ему и вправе рассчитывать, что тот увидит.
  if (replyToId) {
    const parent = await db.query.messages.findFirst({ where: eq(messages.id, replyToId) })
    if (parent?.authorId) recipients.add(parent.authorId)
  }

  const mentioned = [...recipients]
  if (!mentioned.length) return
  await notify({
    projectId,
    event: 'chat_mention',
    recipientIds: mentioned,
    actorId: author?.id ?? null,
    actorName: author?.name || 'Someone',
    dedupeKey: `chat_mention:${messageId}`,
    link: projectPath((await companyOf(projectId)) ?? '', projectId, `/chat?msg=${messageId}`),
    preview: text,
    entityType: 'message',
    entityId: messageId,
  })
}

/** Что показать, когда ИИ не ответил. Лучше честная строка, чем вечное ожидание. */
const AI_FAILED_TEXT = '⚠️ Не получилось получить ответ. Попробуйте ещё раз.'

// Чат (SPEC §5.5): pending → диспетчер → delivered | held(sandbox) → выбор → delivered.
// Вложения (files.messageId) прикрепляются до отправки и едут с финальным вариантом.
export const messagesRoute = new Hono<ProjectEnv>()
messagesRoute.use('*', requireProject)

type Attachment = { id: string; name: string; mime: string; size: number; deleted?: boolean }
/**
 * Пин — ссылка на сущность проекта, приложенная к сообщению.
 *
 * Раньше пинились только задачи, поэтому колонка называется task_refs. Формат
 * расширен: строка «note:abc» вместо голого id. Старые записи (голый id)
 * читаются как задачи — переписывать историю ради переименования незачем.
 */
type PinKind = 'task' | 'note' | 'document' | 'resource'
type TaskPin = { id: string; kind: PinKind; number?: string; title: string; status?: string }

const parsePinRef = (ref: string): { kind: PinKind; id: string } => {
  const i = ref.indexOf(':')
  if (i < 0) return { kind: 'task', id: ref } // старый формат
  const kind = ref.slice(0, i) as PinKind
  return { kind: ['task', 'note', 'document', 'resource'].includes(kind) ? kind : 'task', id: ref.slice(i + 1) }
}

async function taskPinsOf(refs: string[], projectId: string): Promise<TaskPin[]> {
  if (!refs.length) return []
  const parsed = refs.map(parsePinRef)
  const byKind = (k: PinKind) => parsed.filter((p) => p.kind === k).map((p) => p.id)

  const out = new Map<string, TaskPin>()

  const taskIds = byKind('task')
  if (taskIds.length) {
    const rows = await db.query.tasks.findMany({ where: and(eq(tasks.projectId, projectId), inArray(tasks.id, taskIds)) })
    for (const t of rows) out.set(`task:${t.id}`, { id: t.id, kind: 'task', number: t.number, title: t.title, status: t.status })
  }

  const noteIds = byKind('note')
  if (noteIds.length) {
    const rows = await db.query.notes.findMany({ where: and(eq(notes.projectId, projectId), inArray(notes.id, noteIds)) })
    for (const n of rows) out.set(`note:${n.id}`, { id: n.id, kind: 'note', title: n.title })
  }

  const docIds = byKind('document')
  if (docIds.length) {
    const rows = await db.query.documents.findMany({
      where: and(eq(documents.projectId, projectId), inArray(documents.id, docIds)),
    })
    for (const d of rows) out.set(`document:${d.id}`, { id: d.id, kind: 'document', title: d.title })
  }

  const resIds = byKind('resource')
  if (resIds.length) {
    const rows = await db.query.credentials.findMany({
      where: and(eq(credentials.projectId, projectId), inArray(credentials.id, resIds)),
    })
    for (const r of rows) out.set(`resource:${r.id}`, { id: r.id, kind: 'resource', title: r.name })
  }

  // Порядок как прислали: человек ставил пины в осмысленной последовательности.
  return parsed.map((p) => out.get(`${p.kind}:${p.id}`)).filter(Boolean) as TaskPin[]
}

async function attachmentsOf(messageIds: string[]): Promise<Map<string, Attachment[]>> {
  if (messageIds.length === 0) return new Map()
  // включаем и soft-deleted — в чате показываем «файл удалён»
  const rows = await db.select().from(files).where(inArray(files.messageId, messageIds))
  const map = new Map<string, Attachment[]>()
  for (const f of rows) {
    const list = map.get(f.messageId!) ?? []
    list.push({ id: f.id, name: f.name, mime: f.mime, size: Number(f.size), deleted: Boolean(f.deletedAt) })
    map.set(f.messageId!, list)
  }
  return map
}

function serialize(
  row: typeof messages.$inferSelect,
  author?: typeof users.$inferSelect | null,
  attachments: Attachment[] = [],
  taskPins: TaskPin[] = [],
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
    taskPins,
    systemEvent: row.systemEvent, // системное автосообщение о задаче (SPEC §8.23)
    authorId: row.authorId,
    author: author ? { id: author.id, name: author.name, avatarUrl: author.avatarUrl } : null, // null = ИИ
  }
}

// Обогатить строки вложениями и пинами → сериализованные сообщения (asc)
async function enrich(rows: { msg: typeof messages.$inferSelect; author: typeof users.$inferSelect | null }[], projectId: string) {
  const atts = await attachmentsOf(rows.map((r) => r.msg.id))
  const allTaskIds = [...new Set(rows.flatMap((r) => (r.msg.taskRefs ? (JSON.parse(r.msg.taskRefs) as string[]) : [])))]
  const pinMap = new Map((await taskPinsOf(allTaskIds, projectId)).map((p) => [p.id, p]))
  const pinsFor = (refs: string | null) => (refs ? (JSON.parse(refs) as string[]).map((id) => pinMap.get(id)).filter(Boolean) as TaskPin[] : [])
  return rows.map((r) => serialize(r.msg, r.author, atts.get(r.msg.id), pinsFor(r.msg.taskRefs)))
}

const canSee = (m: typeof messages.$inferSelect, sub: string) =>
  m.mode === 'ai' ? m.authorId === sub || m.recipientId === sub : m.status === 'delivered' || m.authorId === sub

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

  const visible = rows.filter((r) => canSee(r.msg, sub)).slice(0, 50)
  const enriched = await enrich(visible, projectId)
  return c.json(enriched.reverse())
})

// Контекст вокруг сообщения (для «перейти к переписке»): окно ±25 сообщений
messagesRoute.get('/context', zValidator('query', z.object({ around: z.string() })), async (c) => {
  const { projectId, sub } = c.get('auth')
  const { around } = c.req.valid('query')

  const target = await db.query.messages.findFirst({ where: and(eq(messages.id, around), eq(messages.projectId, projectId)) })
  if (!target) return c.json({ error: 'Not found' }, 404)

  const olderRows = await db
    .select({ msg: messages, author: users })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorId))
    .where(and(eq(messages.projectId, projectId), eq(messages.mode, 'group'), lte(messages.createdAt, target.createdAt)))
    .orderBy(desc(messages.createdAt))
    .limit(26)
  const newerRows = await db
    .select({ msg: messages, author: users })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorId))
    .where(and(eq(messages.projectId, projectId), eq(messages.mode, 'group'), gt(messages.createdAt, target.createdAt)))
    .orderBy(asc(messages.createdAt))
    .limit(26)

  const hasOlder = olderRows.length > 25
  const hasNewer = newerRows.length > 25
  const merged = [...olderRows.slice(0, 25).reverse(), ...newerRows.slice(0, 25)].filter((r) => canSee(r.msg, sub))
  const enriched = await enrich(merged, projectId)
  return c.json({ messages: enriched, hasOlder, hasNewer })
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
      taskRefs: z.array(z.string()).max(10).default([]), // прикреплённые задачи (пины)
      // raw: минуя диспетчер, с пометкой «без проверки» (split-кнопка «Отправить как есть»)
      raw: z.boolean().default(false),
    }),
  ),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    const { text, replyToId, attachmentIds, taskRefs } = c.req.valid('json')
    let { mode } = c.req.valid('json')

    // Отправка мимо проверки ИИ — привилегия руководства проекта: правила чата
    // держатся на этой проверке, и обходить её всем подряд значит не иметь
    // правил вовсе. Молча игнорируем флаг, а не отказываем: сообщение всё
    // равно уйдёт, просто обычным путём.
    const membership = await projectRoleOf(projectId, sub)
    const mayBypass = membership?.role === 'owner' || membership?.role === 'admin'
    const raw = c.req.valid('json').raw && mayBypass

    // @AI в группе → сообщение уходит в личный ИИ-канал, группа его не видит (по решению 2026-07-23)
    const mentionsAi = /@\[[^\]]*\]\(ai\)/.test(text)
    const redirectedToAi = mode === 'group' && mentionsAi
    if (redirectedToAi) mode = 'ai'

    // файловые/пиновые сообщения (без содержательного текста) не фильтруем — нечего оценивать
    const attachmentOnly = (attachmentIds.length > 0 || taskRefs.length > 0) && (!text.trim() || text.trim() === '📎')

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
        taskRefs: taskRefs.length ? JSON.stringify(taskRefs) : null,
        replyToId: replyToId ?? null,
      })
      .returning()

    // привязать вложения (только свои файлы проекта без владельца-сообщения);
    // снимаем временный флаг — файл становится постоянным (SPEC §8.17)
    if (attachmentIds.length) {
      /**
       * В личном диалоге с ассистентом файл остаётся ВРЕМЕННЫМ.
       *
       * Снять флаг — значит навсегда положить в проект каждый скриншот,
       * который человек показал ассистенту «посмотри, что тут». Это дорога в
       * свалку: файлы копятся, место занимают, а нужны были на одну реплику.
       *
       * Уборщик удалит их через сутки сам (lib/file-cleanup.ts). Захочет
       * человек сохранить — ассистент предложит, и файл станет постоянным
       * отдельным действием.
       */
      await db
        .update(files)
        .set({ messageId: row!.id, ...(mode === 'ai' ? {} : { pendingUntil: null }) })
        .where(and(inArray(files.id, attachmentIds), eq(files.projectId, projectId), eq(files.uploadedById, sub)))
    }

    const author = await db.query.users.findFirst({ where: eq(users.id, sub) })
    const atts = await attachmentsOf([row!.id])
    const pins = await taskPinsOf(taskRefs, projectId)
    const message = serialize(row!, author, atts.get(row!.id), pins)

    if (mode === 'ai') {
      // личный диалог с ИИ: память + инструменты, CRUD в пределах пермишенов юзера (SPEC §5.6)
      void (async () => {
        // Молчать при сбое нельзя: клиент ждёт ответа и показывает «ИИ думает…»
        // до тех пор, пока не придёт сообщение. Пустой ответ или упавший вызов
        // оставляли индикатор висеть навсегда, и написать заново было нельзя.
        let answer: string | null = null
        try {
          // Картинки — только если человек попросил посмотреть. Правило
          // исполняется здесь, а не в промпте: изображение, уехавшее в
          // запрос, уже увидено и уже оплачено.
          const images = await imagesForMessage(row!.id, projectId, text)
          answer = await aiChatReply(projectId, sub, text, images)
        } catch (e) {
          console.error('[ai-chat] reply failed:', e)
        }
        const [aiRow] = await db
          .insert(messages)
          .values({
            projectId,
            authorId: null,
            recipientId: sub,
            mode: 'ai',
            status: 'delivered',
            text: answer || AI_FAILED_TEXT,
          })
          .returning()
        // ai-режим приватный: шлём только автору
        sendToUser(projectId, sub, 'message', serialize(aiRow!))
      })()
      return c.json({ ...message, redirectedToAi }, 201)
    }

    if (raw || attachmentOnly) {
      broadcast(projectId, 'message', message)
      void notifyChatMentions(projectId, row!.id, text, author, replyToId)
      void maybeCompress(projectId)
      return c.json(message, 201)
    }

    // остальным: «<имя> пишет…» (typing до вердикта)
    broadcast(projectId, 'checking', { userId: sub, name: author?.name ?? '' }, { except: sub })

    // асинхронная оценка — ответ клиенту не ждёт LLM
    void (async () => {
      const verdict = await evaluateMessage(row!.id)
      if (verdict.verdict === 'pass') {
        // Проверка не отработала (сбой ИИ) — доставляем, но честно помечаем
        // «без проверки», иначе неработающая модерация выглядит как работающая.
        const unchecked = verdict.unchecked === true
        const [updated] = await db
          .update(messages)
          .set({ status: 'delivered', ...(unchecked ? { rawSend: true } : {}) })
          .where(eq(messages.id, row!.id))
          .returning()
        broadcast(projectId, 'message', serialize(updated!, author, atts.get(row!.id)))
        void notifyChatMentions(projectId, row!.id, text, author, replyToId)
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
    void notifyChatMentions(projectId, msg.id, finalText, author, msg.replyToId)
    return c.json(message)
  },
)

// Поиск по сообщениям чата: только ТЕКСТ (файлы/ссылки живут в Файлах/Ресурсах — SPEC §8.4)
messagesRoute.get(
  '/search',
  zValidator(
    'query',
    z.object({
      q: z.string().default(''),
      from: z.string().optional(),
      to: z.string().optional(),
    }),
  ),
  async (c) => {
    const { projectId } = c.get('auth')
    const { q, from, to } = c.req.valid('query')
    const needle = q.trim()

    const conds = [eq(messages.projectId, projectId), eq(messages.mode, 'group'), eq(messages.status, 'delivered')]
    if (needle) conds.push(ilike(messages.text, `%${needle}%`))
    if (from && !isNaN(Date.parse(from))) conds.push(sql`${messages.createdAt} >= ${new Date(from)}`)
    if (to && !isNaN(Date.parse(to))) conds.push(sql`${messages.createdAt} <= ${new Date(to + 'T23:59:59')}`)

    const rows = await db
      .select({ msg: messages, author: users })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.authorId))
      .where(and(...conds))
      .orderBy(desc(messages.createdAt))
      .limit(40)

    const atts = await attachmentsOf(rows.map((r) => r.msg.id))
    return c.json(rows.map((r) => ({ ...serialize(r.msg, r.author, atts.get(r.msg.id)) })))
  },
)

// История (SPEC §8.5): дневные саммари бесед, для ручного просмотра между датами.
messagesRoute.get(
  '/history',
  zValidator('query', z.object({ q: z.string().optional(), from: z.string().optional(), to: z.string().optional() })),
  async (c) => {
    const { projectId } = c.get('auth')
    const { q, from, to } = c.req.valid('query')
    const conds = [eq(chatSummaries.projectId, projectId)]
    if (q && q.trim())
      conds.push(sql`(${chatSummaries.name} ilike ${'%' + q.trim() + '%'} or ${chatSummaries.content} ilike ${'%' + q.trim() + '%'})`)
    if (from && !isNaN(Date.parse(from))) conds.push(sql`${chatSummaries.toAt} >= ${new Date(from)}`)
    if (to && !isNaN(Date.parse(to))) conds.push(sql`${chatSummaries.fromAt} <= ${new Date(to + 'T23:59:59')}`)

    const rows = await db
      .select()
      .from(chatSummaries)
      .where(and(...conds))
      .orderBy(desc(chatSummaries.toAt))
      .limit(200)

    return c.json(
      rows.map((s) => ({
        id: s.id,
        name: s.name,
        content: s.content,
        fromAt: s.fromAt,
        toAt: s.toAt,
        messageCount: Number(s.messageCount),
      })),
    )
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

// Удалить сообщение из группы — автор, owner или admin проекта
messagesRoute.post('/:messageId/remove', async (c) => {
  const { projectId, sub, role } = c.get('auth')
  const messageId = c.req.param('messageId')
  const msg = await db.query.messages.findFirst({
    where: and(eq(messages.id, messageId), eq(messages.projectId, projectId), eq(messages.mode, 'group')),
  })
  if (!msg) return c.json({ error: 'Not found' }, 404)
  const allowed = msg.authorId === sub || role === 'owner' || role === 'admin'
  if (!allowed) return c.json({ error: 'Forbidden' }, 403)

  await db.update(files).set({ messageId: null }).where(eq(files.messageId, msg.id))
  await db.delete(messages).where(eq(messages.id, msg.id))
  broadcast(projectId, 'message_deleted', { messageId })
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
