import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, ilike, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../db/client.js'
import { documents, users } from '../db/schema.js'
import { requireProject, type ProjectEnv } from '../auth.js'
import { hasPermission } from './projects.js'
import { logActivity } from '../lib/audit.js'
import { broadcast } from '../ws.js'

// Документы проекта (SPEC §8.24). Project-токен + отдельный публичный роут по слагу.
export const documentsRoute = new Hono<ProjectEnv>()
documentsRoute.use('*', requireProject)

const serialize = (d: typeof documents.$inferSelect, author?: { id: string; name: string; avatarUrl: string | null } | null) => ({
  id: d.id,
  title: d.title,
  content: d.content,
  publicSlug: d.publicSlug,
  updatedAt: d.updatedAt,
  createdAt: d.createdAt,
  author: author ?? null,
})

// Список документов (без полного контента — только превью)
documentsRoute.get('/', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'documents.read'))) return c.json({ error: 'Forbidden' }, 403)
  const q = (c.req.query('q') ?? '').trim()
  const base = and(eq(documents.projectId, projectId), sql`${documents.deletedAt} is null`)
  const rows = await db
    .select({ d: documents, author: users })
    .from(documents)
    .leftJoin(users, eq(users.id, documents.updatedById))
    .where(q ? and(base, ilike(documents.title, `%${q}%`)) : base)
    .orderBy(desc(documents.updatedAt))
    .limit(200)
  return c.json(
    rows.map((r) => ({
      id: r.d.id,
      title: r.d.title || '—',
      preview: r.d.content.replace(/[#*_`>\-\[\]]/g, '').slice(0, 160),
      publicSlug: r.d.publicSlug,
      updatedAt: r.d.updatedAt,
      author: r.author ? { id: r.author.id, name: r.author.name, avatarUrl: r.author.avatarUrl } : null,
    })),
  )
})

// Один документ с полным контентом
documentsRoute.get('/:id', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'documents.read'))) return c.json({ error: 'Forbidden' }, 403)
  const d = await db.query.documents.findFirst({
    where: and(eq(documents.id, c.req.param('id')), eq(documents.projectId, projectId), sql`${documents.deletedAt} is null`),
  })
  if (!d) return c.json({ error: 'Not found' }, 404)
  const author = d.updatedById ? await db.query.users.findFirst({ where: eq(users.id, d.updatedById) }) : null
  return c.json(serialize(d, author ? { id: author.id, name: author.name, avatarUrl: author.avatarUrl } : null))
})

// Создать
documentsRoute.post(
  '/',
  zValidator('json', z.object({ title: z.string().max(300).default(''), content: z.string().max(500_000).default('') })),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    if (!(await hasPermission(projectId, sub, 'documents.write'))) return c.json({ error: 'Forbidden' }, 403)
    const { title, content } = c.req.valid('json')
    const [row] = await db.insert(documents).values({ projectId, title, content, createdById: sub, updatedById: sub }).returning()
    void logActivity({ projectId, actorId: sub, action: 'create', entityType: 'document', entityId: row!.id, entityLabel: row!.title || '—' })
    broadcast(projectId, 'documents_changed', {})
    return c.json(serialize(row!), 201)
  },
)

// Обновить
documentsRoute.patch(
  '/:id',
  zValidator('json', z.object({ title: z.string().max(300).optional(), content: z.string().max(500_000).optional() })),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    if (!(await hasPermission(projectId, sub, 'documents.write'))) return c.json({ error: 'Forbidden' }, 403)
    const id = c.req.param('id')
    const d = await db.query.documents.findFirst({ where: and(eq(documents.id, id), eq(documents.projectId, projectId)) })
    if (!d) return c.json({ error: 'Not found' }, 404)
    const b = c.req.valid('json')
    const patch: Record<string, unknown> = { updatedById: sub }
    if (b.title !== undefined) patch.title = b.title
    if (b.content !== undefined) patch.content = b.content
    const [row] = await db.update(documents).set(patch).where(eq(documents.id, id)).returning()
    void logActivity({ projectId, actorId: sub, action: 'update', entityType: 'document', entityId: id, entityLabel: row!.title || '—' })
    broadcast(projectId, 'documents_changed', {})
    return c.json(serialize(row!))
  },
)

// Публичный доступ по ссылке: включить/выключить
documentsRoute.post('/:id/share', zValidator('json', z.object({ enabled: z.boolean() })), async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'documents.write'))) return c.json({ error: 'Forbidden' }, 403)
  const id = c.req.param('id')
  const d = await db.query.documents.findFirst({ where: and(eq(documents.id, id), eq(documents.projectId, projectId)) })
  if (!d) return c.json({ error: 'Not found' }, 404)
  const { enabled } = c.req.valid('json')
  const slug = enabled ? (d.publicSlug ?? nanoid(16)) : null
  await db.update(documents).set({ publicSlug: slug }).where(eq(documents.id, id))
  return c.json({ publicSlug: slug })
})

// Удалить (soft-delete, восстановимо 7 дней — SPEC §8.21)
documentsRoute.delete('/:id', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'documents.delete'))) return c.json({ error: 'Forbidden' }, 403)
  const id = c.req.param('id')
  const d = await db.query.documents.findFirst({ where: and(eq(documents.id, id), eq(documents.projectId, projectId)) })
  if (!d) return c.json({ error: 'Not found' }, 404)
  await db.update(documents).set({ deletedAt: new Date(), deletedById: sub }).where(eq(documents.id, id))
  void logActivity({ projectId, actorId: sub, action: 'delete', entityType: 'document', entityId: id, entityLabel: d.title || '—' })
  broadcast(projectId, 'documents_changed', {})
  return c.json({ ok: true })
})

// --- Публичная страница документа по слагу (БЕЗ авторизации) ---
const esc = (s: string) => s.replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[ch]!)

export const documentsPublicRoute = new Hono()

// HTML-страница — то, что открывается по расшаренной ссылке
documentsPublicRoute.get('/:slug', async (c) => {
  const d = await db.query.documents.findFirst({
    where: and(eq(documents.publicSlug, c.req.param('slug')), sql`${documents.deletedAt} is null`),
  })
  if (!d) {
    c.status(404)
    return c.html('<!doctype html><meta charset="utf-8"><title>Not found</title><p style="font:16px system-ui;padding:2rem">Document not found.</p>')
  }
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.title || 'Document')}</title>
<style>
  :root { color-scheme: light dark }
  body { font: 16px/1.65 system-ui, sans-serif; max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem }
  h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 .35rem }
  .meta { color: #888; font-size: .85rem; margin-bottom: 2rem }
  .content { white-space: pre-wrap; word-wrap: break-word }
  footer { margin-top: 3rem; color: #999; font-size: .8rem }
</style>
<h1>${esc(d.title || 'Document')}</h1>
<div class="meta">Updated ${d.updatedAt.toISOString().slice(0, 10)}</div>
<div class="content">${esc(d.content)}</div>
<footer>Shared via Chatick</footer>`
  return c.html(html)
})
