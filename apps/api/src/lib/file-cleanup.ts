import { and, eq, isNotNull, lt, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { files, tasks, taskGroups, credentials } from '../db/schema.js'
import { resolveStorage, deleteObject } from './s3.js'

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // 7 дней в корзине (SPEC §8.21)

// Очистка просроченных временных вложений композера (SPEC §8.17).
// Файл с pendingUntil в прошлом так и не был привязан к сообщению/комментарию — удаляем
// запись и объекты в хранилище. Group по проекту, чтобы взять правильный store.

export async function sweepPendingFiles(): Promise<number> {
  try {
    // ТОЛЬКО просроченные временные (не привязанные) — soft-deleted (deletedAt) сюда НЕ попадают,
    // они чистятся отдельно через 7 дней (SPEC §8.21)
    const expired = await db
      .select()
      .from(files)
      .where(and(isNotNull(files.pendingUntil), lt(files.pendingUntil, new Date()), sql`${files.deletedAt} is null`))
      .limit(500)
    if (!expired.length) return 0

    // сгруппировать по проекту — один store на проект
    const byProject = new Map<string, typeof expired>()
    for (const f of expired) {
      const arr = byProject.get(f.projectId) ?? []
      arr.push(f)
      byProject.set(f.projectId, arr)
    }

    let removed = 0
    for (const [projectId, rows] of byProject) {
      let store
      try {
        store = await resolveStorage(projectId)
      } catch {
        store = null
      }
      for (const f of rows) {
        if (store) {
          deleteObject(store, f.key).catch(() => {})
          if (f.originalKey) deleteObject(store, f.originalKey).catch(() => {})
        }
        await db.delete(files).where(eq(files.id, f.id))
        removed++
      }
      void projectId
    }
    if (removed) console.log(`[file-cleanup] removed ${removed} expired pending file(s)`)
    return removed
  } catch (err) {
    console.error('[file-cleanup] sweep failed:', err)
    return 0
  }
}

/** Окончательно удаляет soft-deleted сущности старше 7 дней (SPEC §8.21). Файлы — с объектами в хранилище. */
export async function sweepSoftDeleted(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_MS)
  try {
    // файлы: сначала снести объекты в хранилище, потом записи
    const expiredFiles = await db.select().from(files).where(and(isNotNull(files.deletedAt), lt(files.deletedAt, cutoff))).limit(500)
    const byProject = new Map<string, typeof expiredFiles>()
    for (const f of expiredFiles) {
      const arr = byProject.get(f.projectId) ?? []
      arr.push(f)
      byProject.set(f.projectId, arr)
    }
    for (const [projectId, rows] of byProject) {
      let store
      try {
        store = await resolveStorage(projectId)
      } catch {
        store = null
      }
      for (const f of rows) {
        if (store) {
          deleteObject(store, f.key).catch(() => {})
          if (f.originalKey) deleteObject(store, f.originalKey).catch(() => {})
        }
        await db.delete(files).where(eq(files.id, f.id))
      }
    }

    // задачи / спринты / ресурсы — просто удаляем записи (каскады сработают)
    const t = await db.delete(tasks).where(and(isNotNull(tasks.deletedAt), lt(tasks.deletedAt, cutoff))).returning({ id: tasks.id })
    const g = await db.delete(taskGroups).where(and(isNotNull(taskGroups.deletedAt), lt(taskGroups.deletedAt, cutoff))).returning({ id: taskGroups.id })
    const cr = await db.delete(credentials).where(and(isNotNull(credentials.deletedAt), lt(credentials.deletedAt, cutoff))).returning({ id: credentials.id })
    const total = expiredFiles.length + t.length + g.length + cr.length
    if (total) console.log(`[cleanup] purged ${total} soft-deleted item(s) older than 7d`)
    void sql
  } catch (err) {
    console.error('[cleanup] soft-delete purge failed:', err)
  }
}
