import { createHash, randomBytes } from 'node:crypto'
import { and, eq, isNull, or } from 'drizzle-orm'
import { db } from '../db/client.js'
import { bridgeSessions, oauthClients, oauthGrants, oauthRequests } from '../db/schema.js'

/**
 * OAuth 2.1 для MCP по адресу (v2): коннектор Claude сам регистрируется, ведёт
 * человека на согласие и получает токены — программу ставить не нужно.
 *
 * Только публичные клиенты с PKCE (S256), без секретов: коннекторы так и
 * работают. Доступ, который получает клиент, — обычная сессия моста с
 * выбранной человеком областью (проект / компания / всё), поэтому права,
 * гайд и ручки /x — те же самые, без второй копии правил.
 *
 * В базе только хэши кодов и токенов: дамп базы доступа не даёт.
 */

export const ACCESS_TTL_MS = 3600_000 // час: короче — чаще refresh, длиннее — дольше живёт утёкший токен
export const REQUEST_TTL_MS = 10 * 60_000 // на согласие и обмен кода
export const GRANT_MAX_MS = 90 * 24 * 3600_000 // потом — войти заново
export const ROTATION_GRACE_MS = 60_000

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const secret = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`

/** PKCE S256: base64url(sha256(verifier)) === challenge. */
export function pkceOk(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false
  return createHash('sha256').update(verifier).digest('base64url') === challenge
}

/**
 * Адрес возврата клиента: https, или http только на свою машину (Claude Code
 * слушает localhost). Всё прочее — способ увести код на чужой сайт.
 */
export function redirectUriOk(uri: string): boolean {
  try {
    const u = new URL(uri)
    if (u.hash) return false
    if (u.protocol === 'https:') return true
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  } catch {
    return false
  }
}

export async function registerClient(input: { name: string; redirectUris: string[] }) {
  const [row] = await db
    .insert(oauthClients)
    .values({ name: input.name.slice(0, 120), redirectUris: JSON.stringify(input.redirectUris) })
    .returning()
  return row!
}

export async function clientById(id: string) {
  return db.query.oauthClients.findFirst({ where: eq(oauthClients.id, id) })
}

export const clientRedirects = (c: { redirectUris: string }): string[] => JSON.parse(c.redirectUris || '[]') as string[]

export async function createRequest(input: { clientId: string; redirectUri: string; codeChallenge: string; state: string | null }) {
  const [row] = await db
    .insert(oauthRequests)
    .values({ ...input, expiresAt: new Date(Date.now() + REQUEST_TTL_MS) })
    .returning()
  return row!
}

export async function pendingRequest(id: string) {
  const r = await db.query.oauthRequests.findFirst({ where: eq(oauthRequests.id, id) })
  if (!r || r.status !== 'pending' || r.expiresAt.getTime() < Date.now()) return null
  return r
}

export type GrantScope = { projectId?: string; companyId?: string; all?: true }

/** Адрес возврата с параметрами — так, как его ждёт клиент. */
export function redirectWith(uri: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(uri)
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v)
  return u.toString()
}

/** Человек согласился: одноразовый код на 10 минут, привязанный к PKCE. */
export async function approveRequest(id: string, userId: string, scope: GrantScope): Promise<string | null> {
  const r = await pendingRequest(id)
  if (!r) return null
  const code = secret('ckc_')
  await db
    .update(oauthRequests)
    .set({
      status: 'approved',
      userId,
      projectId: scope.projectId ?? null,
      companyId: scope.companyId ?? null,
      scopeAll: scope.all === true,
      codeHash: hash(code),
      expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
    })
    .where(and(eq(oauthRequests.id, id), eq(oauthRequests.status, 'pending')))
  return redirectWith(r.redirectUri, { code, state: r.state })
}

export async function denyRequest(id: string): Promise<string | null> {
  const r = await pendingRequest(id)
  if (!r) return null
  await db.update(oauthRequests).set({ status: 'denied' }).where(eq(oauthRequests.id, id))
  return redirectWith(r.redirectUri, { error: 'access_denied', state: r.state })
}

export type TokenResponse = { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string }
export type TokenError = { error: 'invalid_grant' | 'invalid_request' | 'invalid_client' | 'unsupported_grant_type'; error_description?: string }

/** Доступ на час — обычная сессия моста; закрыть её на странице подключения = отозвать грант. */
async function issueSession(grant: typeof oauthGrants.$inferSelect, clientName: string): Promise<string> {
  const token = secret('ck_')
  await db.insert(bridgeSessions).values({
    tokenHash: hash(token),
    userId: grant.userId,
    projectId: grant.projectId,
    companyId: grant.companyId,
    scopeAll: grant.scopeAll,
    clientName: clientName || 'Claude (connector)',
    oauthGrantId: grant.id,
    expiresAt: new Date(Date.now() + ACCESS_TTL_MS),
  })
  return token
}

/** Код → токены. Код одноразовый; не тот verifier или адрес возврата — отказ. */
export async function exchangeCode(input: { code: string; verifier: string; redirectUri: string; clientId: string }): Promise<TokenResponse | TokenError> {
  const r = await db.query.oauthRequests.findFirst({ where: eq(oauthRequests.codeHash, hash(input.code)) })
  if (!r || r.status !== 'approved' || r.expiresAt.getTime() < Date.now() || !r.userId) return { error: 'invalid_grant' }
  if (r.clientId !== input.clientId || r.redirectUri !== input.redirectUri) return { error: 'invalid_grant' }
  if (!pkceOk(input.verifier, r.codeChallenge)) return { error: 'invalid_grant', error_description: 'PKCE verification failed' }
  // Сначала гасим код, потом выдаём: второй параллельный обмен того же кода
  // не должен получить второй грант.
  const used = await db
    .update(oauthRequests)
    .set({ status: 'used' })
    .where(and(eq(oauthRequests.id, r.id), eq(oauthRequests.status, 'approved')))
    .returning()
  if (!used.length) return { error: 'invalid_grant' }

  const refresh = secret('ckr_')
  const [grant] = await db
    .insert(oauthGrants)
    .values({
      clientId: r.clientId,
      userId: r.userId,
      projectId: r.projectId,
      companyId: r.companyId,
      scopeAll: r.scopeAll,
      refreshHash: hash(refresh),
    })
    .returning()
  const client = await clientById(r.clientId)
  const access = await issueSession(grant!, client?.name ?? '')
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: '' }
}

/**
 * Refresh с ротацией. Прежний refresh живёт минуту: Claude обновляет токены
 * параллельно, и строгая ротация роняла бы коннектор (так уже было у
 * соседнего продукта). Прежний refresh позже минуты — признак утечки:
 * отзываем весь грант.
 */
export async function refreshGrant(input: { refreshToken: string; clientId: string }): Promise<TokenResponse | TokenError> {
  const h = hash(input.refreshToken)
  const g = await db.query.oauthGrants.findFirst({
    where: and(or(eq(oauthGrants.refreshHash, h), eq(oauthGrants.prevRefreshHash, h))!, isNull(oauthGrants.revokedAt)),
  })
  if (!g || g.clientId !== input.clientId) return { error: 'invalid_grant' }
  if (g.grantedAt.getTime() + GRANT_MAX_MS < Date.now()) {
    await revokeGrant(g.id)
    return { error: 'invalid_grant', error_description: 'Access expired — connect again' }
  }
  if (g.prevRefreshHash === h && (!g.rotatedAt || g.rotatedAt.getTime() + ROTATION_GRACE_MS < Date.now())) {
    await revokeGrant(g.id)
    return { error: 'invalid_grant', error_description: 'Refresh token reused' }
  }
  const refresh = secret('ckr_')
  const [next] = await db
    .update(oauthGrants)
    .set({ refreshHash: hash(refresh), prevRefreshHash: g.refreshHash, rotatedAt: new Date() })
    .where(eq(oauthGrants.id, g.id))
    .returning()
  const client = await clientById(g.clientId)
  const access = await issueSession(next!, client?.name ?? '')
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: '' }
}

/** Отозвать грант и все его сессии. */
export async function revokeGrant(grantId: string): Promise<void> {
  await db.update(oauthGrants).set({ revokedAt: new Date() }).where(eq(oauthGrants.id, grantId))
  await db
    .update(bridgeSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(bridgeSessions.oauthGrantId, grantId), isNull(bridgeSessions.revokedAt)))
}

/** RFC 7009: отзыв по любому из токенов. Неизвестный токен — не ошибка. */
export async function revokeToken(token: string): Promise<void> {
  const h = hash(token)
  const g = await db.query.oauthGrants.findFirst({ where: or(eq(oauthGrants.refreshHash, h), eq(oauthGrants.prevRefreshHash, h)) })
  if (g) return revokeGrant(g.id)
  const s = await db.query.bridgeSessions.findFirst({ where: eq(bridgeSessions.tokenHash, h) })
  if (s?.oauthGrantId) return revokeGrant(s.oauthGrantId)
  if (s) await db.update(bridgeSessions).set({ revokedAt: new Date() }).where(eq(bridgeSessions.id, s.id))
}
