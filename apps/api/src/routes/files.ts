import { Hono } from 'hono'
import { Readable } from 'node:stream'
import { and, desc, eq, ilike } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import sharp from 'sharp'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { db } from '../db/client.js'
import { files, tasks, users } from '../db/schema.js'
import { requireProject, signFileToken, verifyFileToken, type ProjectEnv } from '../auth.js'
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

// Список файлов проекта (?taskId=... — только вложения задачи; ?page= и ?q= — пагинация/поиск)
filesRoute.get('/', async (c) => {
  const { projectId } = c.get('auth')
  const taskId = c.req.query('taskId')
  const q = (c.req.query('q') ?? '').trim()
  const page = Math.max(1, Number(c.req.query('page')) || 1)

  const conds = [eq(files.projectId, projectId)]
  if (taskId) conds.push(eq(files.taskId, taskId))
  if (q) conds.push(ilike(files.name, `%${q}%`))

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
    hasOriginal: Boolean(r.file.originalKey),
    uploader: r.uploader ? { id: r.uploader.id, name: r.uploader.name, avatarUrl: r.uploader.avatarUrl } : null,
  }))
  return c.json({ items, page, hasMore })
})

const OPTIMIZABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/tiff'])
const MAX_DIMENSION = 2048
const WEBP_QUALITY = 82

// Загрузка: multipart/form-data, поле "file"; taskId — вложение задачи;
// keepOriginal=1 — не оптимизировать (как «отправить оригинал» в WhatsApp).
// Картинки по умолчанию: resize ≤2048px + webp; оригинал сохраняется рядом (originalKey).
filesRoute.post('/', async (c) => {
  const { projectId, sub } = c.get('auth')

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

// Удаление (загрузивший или owner/admin)
filesRoute.delete('/:fileId', async (c) => {
  const { projectId, sub, role } = c.get('auth')
  const fileId = c.req.param('fileId')
  const file = await db.query.files.findFirst({ where: and(eq(files.id, fileId), eq(files.projectId, projectId)) })
  if (!file) return c.json({ error: 'Not found' }, 404)

  const allowed = file.uploadedById === sub || role === 'owner' || role === 'admin'
  if (!allowed) return c.json({ error: 'Forbidden' }, 403)

  await db.delete(files).where(eq(files.id, fileId))
  deleteObject(file.key).catch((e) => console.error('[s3] delete failed:', e)) // best-effort
  if (file.originalKey) deleteObject(file.originalKey).catch(() => {})
  return c.json({ ok: true })
})
