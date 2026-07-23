import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { db } from '../db/client.js'
import { files, tasks, users } from '../db/schema.js'
import { requireProject, type ProjectEnv } from '../auth.js'
import { s3Client, presignDownload, presignView, deleteObject, S3_KEY_PREFIX, s3Bucket } from '../lib/s3.js'

// Файлы проекта (таб «Файлы») — project-токен, скоуп жёстко из токена.
// Загрузка проксируется через API (R2-токен не может ставить CORS на бакет,
// прямой браузерный PUT недоступен). До 100MB — ок для сервера.
export const filesRoute = new Hono<ProjectEnv>()
filesRoute.use('*', requireProject)

const MAX_FILE_MB = 100

// Список файлов проекта (?taskId=... — только вложения задачи)
filesRoute.get('/', async (c) => {
  const { projectId } = c.get('auth')
  const taskId = c.req.query('taskId')
  const where = taskId
    ? and(eq(files.projectId, projectId), eq(files.taskId, taskId))
    : eq(files.projectId, projectId)

  const rows = await db
    .select({ file: files, uploader: users, taskNumber: tasks.number })
    .from(files)
    .leftJoin(users, eq(users.id, files.uploadedById))
    .leftJoin(tasks, eq(tasks.id, files.taskId))
    .where(where)
    .orderBy(desc(files.createdAt))

  return c.json(
    rows.map((r) => ({
      id: r.file.id,
      name: r.file.name,
      mime: r.file.mime,
      size: Number(r.file.size),
      createdAt: r.file.createdAt,
      taskId: r.file.taskId,
      taskNumber: r.taskNumber,
      uploader: r.uploader ? { id: r.uploader.id, name: r.uploader.name, avatarUrl: r.uploader.avatarUrl } : null,
    })),
  )
})

// Загрузка: multipart/form-data, поле "file"; опционально taskId — вложение задачи
filesRoute.post('/', async (c) => {
  const { projectId, sub } = c.get('auth')

  const body = await c.req.parseBody()
  const file = body['file']
  const taskId = typeof body['taskId'] === 'string' && body['taskId'] ? body['taskId'] : null
  if (!(file instanceof File)) return c.json({ error: 'file field is required' }, 400)
  if (taskId) {
    const task = await db.query.tasks.findFirst({ where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)) })
    if (!task) return c.json({ error: 'Task not found' }, 404)
  }
  if (file.size > MAX_FILE_MB * 1024 * 1024) return c.json({ error: `File too large (max ${MAX_FILE_MB}MB)` }, 413)

  const fileId = nanoid()
  const safeName = file.name.replace(/[/\\]/g, '_')
  const key = `${S3_KEY_PREFIX}/${projectId}/${fileId}-${safeName}`
  const mime = file.type || 'application/octet-stream'

  await s3Client().send(
    new PutObjectCommand({
      Bucket: s3Bucket(),
      Key: key,
      Body: Buffer.from(await file.arrayBuffer()),
      ContentType: mime,
    }),
  )

  const [row] = await db
    .insert(files)
    .values({ id: fileId, projectId, taskId, uploadedById: sub, name: file.name, key, mime, size: String(file.size) })
    .returning()
  return c.json(
    { id: row!.id, name: row!.name, mime: row!.mime, size: Number(row!.size), taskId: row!.taskId, createdAt: row!.createdAt },
    201,
  )
})

// Скачивание — presigned GET (attachment); ?inline=1 — просмотр в браузере (превью/лайтбокс/PDF)
filesRoute.get('/:fileId/download', async (c) => {
  const { projectId } = c.get('auth')
  const fileId = c.req.param('fileId')
  const inline = c.req.query('inline') === '1'
  const file = await db.query.files.findFirst({ where: and(eq(files.id, fileId), eq(files.projectId, projectId)) })
  if (!file) return c.json({ error: 'Not found' }, 404)
  const url = inline ? await presignView(file.key, file.mime) : await presignDownload(file.key, file.name)
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
  return c.json({ ok: true })
})
