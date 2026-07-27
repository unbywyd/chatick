import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../db/client.js'
import { credentials, files, messages, notes, projects, shares, tasks, users } from '../db/schema.js'
import { requireSession, type SessionEnv } from '../auth.js'
import { getObjectStream, resolveStorage } from '../lib/s3.js'
import { sanitizeHtml } from '../lib/sanitize-html.js'
import { hasPermission, projectRoleOf, type ProjectPermission } from './projects.js'

// Публичный доступ по ссылке (SPEC §8.34).
//
// Приватная ссылка — это просто адрес внутри приложения (/p/<id>/files/<id>),
// доступ по нему решают обычные права, и записи он не требует. Здесь только
// публичный доступ: тот, что работает БЕЗ входа, а значит должен отзываться.

export const sharesRoute = new Hono<SessionEnv>()

/**
 * Документы намеренно не здесь: у них своя публичность (documents.publicSlug)
 * с готовой страницей /d/:slug и правами на редактирование. Второй механизм
 * рядом означал бы два места, где документ «публичный», и два места, где это
 * можно забыть отозвать.
 */
type Entity = 'file' | 'note' | 'resource' | 'message' | 'task'

/** Право, без которого делиться нельзя: делятся тем, что имеют право читать. */
const READ_PERMISSION: Record<Entity, ProjectPermission | null> = {
  file: 'files.read',
  note: 'notes.read',
  resource: 'resources.read',
  // Чат читают все участники проекта — отдельного права на него нет.
  message: null,
  task: 'tasks.read',
}

/** Находит сущность и её проект — заодно проверяя, что она вообще существует. */
async function locate(type: Entity, id: string): Promise<{ projectId: string; title: string } | null> {
  switch (type) {
    case 'file': {
      const r = await db.query.files.findFirst({ where: and(eq(files.id, id), isNull(files.deletedAt)) })
      return r ? { projectId: r.projectId, title: r.name } : null
    }
    case 'note': {
      const r = await db.query.notes.findFirst({ where: and(eq(notes.id, id), isNull(notes.deletedAt)) })
      return r ? { projectId: r.projectId, title: r.title } : null
    }
    case 'resource': {
      const r = await db.query.credentials.findFirst({ where: and(eq(credentials.id, id), isNull(credentials.deletedAt)) })
      return r ? { projectId: r.projectId, title: r.name } : null
    }
    case 'message': {
      const r = await db.query.messages.findFirst({ where: eq(messages.id, id) })
      return r ? { projectId: r.projectId, title: r.text.slice(0, 80) } : null
    }
    case 'task': {
      const r = await db.query.tasks.findFirst({ where: and(eq(tasks.id, id), isNull(tasks.deletedAt)) })
      return r ? { projectId: r.projectId, title: `${r.number} ${r.title}` } : null
    }
  }
}

export type ShareEntityType = Entity

/**
 * Выдать публичную ссылку. Общая для интерфейса и моста: правило «одна
 * активная ссылка на сущность» должно быть одним, иначе отзыв перестанет
 * что-либо гарантировать.
 */
export async function createShare(type: Entity, entityId: string, projectId: string, userId: string) {
  const found = await locate(type, entityId)
  if (!found || found.projectId !== projectId) return null

  const existing = await db.query.shares.findFirst({
    where: and(eq(shares.entityType, type), eq(shares.entityId, entityId), isNull(shares.revokedAt)),
  })
  if (existing) return existing

  const [row] = await db
    .insert(shares)
    .values({ slug: nanoid(16), entityType: type, entityId, projectId, createdById: userId })
    .returning()
  return row!
}

/** Отозвать: ссылка перестаёт работать немедленно. */
export async function revokeShare(type: Entity, entityId: string) {
  await db
    .update(shares)
    .set({ revokedAt: new Date() })
    .where(and(eq(shares.entityType, type), eq(shares.entityId, entityId), isNull(shares.revokedAt)))
}

// --- Управление ссылками (нужна сессия) -------------------------------------

sharesRoute.use('/*', requireSession)

/** Текущая публичная ссылка сущности — чтобы диалог знал, что показывать. */
sharesRoute.get('/:type/:id', async (c) => {
  const { sub } = c.get('session')
  const type = c.req.param('type') as Entity
  const id = c.req.param('id')

  const found = await locate(type, id)
  if (!found) return c.json({ error: 'Not found' }, 404)
  const perm = READ_PERMISSION[type]
  const allowed = perm ? await hasPermission(found.projectId, sub, perm) : Boolean(await projectRoleOf(found.projectId, sub))
  if (!allowed) return c.json({ error: 'Forbidden' }, 403)

  const row = await db.query.shares.findFirst({
    where: and(eq(shares.entityType, type), eq(shares.entityId, id), isNull(shares.revokedAt)),
  })
  return c.json({ share: row ? serialize(row) : null })
})

/**
 * Открыть публичный доступ.
 *
 * Повторный вызов возвращает ту же ссылку, а не плодит новые: иначе отозвать
 * доступ было бы невозможно — старые ссылки продолжали бы работать.
 */
sharesRoute.post('/:type/:id', async (c) => {
  const { sub } = c.get('session')
  const type = c.req.param('type') as Entity
  const id = c.req.param('id')

  const found = await locate(type, id)
  if (!found) return c.json({ error: 'Not found' }, 404)

  // Публичный доступ раздают те, кто отвечает за проект: обычный участник
  // может читать, но выносить наружу — уже решение о видимости.
  const member = await projectRoleOf(found.projectId, sub)
  if (!(member?.role === 'owner' || member?.role === 'admin')) {
    return c.json({ error: 'Only project owners and admins can publish links' }, 403)
  }

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const days = typeof body.expiresInDays === 'number' ? Math.min(365, Math.max(1, body.expiresInDays)) : null

  const existing = await db.query.shares.findFirst({
    where: and(eq(shares.entityType, type), eq(shares.entityId, id), isNull(shares.revokedAt)),
  })
  if (existing) return c.json({ share: serialize(existing) })

  const [row] = await db
    .insert(shares)
    .values({
      slug: nanoid(16),
      entityType: type,
      entityId: id,
      projectId: found.projectId,
      createdById: sub,
      expiresAt: days ? new Date(Date.now() + days * 86_400_000) : null,
    })
    .returning()

  return c.json({ share: serialize(row!) }, 201)
})

/** Отозвать: ссылка перестаёт работать немедленно. */
sharesRoute.delete('/:type/:id', async (c) => {
  const { sub } = c.get('session')
  const type = c.req.param('type') as Entity
  const id = c.req.param('id')

  const found = await locate(type, id)
  if (!found) return c.json({ error: 'Not found' }, 404)
  const member = await projectRoleOf(found.projectId, sub)
  if (!(member?.role === 'owner' || member?.role === 'admin')) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  await db
    .update(shares)
    .set({ revokedAt: new Date() })
    .where(and(eq(shares.entityType, type), eq(shares.entityId, id), isNull(shares.revokedAt)))
  return c.json({ ok: true })
})

const serialize = (r: typeof shares.$inferSelect) => ({
  slug: r.slug,
  expiresAt: r.expiresAt,
  views: Number(r.views),
  createdAt: r.createdAt,
})

// --- Публичное чтение (БЕЗ сессии) ------------------------------------------
//
// Отдельный роутер: этот путь намеренно не требует входа, и держать его рядом
// с requireSession — верный способ однажды случайно закрыть или открыть лишнее.

export const publicShareRoute = new Hono()

publicShareRoute.get('/:slug', async (c) => {
  const slug = c.req.param('slug')

  const row = await db.query.shares.findFirst({
    where: and(eq(shares.slug, slug), isNull(shares.revokedAt)),
  })
  if (!row) return c.json({ error: 'Link not found or revoked' }, 404)
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    return c.json({ error: 'Link expired' }, 410)
  }

  const project = await db.query.projects.findFirst({ where: eq(projects.id, row.projectId) })
  const payload = await readEntity(row.entityType as Entity, row.entityId)
  if (!payload) return c.json({ error: 'Not found' }, 404)

  // Счётчик просмотров: помогает понять, ушла ли ссылка дальше адресата.
  void db
    .update(shares)
    .set({ views: sql`(${shares.views}::int + 1)::text` })
    .where(eq(shares.id, row.id))

  return c.json({
    type: row.entityType,
    project: project ? { name: project.name, color: project.color, logoUrl: project.logoUrl } : null,
    ...payload,
  })
})

/**
 * Что видно по публичной ссылке.
 *
 * Отдаём ровно то, ради чего делятся, и ничего сверх: без комментариев, без
 * соседних сущностей и без списка участников. Публичная ссылка — это окно в
 * один объект, а не гостевой доступ в проект.
 */
async function readEntity(type: Entity, id: string) {
  switch (type) {
    case 'file': {
      const r = await db.query.files.findFirst({ where: and(eq(files.id, id), isNull(files.deletedAt)) })
      return r ? { file: { id: r.id, name: r.name, mime: r.mime, size: Number(r.size), createdAt: r.createdAt } } : null
    }
    case 'note': {
      const r = await db.query.notes.findFirst({ where: and(eq(notes.id, id), isNull(notes.deletedAt)) })
      if (!r) return null
      // Санитизируем на отдаче, а не полагаемся на запись: публичную страницу
      // открывает кто угодно, и цена пропущенного скрипта здесь другая.
      // Теги хранятся строкой JSON — отдать её как есть значит уронить
      // страницу на tags.map.
      let tags: string[] = []
      try {
        const parsed: unknown = JSON.parse(r.tags || '[]')
        if (Array.isArray(parsed)) tags = parsed.filter((x): x is string => typeof x === 'string')
      } catch {
        /* битые теги — не повод не показать заметку */
      }
      return { note: { title: r.title, body: sanitizeHtml(r.body), type: r.type, tags, createdAt: r.createdAt } }
    }
    case 'resource': {
      const r = await db.query.credentials.findFirst({
        where: and(eq(credentials.id, id), isNull(credentials.deletedAt)),
      })
      // Секреты по публичной ссылке не отдаём никогда — только название и адрес.
      return r ? { resource: { title: r.name, url: r.url, description: r.description } } : null
    }
    case 'message': {
      const r = await db.query.messages.findFirst({ where: eq(messages.id, id) })
      if (!r) return null
      const author = r.authorId ? await db.query.users.findFirst({ where: eq(users.id, r.authorId) }) : null

      // Вложения — часть сообщения: сообщение из одной скрепки без них
      // выглядит пустым, а поделиться картинкой хотят чаще, чем текстом.
      const atts = await db
        .select()
        .from(files)
        .where(and(eq(files.messageId, r.id), isNull(files.deletedAt)))

      return {
        message: {
          text: r.text,
          createdAt: r.createdAt,
          author: author ? { name: author.name, avatarUrl: author.avatarUrl } : null,
          attachments: atts.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: Number(f.size) })),
        },
      }
    }
    case 'task': {
      const r = await db.query.tasks.findFirst({ where: and(eq(tasks.id, id), isNull(tasks.deletedAt)) })
      if (!r) return null
      return {
        task: {
          number: r.number,
          title: r.title,
          description: sanitizeHtml(r.description),
          status: r.status,
          dueDate: r.dueDate,
        },
      }
    }
  }
}

/**
 * Содержимое файла по публичной ссылке.
 *
 * Отдельный путь от /s/:slug: тот возвращает описание, а здесь идут байты —
 * их встраивают в <img> и открывают в новой вкладке, и JSON там неуместен.
 */
publicShareRoute.get('/:slug/raw', async (c) => {
  const row = await db.query.shares.findFirst({
    where: and(eq(shares.slug, c.req.param('slug')), eq(shares.entityType, 'file'), isNull(shares.revokedAt)),
  })
  if (!row) return c.json({ error: 'Link not found or revoked' }, 404)
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return c.json({ error: 'Link expired' }, 410)

  const file = await db.query.files.findFirst({ where: and(eq(files.id, row.entityId), isNull(files.deletedAt)) })
  if (!file) return c.json({ error: 'Not found' }, 404)

  try {
    const store = await resolveStorage(file.projectId)
    const { body, contentType, contentLength } = await getObjectStream(store, file.key)
    const web = Readable.toWeb(body) as ReadableStream
    c.header('Content-Type', contentType || file.mime)
    // inline: по ссылке приходят посмотреть, а не обязательно скачать
    c.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`)
    if (contentLength) c.header('Content-Length', String(contentLength))
    // Публичная ссылку можно отозвать — вечный кеш сделал бы отзыв бесполезным
    c.header('Cache-Control', 'public, max-age=300')
    return c.body(web)
  } catch (e) {
    console.error('[shares] file read failed:', e)
    return c.json({ error: 'Read failed' }, 500)
  }
})
