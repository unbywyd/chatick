import { SignJWT, jwtVerify } from 'jose'
import { createMiddleware } from 'hono/factory'
import { env } from './env.js'

const secret = new TextEncoder().encode(env.JWT_SECRET)

export type JwtPayload = { sub: string; email: string; isAdmin: boolean }

export async function signToken(payload: JwtPayload): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(secret)
}

export async function verifyToken(token: string): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret)
    return payload as unknown as JwtPayload
  } catch {
    return null
  }
}

export type AuthEnv = { Variables: { user: JwtPayload } }

/** Requires a valid Bearer JWT; puts the payload into c.get('user'). */
export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const header = c.req.header('Authorization')
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
  const payload = token ? await verifyToken(token) : null
  if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  c.set('user', payload)
  await next()
})
