import { createHash, randomBytes } from 'node:crypto'
import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { bridgeAuthCodes, bridgeSessions, projects, users } from '../db/schema.js'
import { memberDomains, type DomainPermissions } from '../routes/projects.js'

// Авторизация моста для внешнего ИИ (SPEC §8.27).
//
// Постоянных токенов в системе НЕТ. Модель: «открыл туннель — получил токен,
// закрыл — токен мёртв». Плюс device flow: токен не проходит через историю
// команд, человек подтверждает доступ в браузере (как gh/heroku/vercel).

export const CODE_TTL_MS = 10 * 60_000 // на подтверждение в браузере
export const SESSION_TTL_MS = 12 * 3600_000 // потолок жизни туннеля
export const IDLE_TTL_MS = 2 * 3600_000 // простой: забытый туннель закрывается сам

// В БД лежит только хэш — дамп базы не даёт доступа.
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

/** Код для человека: читается вслух и не путается (без 0/O, 1/I). */
function humanCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const pick = (n: number) =>
    Array.from(randomBytes(n))
      .map((b) => alphabet[b % alphabet.length])
      .join('')
  return `${pick(4)}-${pick(4)}`
}

export type BridgeIdentity = {
  sessionId: string
  userId: string
  projectId: string
  user: { id: string; name: string; email: string }
  project: { id: string; name: string }
  permissions: DomainPermissions
}

/** Шаг 1 (ИИ): запросить код. Токена здесь ещё нет. */
export async function startDeviceAuth(clientName: string) {
  const userCode = humanCode()
  const deviceCode = randomBytes(32).toString('base64url')
  await db.insert(bridgeAuthCodes).values({
    userCode,
    deviceCode,
    clientName: clientName.slice(0, 100),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  })
  return { userCode, deviceCode, expiresInSec: Math.floor(CODE_TTL_MS / 1000) }
}

/** Шаг 2 (человек в браузере): найти код, чтобы показать, что именно одобряется. */
export async function lookupUserCode(userCode: string) {
  const row = await db.query.bridgeAuthCodes.findFirst({
    where: eq(bridgeAuthCodes.userCode, userCode.trim().toUpperCase()),
  })
  if (!row || row.status !== 'pending' || row.expiresAt.getTime() < Date.now()) return null
  return { id: row.id, clientName: row.clientName }
}

/** Шаг 3 (человек): подтвердить доступ к конкретному проекту. */
export async function approveUserCode(userCode: string, userId: string, projectId: string) {
  const code = await lookupUserCode(userCode)
  if (!code) return false
  await db
    .update(bridgeAuthCodes)
    .set({ status: 'approved', userId, projectId })
    .where(eq(bridgeAuthCodes.id, code.id))
  return true
}

export async function denyUserCode(userCode: string) {
  await db
    .update(bridgeAuthCodes)
    .set({ status: 'denied' })
    .where(eq(bridgeAuthCodes.userCode, userCode.trim().toUpperCase()))
}

/**
 * Шаг 4 (ИИ опрашивает): обменять deviceCode на токен.
 * Код сгорает при первом успешном обмене — повторно им не воспользоваться.
 */
export async function pollDeviceAuth(
  deviceCode: string,
): Promise<{ status: 'pending' | 'denied' | 'expired' } | { status: 'approved'; token: string; identity: BridgeIdentity }> {
  const row = await db.query.bridgeAuthCodes.findFirst({ where: eq(bridgeAuthCodes.deviceCode, deviceCode) })
  if (!row) return { status: 'expired' }
  if (row.expiresAt.getTime() < Date.now()) return { status: 'expired' }
  if (row.status === 'denied') return { status: 'denied' }
  if (row.status !== 'approved' || !row.userId || !row.projectId) return { status: 'pending' }

  const token = `ck_${randomBytes(32).toString('base64url')}`
  const now = Date.now()
  const [session] = await db
    .insert(bridgeSessions)
    .values({
      tokenHash: hash(token),
      userId: row.userId,
      projectId: row.projectId,
      clientName: row.clientName,
      expiresAt: new Date(now + SESSION_TTL_MS),
    })
    .returning()

  // код одноразовый
  await db.delete(bridgeAuthCodes).where(eq(bridgeAuthCodes.id, row.id))

  const identity = await identityOf(session!.id, row.userId, row.projectId)
  if (!identity) return { status: 'expired' }
  return { status: 'approved', token, identity }
}

async function identityOf(sessionId: string, userId: string, projectId: string): Promise<BridgeIdentity | null> {
  const [user, project, permissions] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, userId) }),
    db.query.projects.findFirst({ where: eq(projects.id, projectId) }),
    memberDomains(projectId, userId),
  ])
  // участие в проекте могли отозвать уже после открытия туннеля
  if (!user || !project || !permissions) return null
  return {
    sessionId,
    userId,
    projectId,
    user: { id: user.id, name: user.name, email: user.email },
    project: { id: project.id, name: project.name },
    permissions,
  }
}

/**
 * Проверка токена на каждом запросе моста. Возвращает личность владельца —
 * дальше всё идёт через обычный hasPermission, как для живого пользователя.
 */
export async function authenticateBridge(token: string | undefined | null): Promise<BridgeIdentity | null> {
  if (!token) return null
  const row = await db.query.bridgeSessions.findFirst({ where: eq(bridgeSessions.tokenHash, hash(token)) })
  if (!row || row.revokedAt) return null

  const now = Date.now()
  // истёк по сроку или по простою — закрываем
  if (row.expiresAt.getTime() < now || now - row.lastUsedAt.getTime() > IDLE_TTL_MS) {
    await db.update(bridgeSessions).set({ revokedAt: new Date() }).where(eq(bridgeSessions.id, row.id))
    return null
  }

  await db.update(bridgeSessions).set({ lastUsedAt: new Date() }).where(eq(bridgeSessions.id, row.id))
  return identityOf(row.id, row.userId, row.projectId)
}

/** Закрыть туннель (человеком со страницы подключения или самим ИИ). */
export async function closeSession(sessionId: string, userId: string) {
  await db
    .update(bridgeSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(bridgeSessions.id, sessionId), eq(bridgeSessions.userId, userId)))
}

/** Активные туннели пользователя — для страницы подключения. */
export async function listSessions(userId: string) {
  const rows = await db
    .select({ s: bridgeSessions, project: projects })
    .from(bridgeSessions)
    .innerJoin(projects, eq(projects.id, bridgeSessions.projectId))
    .where(and(eq(bridgeSessions.userId, userId), isNull(bridgeSessions.revokedAt)))
  const now = Date.now()
  return rows
    .filter((r) => r.s.expiresAt.getTime() > now && now - r.s.lastUsedAt.getTime() <= IDLE_TTL_MS)
    .map((r) => ({
      id: r.s.id,
      clientName: r.s.clientName,
      project: { id: r.project.id, name: r.project.name },
      lastUsedAt: r.s.lastUsedAt,
      expiresAt: r.s.expiresAt,
      createdAt: r.s.createdAt,
    }))
}

/** Уборка протухших кодов и сессий — вызывается по расписанию. */
export async function sweepBridge(): Promise<void> {
  const now = new Date()
  try {
    await db.delete(bridgeAuthCodes).where(lt(bridgeAuthCodes.expiresAt, now))
    await db
      .update(bridgeSessions)
      .set({ revokedAt: now })
      .where(and(isNull(bridgeSessions.revokedAt), lt(bridgeSessions.expiresAt, now)))
    // и закрытые по простою
    await db
      .update(bridgeSessions)
      .set({ revokedAt: now })
      .where(
        and(
          isNull(bridgeSessions.revokedAt),
          lt(bridgeSessions.lastUsedAt, new Date(Date.now() - IDLE_TTL_MS)),
        ),
      )
    // старые закрытые записи не храним вечно
    await db.delete(bridgeSessions).where(lt(bridgeSessions.revokedAt, new Date(Date.now() - 7 * 24 * 3600_000)))
  } catch (e) {
    console.error('[bridge] sweep failed:', e)
  }
}
