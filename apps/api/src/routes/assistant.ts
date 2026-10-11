import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm'
import { db } from '../db/client.js'
import { assistantMessages, companyMembers, files } from '../db/schema.js'
import { myProjects } from './ball.js'
import { requireSession, type SessionEnv } from '../auth.js'
import { assistantReply, type ScreenContext } from '../lib/assistant.js'
import { sendToUserAnywhere } from '../ws.js'

/**
 * Ассистент компании (v2): разговор человека с ИИ — один на компанию.
 *
 * Ответ не держит запрос: модель с инструментами думает десятки секунд, и
 * держать HTTP столько — значит ловить таймауты прокси. Сообщение человека
 * сохраняется сразу, ответ приходит по сокету событием 'assistant'
 * ({companyId, action: 'thinking' | 'message', id}) — так же, как ИИ-чат
 * проекта, только адресно человеку, где бы он ни был.
 */
export const assistantRoute = new Hono<SessionEnv>()
assistantRoute.use('*', requireSession)

/** Один ответ за раз на человека и компанию: второй вопрос до ответа на первый перепутал бы историю. */
const busy = new Set<string>()

async function member(companyId: string, userId: string) {
  return db.query.companyMembers.findFirst({
    where: and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId)),
  })
}

const view = (m: typeof assistantMessages.$inferSelect) => ({
  id: m.id,
  role: m.role,
  text: m.text,
  context: JSON.parse(m.context || '{}') as ScreenContext,
  tools: JSON.parse(m.tools || '[]') as string[],
  failed: m.failed,
  createdAt: m.createdAt,
})

assistantRoute.get('/:companyId/messages', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  if (!(await member(companyId, sub))) return c.json({ error: 'Forbidden' }, 403)
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 50))
  const before = c.req.query('before')
  const rows = await db
    .select()
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.companyId, companyId),
        eq(assistantMessages.userId, sub),
        ...(before ? [lt(assistantMessages.createdAt, new Date(before))] : []),
      ),
    )
    .orderBy(desc(assistantMessages.createdAt))
    .limit(limit)
  return c.json({ items: rows.reverse().map(view), busy: busy.has(`${sub}:${companyId}`) })
})

assistantRoute.post(
  '/:companyId/messages',
  zValidator(
    'json',
    z.object({
      text: z.string().trim().min(1).max(8000),
      context: z
        .object({
          projectId: z.string().optional(),
          taskId: z.string().optional(),
          screen: z.string().max(100).optional(),
          /** Свои файлы, загруженные временно в проект (скриншот к вопросу). */
          fileIds: z.array(z.string()).max(6).optional(),
        })
        .optional(),
    }),
  ),
  async (c) => {
    const { sub } = c.get('session')
    const companyId = c.req.param('companyId')
    if (!(await member(companyId, sub))) return c.json({ error: 'Forbidden' }, 403)
    const key = `${sub}:${companyId}`
    if (busy.has(key)) return c.json({ error: 'busy', hint: 'Wait for the answer to the previous message.' }, 409)

    const b = c.req.valid('json')
    const screen: ScreenContext = b.context ?? {}
    // Вложения — только свои и только из проектов этой компании, где человек
    // состоит: иначе через ассистента можно было бы показать модели чужой файл.
    if (screen.fileIds?.length) {
      const allowed = new Set((await myProjects(companyId, sub)).map((p) => p.id))
      const rows = await db
        .select({ id: files.id, projectId: files.projectId })
        .from(files)
        .where(and(inArray(files.id, screen.fileIds), eq(files.uploadedById, sub), isNull(files.deletedAt)))
      screen.fileIds = rows.filter((r) => r.projectId && allowed.has(r.projectId)).map((r) => r.id)
      if (!screen.fileIds.length) delete screen.fileIds
    }
    const [mine] = await db
      .insert(assistantMessages)
      .values({ companyId, userId: sub, role: 'user', text: b.text, context: JSON.stringify(screen) })
      .returning()

    busy.add(key)
    sendToUserAnywhere(sub, 'assistant', { companyId, action: 'thinking', id: mine!.id })
    void (async () => {
      try {
        const r = await assistantReply({ companyId, userId: sub, text: b.text, screen }).catch((e) => {
          console.error('[assistant] reply failed:', e)
          return null
        })
        const [answer] = await db
          .insert(assistantMessages)
          .values({
            companyId,
            userId: sub,
            role: 'assistant',
            // Язык клиента сервер не знает — текст отказа клиент подставит
            // сам по failed: true. Здесь пустая строка.
            text: r?.text ?? '',
            tools: JSON.stringify(r?.tools ?? []),
            failed: !r,
          })
          .returning()
        sendToUserAnywhere(sub, 'assistant', { companyId, action: 'message', id: answer!.id })
      } finally {
        busy.delete(key)
      }
    })()

    return c.json(view(mine!), 202)
  },
)

/** Начать разговор заново. Чужую историю не трогает: только свою в этой компании. */
assistantRoute.delete('/:companyId/messages', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  if (!(await member(companyId, sub))) return c.json({ error: 'Forbidden' }, 403)
  await db.delete(assistantMessages).where(and(eq(assistantMessages.companyId, companyId), eq(assistantMessages.userId, sub)))
  return c.json({ ok: true })
})
