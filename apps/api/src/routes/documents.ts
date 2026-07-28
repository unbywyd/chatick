import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, ilike, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../db/client.js'
import { documents, documentVersions, users } from '../db/schema.js'
import { requireProject, type ProjectEnv } from '../auth.js'
import { hasPermission, ownsOrManages } from './projects.js'
import { logActivity } from '../lib/audit.js'
import { htmlToText, sanitizeHtml } from '../lib/sanitize-html.js'
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
      preview: htmlToText(r.d.content).slice(0, 160),
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
    // снапшот версии (сам решает, создавать новую или дописать текущую)
    void snapshot(id, row!.title, row!.content, sub).catch((e) => console.error('[documents] snapshot failed:', e))
    void logActivity({ projectId, actorId: sub, action: 'update', entityType: 'document', entityId: id, entityLabel: row!.title || '—' })
    broadcast(projectId, 'documents_changed', { id }, { except: sub })
    return c.json(serialize(row!))
  },
)

// --- Версии документа (SPEC §8.25) ---

// Новый снапшот пишем не на каждое автосохранение: только если прошло > VERSION_GAP_MS
// с последней версии, либо правит другой автор. Иначе история захламляется.
const VERSION_GAP_MS = 3 * 60_000

export async function snapshot(documentId: string, title: string, content: string, authorId: string, note = '') {
  const last = await db.query.documentVersions.findFirst({
    where: eq(documentVersions.documentId, documentId),
    orderBy: desc(documentVersions.version),
  })
  const fresh = last && Date.now() - last.createdAt.getTime() < VERSION_GAP_MS && last.authorId === authorId
  // ничего не изменилось — версия не нужна
  if (last && last.content === content && last.title === title) return
  if (fresh && !note) {
    // в пределах окна дописываем последнюю версию, а не плодим новые
    await db.update(documentVersions).set({ title, content }).where(eq(documentVersions.id, last.id))
    return
  }
  await db.insert(documentVersions).values({ documentId, version: (last?.version ?? 0) + 1, title, content, authorId, note })
}

// Список версий (без контента)
documentsRoute.get('/:id/versions', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'documents.read'))) return c.json({ error: 'Forbidden' }, 403)
  const id = c.req.param('id')
  const d = await db.query.documents.findFirst({ where: and(eq(documents.id, id), eq(documents.projectId, projectId)) })
  if (!d) return c.json({ error: 'Not found' }, 404)
  const rows = await db
    .select({ v: documentVersions, author: users })
    .from(documentVersions)
    .leftJoin(users, eq(users.id, documentVersions.authorId))
    .where(eq(documentVersions.documentId, id))
    .orderBy(desc(documentVersions.version))
    .limit(100)
  return c.json(
    rows.map((r) => ({
      id: r.v.id,
      version: r.v.version,
      title: r.v.title,
      note: r.v.note,
      createdAt: r.v.createdAt,
      size: r.v.content.length,
      author: r.author ? { id: r.author.id, name: r.author.name, avatarUrl: r.author.avatarUrl } : null,
    })),
  )
})

// Контент конкретной версии (для просмотра/сравнения)
documentsRoute.get('/:id/versions/:versionId', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'documents.read'))) return c.json({ error: 'Forbidden' }, 403)
  const id = c.req.param('id')
  const d = await db.query.documents.findFirst({ where: and(eq(documents.id, id), eq(documents.projectId, projectId)) })
  if (!d) return c.json({ error: 'Not found' }, 404)
  const v = await db.query.documentVersions.findFirst({
    where: and(eq(documentVersions.id, c.req.param('versionId')), eq(documentVersions.documentId, id)),
  })
  if (!v) return c.json({ error: 'Not found' }, 404)
  return c.json({ id: v.id, version: v.version, title: v.title, content: v.content, createdAt: v.createdAt })
})

// Откат к версии — текущее состояние тоже снапшотим, чтобы откат был обратим
documentsRoute.post('/:id/versions/:versionId/restore', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'documents.write'))) return c.json({ error: 'Forbidden' }, 403)
  const id = c.req.param('id')
  const d = await db.query.documents.findFirst({ where: and(eq(documents.id, id), eq(documents.projectId, projectId)) })
  if (!d) return c.json({ error: 'Not found' }, 404)
  const v = await db.query.documentVersions.findFirst({
    where: and(eq(documentVersions.id, c.req.param('versionId')), eq(documentVersions.documentId, id)),
  })
  if (!v) return c.json({ error: 'Not found' }, 404)

  await snapshot(id, d.title, d.content, sub, `before restore to v${v.version}`)
  const [row] = await db.update(documents).set({ title: v.title, content: v.content, updatedById: sub }).where(eq(documents.id, id)).returning()
  void logActivity({ projectId, actorId: sub, action: 'update', entityType: 'document', entityId: id, entityLabel: `${row!.title || '—'} → v${v.version}` })
  broadcast(projectId, 'documents_changed', { id })
  return c.json(serialize(row!))
})

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
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, c.req.param('id')), eq(documents.projectId, projectId)),
  })
  if (!doc) return c.json({ error: 'Not found' }, 404)

  // Свой документ участник удаляет сам: он его и завёл. Чужой — только с
  // documents.delete. Удаление мягкое, восстановимо 7 дней.
  const canDeleteAny = await hasPermission(projectId, sub, 'documents.delete')
  const canDeleteOwn =
    (await hasPermission(projectId, sub, 'documents.write')) &&
    (await ownsOrManages(projectId, sub, [doc.createdById]))
  if (!canDeleteAny && !canDeleteOwn) return c.json({ error: 'Forbidden' }, 403)
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
  body { font: 16px/1.7 system-ui, -apple-system, Segoe UI, sans-serif; max-width: 48rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem }
  h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 .35rem }
  .meta { color: #888; font-size: .85rem; margin-bottom: 2rem }
  .content > :first-child { margin-top: 0 }
  .content h1, .content h2, .content h3 { line-height: 1.25; margin: 1.6em 0 .5em }
  .content h1 { font-size: 1.6rem } .content h2 { font-size: 1.3rem } .content h3 { font-size: 1.1rem }
  .content p, .content ul, .content ol, .content blockquote, .content pre { margin: 0 0 1em }
  .content img { max-width: 100%; height: auto; border-radius: 6px; display: block }
  .content img[data-align="center"] { margin-inline: auto }
  .content img[data-align="right"] { margin-inline-start: auto }
  .content a { color: #2563eb }
  .content blockquote { border-left: 3px solid #d0d0d0; margin-left: 0; padding-left: 1rem; color: #666 }
  .content pre { background: #f4f4f5; padding: .85rem 1rem; border-radius: 6px; overflow-x: auto }
  .content code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em }
  .content mark { background: #fef08a; padding: 0 .15em }
  .content hr { border: 0; border-top: 1px solid #ddd; margin: 2em 0 }
  .table-wrap { overflow-x: auto }
  .content table { border-collapse: collapse; width: 100% }
  .content th, .content td { border: 1px solid #ddd; padding: .45rem .6rem; text-align: left; vertical-align: top }
  .content th { background: #f4f4f5; font-weight: 600 }
  .content ul[data-type="taskList"] { list-style: none; padding-left: .25rem }
  footer { margin-top: 3rem; color: #999; font-size: .8rem; border-top: 1px solid #e5e5e5; padding-top: 1rem }
  @media (prefers-color-scheme: dark) {
    .content pre, .content th { background: #1f1f22 }
    .content blockquote { border-color: #444; color: #aaa }
    .content th, .content td { border-color: #333 }
    .content mark { background: #854d0e; color: #fff }
    footer { border-color: #2a2a2a }
  }
</style>
<h1>${esc(d.title || 'Document')}</h1>
<div class="meta">Updated ${d.updatedAt.toISOString().slice(0, 10)}</div>
<div class="content">${sanitizeHtml(d.content)}</div>
<footer>Shared via Chatick</footer>`
  return c.html(html)
})
