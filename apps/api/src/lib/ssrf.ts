import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

// Защита от SSRF: куда нашему серверу ходить нельзя.
//
// Всюду, где мы обращаемся по адресу, который назвал пользователь — иконка
// сайта, вебхук заказчика, — без этой проверки нашими руками можно постучаться
// на 127.0.0.1 или в метаданные облака и прочитать то, что снаружи закрыто.
//
// Вынесено в общий модуль, чтобы вторая такая ручка не завелась без защиты
// просто потому, что автор о ней не знал.

export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase()
    if (v6 === '::1' || v6 === '::') return true
    // ULA (fc00::/7) и link-local (fe80::/10)
    if (/^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)) return true
    // ::ffff:127.0.0.1 — v4 внутри v6
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    return mapped ? isPrivateIp(mapped[1]!) : false
  }
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true
  const [a, b] = p as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // метаданные облака
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a >= 224) return true // multicast и зарезервированное
  return false
}

/** Проверяет адрес и возвращает его же, если ходить туда безопасно. */
export async function assertPublic(u: URL): Promise<void> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('unsupported protocol')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  // Литеральный IP проверяем как есть, имя — резолвим.
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address)
  if (!ips.length) throw new Error('unresolved')
  // Все адреса: домен может отдавать и внешний, и внутренний.
  for (const ip of ips) if (isPrivateIp(ip)) throw new Error('private address')
}

