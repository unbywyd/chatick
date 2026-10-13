import list from './heroes.json'

/**
 * Герои стола: персонаж в кресле, вид сверху, руки на нижнем крае картинки.
 * Каталог приносит apps/api/scripts/heroes-sync.mjs из набора VexelKit;
 * помеченные skip — дубли, их не показываем.
 */
export type Hero = { slug: string; w: number; h: number }
export const HEROES: Hero[] = (list as (Hero & { skip?: boolean })[]).filter((h) => !h.skip && h.w && h.h)
const bySlug = new Map(HEROES.map((h) => [h.slug, h]))

export const heroSrc = (slug: string) => `${import.meta.env.BASE_URL}heroes/${slug}.webp`

/**
 * Герой человека. Сервер раздаёт его сам; если почему-то не пришёл —
 * стабильный по id, чтобы человек не менялся от перерисовки к перерисовке.
 */
export function heroOf(p: { id: string; hero?: string | null }): Hero {
  const own = p.hero ? bySlug.get(p.hero) : undefined
  if (own) return own
  let n = 0
  for (const ch of p.id) n = (n * 31 + ch.charCodeAt(0)) >>> 0
  return HEROES[n % HEROES.length]!
}
