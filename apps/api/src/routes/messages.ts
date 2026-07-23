import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, lt } from 'drizzle-orm'
import { db } from '../db/client.js'
import { messages, users } from '../db/schema.js'
import { requireProject, type ProjectEnv } from '../auth.js'
import { broadcast } from '../ws.js'

// Сообщения чата (project-токен). Текст — markdown.
// Пока status=delivered сразу; ИИ-диспетчер (pending→delivered/held/routed) — следующий слой.
export const messagesRoute = new Hono<ProjectEnv>()
messagesRoute.use('*', requireProject)

function serialize(row: typeof messages.$inferSelect, author?: typeof users.$inferSelect | null) {
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    text: row.text,
    replyToId: row.replyToId,
    createdAt: row.createdAt,
    author: author ? { id: author.id, name: author.name, avatarUrl: author.avatarUrl } : null, // null = ИИ
  }
}

// История: последние 50, курсор before=<messageId createdAt iso>
messagesRoute.get('/', zValidator('query', z.object({ before: z.string().optional() })), async (c) => {
  const { projectId } = c.get('auth')
  const { before } = c.req.valid('query')

  const where = before
    ? and(eq(messages.projectId, projectId), lt(messages.createdAt, new Date(before)))
    : eq(messages.projectId, projectId)

  const rows = await db
    .select({ msg: messages, author: users })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorId))
    .where(where)
    .orderBy(desc(messages.createdAt))
    .limit(50)

  return c.json(rows.map((r) => serialize(r.msg, r.author)).reverse())
})

// Отправка
messagesRoute.post(
  '/',
  zValidator(
    'json',
    z.object({
      text: z.string().min(1).max(20_000),
      mode: z.enum(['group', 'ai']).default('group'),
      replyToId: z.string().nullable().optional(),
    }),
  ),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    const { text, mode, replyToId } = c.req.valid('json')

    const [row] = await db
      .insert(messages)
      .values({ projectId, authorId: sub, mode, status: 'delivered', text, replyToId: replyToId ?? null })
      .returning()

    const author = await db.query.users.findFirst({ where: eq(users.id, sub) })
    const message = serialize(row!, author)

    // realtime всем в проекте (кроме ai-режима — личный диалог не бродкастим группе)
    if (mode === 'group') broadcast(projectId, 'message', message)

    return c.json(message, 201)
  },
)
