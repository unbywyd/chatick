import { SignJWT, jwtVerify } from 'jose'
import { createMiddleware } from 'hono/factory'
import { and, eq } from 'drizzle-orm'
import { db } from './db/client.js'
import { projectMembers } from './db/schema.js'
import { env } from './env.js'

const secret = new TextEncoder().encode(env.JWT_SECRET)

// Двухступенчатая модель (см. CONCEPT.md):
//  session — личность после Google-логина; хватает для списка/создания проектов
//  project — сессия + выбранный проект и роль в нём; нужен для всего внутри проекта
export type SessionPayload = { typ: 'session'; sub: string; email: string }
export type ProjectPayload = {
  typ: 'project'
  sub: string
  email: string
  projectId: string
  role: 'owner' | 'admin' | 'member'
}
export type TokenPayload = SessionPayload | ProjectPayload

async function sign(payload: TokenPayload, expiresIn: string): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret)
}

export const signSessionToken = (p: Omit<SessionPayload, 'typ'>) =>
  sign({ typ: 'session', ...p }, '30d')

export const signProjectToken = (p: Omit<ProjectPayload, 'typ'>) =>
  sign({ typ: 'project', ...p }, '30d')

// Короткоживущий file-токен для прокси-отдачи (в URL: img/iframe/Google не шлют Authorization)
export async function signFileToken(fileId: string, projectId: string): Promise<string> {
  return new SignJWT({ typ: 'file', fileId, projectId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret)
}

export async function verifyFileToken(token: string): Promise<{ fileId: string; projectId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret)
    const p = payload as { typ?: string; fileId?: string; projectId?: string }
    if (p.typ !== 'file' || !p.fileId || !p.projectId) return null
    return { fileId: p.fileId, projectId: p.projectId }
  } catch {
    return null
  }
}

export async function verifyToken(token: string): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret)
    return payload as unknown as TokenPayload
  } catch {
    return null
  }
}

function bearer(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined
}

export type SessionEnv = { Variables: { session: SessionPayload | ProjectPayload } }
export type ProjectEnv = { Variables: { auth: ProjectPayload } }

/** Любой валидный токен (session или project) — личность известна. */
export const requireSession = createMiddleware<SessionEnv>(async (c, next) => {
  const token = bearer(c.req.header('Authorization'))
  const payload = token ? await verifyToken(token) : null
  if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  c.set('session', payload)
  await next()
})

/** Только project-токен — все ручки внутри проекта. */
export const requireProject = createMiddleware<ProjectEnv>(async (c, next) => {
  const token = bearer(c.req.header('Authorization'))
  const payload = token ? await verifyToken(token) : null
  if (!payload || payload.typ !== 'project') {
    return c.json({ error: 'Project token required' }, 401)
  }

  // Токен живёт 30 дней, а членство кончается в тот момент, когда человека
  // исключили. Верить проекту и роли из токена — значит оставлять исключённому
  // доступ до конца срока: он продолжал читать и писать в чат и видеть ленту
  // (там, где нет hasPermission, ходящего в базу).
  //
  // Роль тоже берём из базы, а не из токена: понижённый из админов до
  // участника иначе сохранял бы админские права до перевыпуска.
  const membership = await db.query.projectMembers.findFirst({
    where: and(eq(projectMembers.projectId, payload.projectId), eq(projectMembers.userId, payload.sub)),
    columns: { role: true },
  })
  if (!membership) return c.json({ error: 'Forbidden' }, 403)

  c.set('auth', { ...payload, role: membership.role })
  await next()
})
