import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { platformSettings } from '../db/schema.js'

/**
 * Компании, которые переехали на свою инфраструктуру (например, StartPlan —
 * на tasks.startplan.net). Их люди остаются у нас и видят баннер «компания
 * переехала» — список живёт в platform_settings, а не в коде:
 *
 *   key   = 'companies.moved'
 *   value = {"<companyId>": {"url": "https://tasks.startplan.net"}, …}
 *
 * url необязателен: без него баннер просто говорит, что компания переехала.
 */
export const MOVED_KEY = 'companies.moved'

export type Moved = { url: string | null }

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
    const url = v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string' ? (v as { url: string }).url : null
    // Только http(s): адрес уходит в ссылку баннера.
    out.set(id, { url: url && /^https?:\/\//.test(url) ? url : null })
  }
  return out
}

export async function movedCompanies(): Promise<Map<string, Moved>> {
  const [row] = await db.select({ value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.key, MOVED_KEY))
  return parseMoved(row?.value)
}
