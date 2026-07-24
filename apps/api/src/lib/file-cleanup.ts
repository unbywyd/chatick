import { and, eq, isNotNull, lt } from 'drizzle-orm'
import { db } from '../db/client.js'
import { files } from '../db/schema.js'
import { resolveStorage, deleteObject } from './s3.js'

// Очистка просроченных временных вложений композера (SPEC §8.17).
// Файл с pendingUntil в прошлом так и не был привязан к сообщению/комментарию — удаляем
// запись и объекты в хранилище. Group по проекту, чтобы взять правильный store.

export async function sweepPendingFiles(): Promise<number> {
  try {
    const expired = await db
      .select()
      .from(files)
      .where(and(isNotNull(files.pendingUntil), lt(files.pendingUntil, new Date())))
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
