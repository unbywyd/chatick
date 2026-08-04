import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { gzipSync } from 'node:zlib'
import { db } from '../db/client.js'
import { companies, companyMembers, projects } from '../db/schema.js'
import { requireSession, type SessionEnv } from '../auth.js'
import { exportCompany, exportSummary, importCompany, type BackupFile } from '../lib/backup.js'
import { resolveStorage, isCustomStorage } from '../lib/s3.js'
import { logActivity } from '../lib/audit.js'
import { backupCompany } from '../lib/auto-backup.js'

// Экспорт/импорт компании (SPEC §8.28). Только админ компании: архив содержит
// данные всех проектов, включая переписку.
export const backupRoute = new Hono<SessionEnv>()
backupRoute.use('*', requireSession)

async function requireCompanyAdmin(companyId: string, userId: string) {
  const m = await db.query.companyMembers.findFirst({
    where: and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId)),
  })
  return m?.role === 'admin'
}

/** Что попадёт в архив + куда его можно выгрузить. */
backupRoute.get('/:companyId/summary', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  if (!(await requireCompanyAdmin(companyId, sub))) return c.json({ error: 'Forbidden' }, 403)

  const summary = await exportSummary(companyId)

  // Своё хранилище настраивается на уровне ПРОЕКТА: показываем, у скольких
  // проектов оно своё — от этого зависит, куда можно класть бэкап.
  const projectRows = await db.query.projects.findMany({ where: eq(projects.companyId, companyId) })
  let ownStorage = 0
  for (const p of projectRows) if (await isCustomStorage(p.id)) ownStorage++

  return c.json({
    ...summary,
    storage: {
      projectsWithOwnStorage: ownStorage,
      projectsTotal: projectRows.length,
      // если своего хранилища нет — бэкап можно только скачать
      canUploadToOwnStorage: ownStorage > 0,
    },
  })
})

/** Скачать архив. password (опц.) — включает в архив секреты ресурсов. */
backupRoute.post('/:companyId/export', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  if (!(await requireCompanyAdmin(companyId, sub))) return c.json({ error: 'Forbidden' }, 403)

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const password = typeof body.password === 'string' && body.password.length >= 8 ? body.password : undefined
  if (body.includeSecrets && !password) {
    return c.json({ error: 'A password of at least 8 characters is required to include secrets' }, 400)
  }

  const backup = await exportCompany(companyId, password)
  const firstProject = backup.projects[0]?.project.id as string | undefined
  if (firstProject) {
    void logActivity({
      projectId: firstProject,
      actorId: sub,
      action: 'upload', // ближайшее по смыслу: выгрузка данных наружу
      entityType: 'project',
      entityId: companyId,
      entityLabel: `company export: ${String(backup.company.name ?? '')}`,
    })
  }

  const json = JSON.stringify(backup, null, 2)
  const name = `chatick-backup-${String(backup.company.name ?? 'company')
    .replace(/[^\w-]+/g, '_')
    .slice(0, 40)}-${new Date().toISOString().slice(0, 10)}.json`
  c.header('Content-Type', 'application/json; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="${name}"`)
  return c.body(json)
})

/**
 * Положить архив в СВОЁ хранилище компании (S3/R2 проекта).
 * Смысл именно в этом: бэкап оказывается там, куда мы доступа не имеем.
 */
/**
 * Разовый бэкап в хранилище компании — та же кнопка, что и у планировщика.
 *
 * Проект больше не выбирается: хранилище одно на компанию (SPEC §8.47), и
 * вопрос «чей бакет использовать» перестал иметь смысл.
 */
backupRoute.post('/:companyId/backup-to-storage', async (c) => {
  const { sub } = c.get('session')
  const companyId = c.req.param('companyId')
  if (!(await requireCompanyAdmin(companyId, sub))) return c.json({ error: 'Forbidden' }, 403)

  try {
    const out = await backupCompany(companyId)
    await db.update(companies).set({ lastBackupAt: new Date(), lastBackupError: null }).where(eq(companies.id, companyId))
    return c.json({ ok: true, ...out })
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    console.error('[backup] upload failed:', detail)
    return c.json({ error: 'Upload to your storage failed', detail }, 502)
  }
})

/** Восстановление: создаёт НОВУЮ компанию, ничего не перезаписывает. */
backupRoute.post('/import', async (c) => {
  const { sub } = c.get('session')
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const backup = body.backup as BackupFile | undefined
  const password = typeof body.password === 'string' ? body.password : undefined

  if (!backup || typeof backup !== 'object' || !Array.isArray(backup.projects)) {
    return c.json({ error: 'Not a Chatick backup file' }, 400)
  }
  if (backup.secretsEncrypted && !password) {
    return c.json(
      { error: 'This backup contains encrypted secrets — provide the password used when exporting', needPassword: true },
      400,
    )
  }

  try {
    const result = await importCompany(backup, sub, password)
    return c.json(result, 201)
  } catch (e) {
    console.error('[backup] import failed:', e)
    return c.json({ error: 'Import failed', detail: String(e instanceof Error ? e.message : e) }, 500)
  }
})
