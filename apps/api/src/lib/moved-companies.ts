import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { platformSettings } from '../db/schema.js'

/**
 * Компании, которые переехали на свою инфраструктуру (например, StartPlan —
 * на tasks.startplan.net). Их люди остаются у нас и видят баннер «компания
 * переехала» — список живёт в platform_settings, а не в коде:
 *
 *   key   = 'companies.moved'
 *   value = {"<companyId>": {"url": "https://tasks.startplan.net", "deleteAt": "2026-10-16"}, …}
 *
 * url необязателен: без него баннер просто говорит, что компания переехала.
 * deleteAt — пока данные лежат у нас «витриной», чтобы люди сравнили; баннер
 * называет дату, после которой их удалят. Само удаление — руками, не по дате.
 */
export const MOVED_KEY = 'companies.moved'

export type Moved = { url: string | null; deleteAt: string | null }

/** Разбор значения настройки. Кривой JSON — никто не переехал, а не падение списка компаний. */
export function parseMoved(value: string | null | undefined): Map<string, Moved> {
  const out = new Map<string, Moved>()
  if (!value) return out
  let raw: unknown
  try {
    raw = JSON.parse(value)
  } catch {
    return out
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const o = v && typeof v === 'object' ? (v as { url?: unknown; deleteAt?: unknown }) : {}
    const url = typeof o.url === 'string' ? o.url : null
    const deleteAt = typeof o.deleteAt === 'string' && !Number.isNaN(Date.parse(o.deleteAt)) ? o.deleteAt : null
    // Только http(s): адрес уходит в ссылку баннера.
    out.set(id, { url: url && /^https?:\/\//.test(url) ? url : null, deleteAt })
  }
  return out
}

export async function movedCompanies(): Promise<Map<string, Moved>> {
  const [row] = await db.select({ value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.key, MOVED_KEY))
  return parseMoved(row?.value)
}

/**
 * То же для частых проверок (каждое удаление из хранилища, фоновые письма):
 * не ходим в базу чаще раза в минуту. Флажок ставят руками раз в жизни
 * компании — минута запаздывания ничего не стоит.
 */
let cached: { at: number; moved: Map<string, Moved> } | null = null
export async function movedCompaniesCached(): Promise<Map<string, Moved>> {
  if (cached && Date.now() - cached.at < 60_000) return cached.moved
  try {
    cached = { at: Date.now(), moved: await movedCompanies() }
  } catch {
    // База не ответила — помним прежний список, а не «никто не переехал»:
    // иначе защита хранилища снялась бы ровно на сбое.
    if (cached) return cached.moved
    throw new Error('moved companies are unknown')
  }
  return cached.moved
}
