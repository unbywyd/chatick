import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companyMembers, users } from '../db/schema.js'
import { HEROES } from './heroes-list.js'

/**
 * Герои стола (v2): персонаж в кресле, которым человек сидит в сцене «На столе».
 *
 * Каталог — набор VexelKit, его приносит scripts/heroes-sync.mjs (heroes-list.ts
 * генерируется им же). Героя раздаём сами, при первой нужде: случайного из
 * тех, что реже всего встречаются у людей из тех же компаний, — так в команде
 * повторы появляются, только когда героев меньше, чем людей. Сменить героя
 * человек может в профиле.
 */
export { HEROES }
const KNOWN = new Set<string>(HEROES)
export const isHero = (s: unknown): s is string => typeof s === 'string' && KNOWN.has(s)

/** Сколько раз каждый герой уже занят людьми из компаний этого человека. */
export async function heroUse(userId: string): Promise<Map<string, number>> {
  const companies = db.select({ id: companyMembers.companyId }).from(companyMembers).where(eq(companyMembers.userId, userId))
  const rows = await db
    .selectDistinct({ id: users.id, hero: users.hero })
    .from(users)
    .innerJoin(companyMembers, eq(companyMembers.userId, users.id))
    .where(and(inArray(companyMembers.companyId, companies), isNotNull(users.hero)))
  const count = new Map<string, number>()
  for (const r of rows) if (r.id !== userId && r.hero) count.set(r.hero, (count.get(r.hero) ?? 0) + 1)
  return count
}

/** Герой каждого из людей; у кого его ещё нет — раздаём. */
export async function ensureHeroes(ids: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter(Boolean))]
  const out = new Map<string, string>()
  if (!uniq.length || !HEROES.length) return out
  const rows = await db.select({ id: users.id, hero: users.hero }).from(users).where(inArray(users.id, uniq))
  for (const r of rows) {
    if (isHero(r.hero)) {
      out.set(r.id, r.hero)
      continue
    }
    const use = await heroUse(r.id)
    const min = Math.min(...HEROES.map((h) => use.get(h) ?? 0))
    const pool = HEROES.filter((h) => (use.get(h) ?? 0) === min)
    const pick = pool[Math.floor(Math.random() * pool.length)]!
    // Только если всё ещё пусто: два окна одновременно не должны раздать двух.
    const [set] = await db
      .update(users)
      .set({ hero: pick })
      .where(and(eq(users.id, r.id), r.hero ? eq(users.hero, r.hero) : isNull(users.hero)))
      .returning({ hero: users.hero })
    out.set(r.id, set?.hero ?? (await db.query.users.findFirst({ where: eq(users.id, r.id), columns: { hero: true } }))?.hero ?? pick)
  }
  return out
}
