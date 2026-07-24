import { Hono } from 'hono'
import { Readable } from 'node:stream'
import { and, desc, eq, gte, ilike, inArray, isNull, lte, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import sharp from 'sharp'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { db } from '../db/client.js'
import { files, companies, projects, tasks, users } from '../db/schema.js'
import { requireProject, signFileToken, verifyFileToken, type ProjectEnv } from '../auth.js'
import { hasPermission } from './projects.js'
import { s3Client, presignDownload, presignView, deleteObject, getObjectStream, S3_KEY_PREFIX, s3Bucket } from '../lib/s3.js'

// Публичная прокси-отдача файла по file-токену (в URL) — для iframe/img/Google Viewer.
// Отдельный роут БЕЗ project-middleware: доступ по короткоживущему подписанному токену.
export const filesPublicRoute = new Hono()
filesPublicRoute.get('/:fileId/raw', async (c) => {
  const token = c.req.query('t')
  const payload = token ? await verifyFileToken(token) : null
  if (!payload || payload.fileId !== c.req.param('fileId')) return c.json({ error: 'Unauthorized' }, 401)

  const file = await db.query.files.findFirst({ where: and(eq(files.id, payload.fileId), eq(files.projectId, payload.projectId)) })
  if (!file) return c.json({ error: 'Not found' }, 404)

  const key = c.req.query('original') === '1' && file.originalKey ? file.originalKey : file.key
  try {
    const { body, contentType, contentLength } = await getObjectStream(key)
    const web = Readable.toWeb(body) as ReadableStream
    c.header('Content-Type', contentType || file.mime)
    c.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`)
    if (contentLength) c.header('Content-Length', String(contentLength))
    c.header('Cache-Control', 'private, max-age=3600')
    c.header('Access-Control-Allow-Origin', '*') // чтобы работал fetch текста из вьюера
    return c.body(web)
  } catch (e) {
    console.error('[files] proxy failed:', e)
    return c.json({ error: 'Read failed' }, 500)
  }
})

// Файлы проекта (таб «Файлы») — project-токен, скоуп жёстко из токена.
// Загрузка проксируется через API (R2-токен не может ставить CORS на бакет,
// прямой браузерный PUT недоступен). До 100MB — ок для сервера.
export const filesRoute = new Hono<ProjectEnv>()
filesRoute.use('*', requireProject)

const MAX_FILE_MB = 100

const PAGE_SIZE = 24

async function storageUsage(projectId: string): Promise<number> {
  const [{ total }] = (await db
    .select({ total: sql<string>`coalesce(sum(cast(${files.size} as bigint)), 0)` })
    .from(files)
    .where(eq(files.projectId, projectId))) as [{ total: string }]
  return Number(total)
}

async function companyStorageUsage(companyId: string): Promise<number> {
  const [{ total }] = (await db
    .select({ total: sql<string>`coalesce(sum(cast(${files.size} as bigint)), 0)` })
    .from(files)
    .innerJoin(projects, eq(projects.id, files.projectId))
    .where(eq(projects.companyId, companyId))) as [{ total: string }]
  return Number(total)
}

/**
 * Эффективный лимит проекта (SPEC §7): min(override проекта, остаток пула компании).
 * used — сколько уже занято в этом проекте. Возвращает лимит в байтах (0 = без лимита).
 */
async function effectiveLimit(project: typeof projects.$inferSelect): Promise<{ limit: number; used: number }> {
  const used = await storageUsage(project.id)
  const company = await db.query.companies.findFirst({ where: eq(companies.id, project.companyId) })
  const companyLimit = Number(company?.storageLimit ?? 0)
  const projectOverride = project.storageLimit != null ? Number(project.storageLimit) : null

  const candidates: number[] = []
  if (projectOverride && projectOverride > 0) candidates.push(projectOverride)
  if (companyLimit > 0) {
    // доступное этому проекту = его used + (свободное в пуле компании)
    const companyUsed = await companyStorageUsage(project.companyId)
    candidates.push(used + Math.max(0, companyLimit - companyUsed))
  }
  const limit = candidates.length ? Math.min(...candidates) : 0
  return { limit, used }
}

// mime → категория для чипов-фильтров
function typeCond(type: string) {
  if (type === 'image') return sql`${files.mime} like 'image/%'`
  if (type === 'video') return sql`${files.mime} like 'video/%'`
  if (type === 'audio') return sql`${files.mime} like 'audio/%'`
  if (type === 'doc') return sql`(${files.mime} ~* 'pdf|word|excel|sheet|presentation|document|text|csv')`
  if (type === 'other')
    return sql`(${files.mime} not like 'image/%' and ${files.mime} not like 'video/%' and ${files.mime} not like 'audio/%' and ${files.mime} !~* 'pdf|word|excel|sheet|presentation|document|text|csv')`
  return undefined
}

// Список файлов проекта (фильтры: taskId, source, type, q, from/to; пагинация; + usage/limit)
filesRoute.get('/', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'files.read'))) return c.json({ error: 'Forbidden' }, 403)
  const taskId = c.req.query('taskId')
  const source = c.req.query('source') // chat | task | upload
  const type = c.req.query('type') // image | video | audio | doc | other
  const q = (c.req.query('q') ?? '').trim()
  const from = c.req.query('from')
  const to = c.req.query('to')
  const page = Math.max(1, Number(c.req.query('page')) || 1)

  const conds = [eq(files.projectId, projectId), isNull(files.deletedAt)]
  if (taskId) conds.push(eq(files.taskId, taskId))
  if (source === 'chat') conds.push(sql`${files.messageId} is not null`)
  if (source === 'task') conds.push(sql`${files.taskId} is not null`)
  if (source === 'upload') conds.push(sql`${files.messageId} is null and ${files.taskId} is null`)
  const tc = type ? typeCond(type) : undefined
  if (tc) conds.push(tc)
  if (q) conds.push(ilike(files.name, `%${q}%`))
  if (from && !isNaN(Date.parse(from))) conds.push(gte(files.createdAt, new Date(from)))
  if (to && !isNaN(Date.parse(to))) conds.push(lte(files.createdAt, new Date(to + 'T23:59:59')))

  const rows = await db
    .select({ file: files, uploader: users, taskNumber: tasks.number })
    .from(files)
    .leftJoin(users, eq(users.id, files.uploadedById))
    .leftJoin(tasks, eq(tasks.id, files.taskId))
    .where(and(...conds))
    .orderBy(desc(files.createdAt))
    .limit(PAGE_SIZE + 1)
    .offset((page - 1) * PAGE_SIZE)

  const hasMore = rows.length > PAGE_SIZE
  const items = rows.slice(0, PAGE_SIZE).map((r) => ({
    id: r.file.id,
    name: r.file.name,
    mime: r.file.mime,
    size: Number(r.file.size),
    createdAt: r.file.createdAt,
    taskId: r.file.taskId,
    taskNumber: r.taskNumber,
    messageId: r.file.messageId, // для «перейти к переписке»
    hasOriginal: Boolean(r.file.originalKey),
    uploader: r.uploader ? { id: r.uploader.id, name: r.uploader.name, avatarUrl: r.uploader.avatarUrl } : null,
  }))

  // usage/limit отдаём только на первой странице (эффективный лимит: проект+пул компании)
  let storage: { used: number; limit: number } | undefined
  if (page === 1) {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
    storage = project ? await effectiveLimit(project) : undefined
  }

  return c.json({ items, page, hasMore, storage })
})

const OPTIMIZABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/tiff'])
const MAX_DIMENSION = 2048
const WEBP_QUALITY = 82

// Загрузка: multipart/form-data, поле "file"; taskId — вложение задачи;
// keepOriginal=1 — не оптимизировать (как «отправить оригинал» в WhatsApp).
// Картинки по умолчанию: resize ≤2048px + webp; оригинал сохраняется рядом (originalKey).
filesRoute.post('/', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'files.upload'))) return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.parseBody()
  const file = body['file']
  const taskId = typeof body['taskId'] === 'string' && body['taskId'] ? body['taskId'] : null
  const keepOriginal = body['keepOriginal'] === '1'
  if (!(file instanceof File)) return c.json({ error: 'file field is required' }, 400)
  if (taskId) {
    const task = await db.query.tasks.findFirst({ where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)) })
    if (!task) return c.json({ error: 'Task not found' }, 404)
  }
  if (file.size > MAX_FILE_MB * 1024 * 1024) return c.json({ error: `File too large (max ${MAX_FILE_MB}MB)` }, 413)

  // эффективный лимит: min(override проекта, остаток пула компании) — SPEC §7
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (project) {
    const { limit, used } = await effectiveLimit(project)
    if (limit > 0 && used + file.size > limit) {
      return c.json({ error: 'Storage limit exceeded', code: 'STORAGE_LIMIT' }, 413)
    }
  }

  const fileId = nanoid()
  // UUID-имена (скриншоты из буфера) → человекочитаемое
  const looksGenerated = /^[0-9a-f-]{20,}\.[a-z]+$/i.test(file.name) || file.name === 'image.png' || file.name === 'blob'
  const niceBase = looksGenerated ? `image-${new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-')}` : null
  const displayName = niceBase ? `${niceBase}${file.name.match(/\.[a-z0-9]+$/i)?.[0] ?? '.png'}` : file.name
  const safeName = displayName.replace(/[/\\]/g, '_')
  const mime = file.type || 'application/octet-stream'
  let buffer = Buffer.from(await file.arrayBuffer())
  let outName = displayName
  let outMime = mime
  let key = `${S3_KEY_PREFIX}/${projectId}/${fileId}-${safeName}`
  let originalKey: string | null = null

  if (!keepOriginal && OPTIMIZABLE.has(mime)) {
    try {
      const optimized = await sharp(buffer, { failOn: 'none' })
        .rotate() // EXIF-ориентация
        .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer()
      // применяем только если реально выгодно
      if (optimized.length < buffer.length * 0.9) {
        originalKey = `${S3_KEY_PREFIX}/${projectId}/${fileId}-orig-${safeName}`
        await s3Client().send(
          new PutObjectCommand({ Bucket: s3Bucket(), Key: originalKey, Body: buffer, ContentType: mime }),
        )
        buffer = optimized
        outMime = 'image/webp'
        outName = displayName.replace(/\.[^.]+$/, '') + '.webp'
        key = `${S3_KEY_PREFIX}/${projectId}/${fileId}-${outName.replace(/[/\\]/g, '_')}`
      }
    } catch (e) {
      console.error('[files] optimize failed, storing original:', e)
    }
  }

  await s3Client().send(new PutObjectCommand({ Bucket: s3Bucket(), Key: key, Body: buffer, ContentType: outMime }))

  const [row] = await db
    .insert(files)
    .values({
      id: fileId,
      projectId,
      taskId,
      uploadedById: sub,
      name: outName,
      key,
      mime: outMime,
      size: String(buffer.length),
      originalKey,
    })
    .returning()
  return c.json(
    {
      id: row!.id,
      name: row!.name,
      mime: row!.mime,
      size: Number(row!.size),
      taskId: row!.taskId,
      hasOriginal: Boolean(row!.originalKey),
      createdAt: row!.createdAt,
    },
    201,
  )
})

// Получить прокси-URL для просмотра (стабильный, на нашем домене, для iframe/img/Google)
filesRoute.get('/:fileId/view-url', async (c) => {
  const { projectId } = c.get('auth')
  const fileId = c.req.param('fileId')
  const file = await db.query.files.findFirst({ where: and(eq(files.id, fileId), eq(files.projectId, projectId)) })
  if (!file) return c.json({ error: 'Not found' }, 404)
  const token = await signFileToken(fileId, projectId)
  const original = c.req.query('original') === '1' && file.originalKey ? '&original=1' : ''
  // абсолютный URL — Google Viewer требует публичный адрес
  const base = process.env.API_PUBLIC_URL || `https://api.chatick.com`
  return c.json({ url: `${base}/files/${fileId}/raw?t=${token}${original}`, mime: file.mime, name: file.name })
})

// Скачивание — presigned GET (attachment); ?inline=1 — просмотр; ?original=1 — исходник до оптимизации
filesRoute.get('/:fileId/download', async (c) => {
  const { projectId } = c.get('auth')
  const fileId = c.req.param('fileId')
  const inline = c.req.query('inline') === '1'
  const wantOriginal = c.req.query('original') === '1'
  const file = await db.query.files.findFirst({ where: and(eq(files.id, fileId), eq(files.projectId, projectId)) })
  if (!file) return c.json({ error: 'Not found' }, 404)
  const key = wantOriginal && file.originalKey ? file.originalKey : file.key
  const url = inline ? await presignView(key, file.mime) : await presignDownload(key, file.name)
  return c.json({ url })
})

// Массовое удаление (owner/admin — любые; иначе только свои)
// Удаление: файлы-вложения сообщений → soft-delete (в чате «файл удалён»);
// остальные → физически. R2-объекты чистим сразу в обоих случаях.
async function removeFiles(rows: (typeof files.$inferSelect)[]) {
  const attached = rows.filter((f) => f.messageId)
  const detached = rows.filter((f) => !f.messageId)
  if (attached.length) {
    await db.update(files).set({ deletedAt: new Date() }).where(inArray(files.id, attached.map((f) => f.id)))
  }
  if (detached.length) {
    await db.delete(files).where(inArray(files.id, detached.map((f) => f.id)))
  }
  for (const f of rows) {
    deleteObject(f.key).catch(() => {})
    if (f.originalKey) deleteObject(f.originalKey).catch(() => {})
  }
}

filesRoute.post('/bulk-delete', zValidator('json', z.object({ ids: z.array(z.string()).min(1).max(500) })), async (c) => {
  const { projectId, sub, role } = c.get('auth')
  const { ids } = c.req.valid('json')

  const rows = await db.query.files.findMany({ where: and(eq(files.projectId, projectId), inArray(files.id, ids), isNull(files.deletedAt)) })
  // files.delete (crud) — удалять любые; иначе только свои загрузки (нужен write)
  const canDeleteAny = (await hasPermission(projectId, sub, 'files.delete')) || role === 'owner' || role === 'admin'
  const canDeleteOwn = await hasPermission(projectId, sub, 'files.upload')
  const deletable = rows.filter((f) => canDeleteAny || (canDeleteOwn && f.uploadedById === sub))

  if (deletable.length) await removeFiles(deletable)
  return c.json({ deleted: deletable.length, skipped: rows.length - deletable.length })
})

// Удаление (загрузивший или owner/admin)
filesRoute.delete('/:fileId', async (c) => {
  const { projectId, sub, role } = c.get('auth')
  const fileId = c.req.param('fileId')
  const file = await db.query.files.findFirst({ where: and(eq(files.id, fileId), eq(files.projectId, projectId)) })
  if (!file) return c.json({ error: 'Not found' }, 404)

  const canDeleteAny = (await hasPermission(projectId, sub, 'files.delete')) || role === 'owner' || role === 'admin'
  const canDeleteOwn = (await hasPermission(projectId, sub, 'files.upload')) && file.uploadedById === sub
  if (!canDeleteAny && !canDeleteOwn) return c.json({ error: 'Forbidden' }, 403)

  await removeFiles([file])
  return c.json({ ok: true })
})
