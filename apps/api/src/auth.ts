import { SignJWT, jwtVerify } from 'jose'
import { createMiddleware } from 'hono/factory'
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
  c.set('auth', payload)
  await next()
})
