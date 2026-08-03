import { randomBytes } from 'node:crypto'

// Одноразовые ссылки входа из внешней системы (SPEC-INTEGRATION §5).
//
// Человек уже вошёл у заказчика, тот подтвердил ключом компании, кто это, —
// заставлять входить второй раз незачем. Ссылка проводит его прямо в проект.
//
// Такая ссылка на короткое время эквивалентна паролю, поэтому:
//   - живёт 5 минут;
//   - сгорает при первом использовании;
//   - привязана к конкретному человеку и компании, которая её выдала;
//   - существует только в памяти процесса — перезапуск обесценивает все
//     невостребованные ссылки, и это скорее хорошо, чем плохо.

type Pending = { userId: string; companyId: string; to: string | null; expiresAt: number }

const links = new Map<string, Pending>()
const TTL_MS = 5 * 60_000

function sweep() {
  const now = Date.now()
  for (const [k, v] of links) if (v.expiresAt < now) links.delete(k)
}

/**
 * @param to — путь ВНУТРИ приложения, например /p/<id>/tasks.
 *   Только путь: полный адрес превратил бы ссылку в открытый редиректор —
 *   злоумышленник шлёт её с чужим доменом, человек видит настоящий адрес
 *   Chatick и уходит на подделку.
 */
export function issueEnterToken(userId: string, companyId: string, to?: string | null): { token: string; expiresInSec: number } {
  sweep()
  const token = randomBytes(32).toString('base64url')
  links.set(token, { userId, companyId, to: safePath(to), expiresAt: Date.now() + TTL_MS })
  return { token, expiresInSec: TTL_MS / 1000 }
}

/** Разрешаем только внутренние пути. Всё остальное отбрасываем молча. */
export function safePath(to?: string | null): string | null {
  if (!to || typeof to !== 'string') return null
  const path = to.trim()
  // «//злой.сайт» браузер понимает как внешний адрес, а «/p/1» — как свой.
  if (!path.startsWith('/') || path.startsWith('//')) return null
  if (path.includes('://')) return null
  return path.slice(0, 300)
}

export type EnterResult = { ok: true; userId: string; companyId: string; to: string | null } | { ok: false }

/** Обменять токен. Второй раз тот же токен не сработает. */
export function consumeEnterToken(token: string): EnterResult {
  sweep()
  const found = links.get(token)
  if (!found || found.expiresAt < Date.now()) return { ok: false }
  // Сжигаем сразу: ссылку могли переслать, и она не должна пускать дважды.
  links.delete(token)
  return { ok: true, userId: found.userId, companyId: found.companyId, to: found.to }
}
