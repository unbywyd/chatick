import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companyApiKeys, companyApiLog } from '../db/schema.js'

// Ключи API уровня компании (SPEC-INTEGRATION §2).
//
// Такой ключ позволяет заводить людей и проекты без чьего-либо подтверждения —
// то есть это по сути ключ от всей компании. Отсюда всё остальное в этом
// файле: хеш вместо самого ключа, мгновенный отзыв, белый список адресов,
// журнал каждого вызова.

const PREFIX = 'ck_live_'

export type KeyScope = 'users:write' | 'projects:write' | 'read:all'

/** Что вернули один-единственный раз — при создании. Дальше только префикс. */
export type IssuedKey = { id: string; key: string; prefix: string }

const hashOf = (key: string) => createHash('sha256').update(key).digest('hex')

/**
 * Выпустить ключ. Сам ключ существует только здесь и в ответе — в базе лежит
 * его хеш, поэтому утечка базы не даёт действующих ключей.
 */
export async function issueKey(opts: {
  companyId: string
  name: string
  scopes: KeyScope[]
  allowedIps?: string[]
  createdById?: string | null
}): Promise<IssuedKey> {
  const key = PREFIX + randomBytes(24).toString('base64url')
  const prefix = key.slice(0, PREFIX.length + 6)

  const [row] = await db
    .insert(companyApiKeys)
    .values({
      companyId: opts.companyId,
      name: opts.name.trim().slice(0, 120) || 'API key',
      keyHash: hashOf(key),
      prefix,
      scopes: JSON.stringify(opts.scopes),
      allowedIps: JSON.stringify(opts.allowedIps ?? []),
      createdById: opts.createdById ?? null,
    })
    .returning()

  return { id: row!.id, key, prefix }
}

export type KeyCheck =
  | { ok: true; keyId: string; companyId: string; scopes: KeyScope[] }
  | { ok: false; reason: 'unknown' | 'revoked' | 'ip' | 'scope' }

/**
 * Проверить ключ из заголовка.
 *
 * @param needed — что собирается делать вызов. Ключ без этого права
 *   отвергается: ключ «только чтение» не должен уметь заводить людей.
 */
export async function checkKey(raw: string | undefined, needed: KeyScope, ip: string): Promise<KeyCheck> {
  const key = (raw ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!key.startsWith(PREFIX)) return { ok: false, reason: 'unknown' }

  // Ищем по хешу — сравнивать перебором все ключи было бы и медленно, и
  // уязвимо ко времени ответа.
  const row = await db.query.companyApiKeys.findFirst({ where: eq(companyApiKeys.keyHash, hashOf(key)) })
  if (!row) return { ok: false, reason: 'unknown' }
  if (row.revokedAt) return { ok: false, reason: 'revoked' }

  // Сравнение постоянного времени — на случай, если совпадение хешей когда-то
  // станет частичным (усечённые хеши, изменение алгоритма).
  const a = Buffer.from(row.keyHash)
  const b = Buffer.from(hashOf(key))
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'unknown' }

  const allowed = JSON.parse(row.allowedIps || '[]') as string[]
  // Пустой список — принимаем отовсюду: белый список полезен, но требовать
  // его сразу значит сломать первую же интеграцию, которую настраивают с
  // ноутбука.
  if (allowed.length && !allowed.includes(ip)) return { ok: false, reason: 'ip' }

  const scopes = JSON.parse(row.scopes || '[]') as KeyScope[]
  if (!scopes.includes(needed)) return { ok: false, reason: 'scope' }

  // Отметка «пользовались» — по ней в интерфейсе видно мёртвые ключи, которые
  // пора отозвать. Не ждём записи: она не должна задерживать ответ.
  void db.update(companyApiKeys).set({ lastUsedAt: new Date() }).where(eq(companyApiKeys.id, row.id))

  return { ok: true, keyId: row.id, companyId: row.companyId, scopes }
}

/** Записать вызов. Без журнала разбор инцидента упирается в «кто-то через API». */
export function logCall(opts: {
  companyId: string
  keyId: string | null
  method: string
  path: string
  status: number
  ip: string
}): void {
  void db
    .insert(companyApiLog)
    .values({
      companyId: opts.companyId,
      keyId: opts.keyId,
      method: opts.method,
      // Путь может нести идентификаторы — обрезаем, чтобы журнал не разбухал.
      path: opts.path.slice(0, 300),
      status: opts.status,
      ip: opts.ip.slice(0, 64),
    })
    .catch(() => {})
}

/** Ключи компании — для интерфейса. Сам ключ не возвращается никогда. */
export async function listKeys(companyId: string) {
  const rows = await db.query.companyApiKeys.findMany({
    where: and(eq(companyApiKeys.companyId, companyId), isNull(companyApiKeys.revokedAt)),
  })
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: JSON.parse(r.scopes || '[]') as KeyScope[],
    allowedIps: JSON.parse(r.allowedIps || '[]') as string[],
    lastUsedAt: r.lastUsedAt,
    createdAt: r.createdAt,
  }))
}

/** Отозвать. Проверяется на каждом запросе — значит действует немедленно. */
export async function revokeKey(companyId: string, keyId: string): Promise<boolean> {
  const [row] = await db
    .update(companyApiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(companyApiKeys.id, keyId), eq(companyApiKeys.companyId, companyId)))
    .returning()
  return Boolean(row)
}
