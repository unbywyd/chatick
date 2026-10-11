import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companyMembers } from '../db/schema.js'
import { requireSession, type SessionEnv } from '../auth.js'
import { env } from '../env.js'
import { memberDomains } from './projects.js'
import {
  approveRequest,
  clientById,
  clientRedirects,
  createRequest,
  denyRequest,
  exchangeCode,
  pendingRequest,
  redirectUriOk,
  refreshGrant,
  registerClient,
  revokeToken,
  type GrantScope,
} from '../lib/oauth.js'

/**
 * OAuth для MCP по адресу (v2) — ручки, которые зовёт коннектор Claude.
 *
 * Порядок для человека: добавил в Claude адрес https://api.chatick.com/mcp →
 * Claude открыл браузер → человек вошёл в Chatick (как обычно) и на странице
 * подключения выбрал, к чему дать доступ → готово. Программу ставить не нужно.
 *
 * Согласие — на том же экране подключения, что и для device flow
 * (/#/connect?oauth=<id>): выбор «проект / компания / всё» у человека уже есть.
 */
export const oauthRoute = new Hono()

export const API_BASE = () => (process.env.API_PUBLIC_URL || 'https://api.chatick.com').replace(/\/$/, '')
const APP = () => (env.APP_URL || 'https://app.chatick.com').replace(/\/$/, '')

// --- Discovery ---------------------------------------------------------------

const protectedResource = () => ({
  resource: `${API_BASE()}/mcp`,
  authorization_servers: [API_BASE()],
  bearer_methods_supported: ['header'],
  resource_name: 'Chatick',
})
oauthRoute.get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResource()))
oauthRoute.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(protectedResource()))

oauthRoute.get('/.well-known/oauth-authorization-server', (c) =>
  c.json({
    issuer: API_BASE(),
    authorization_endpoint: `${API_BASE()}/oauth/authorize`,
    token_endpoint: `${API_BASE()}/oauth/token`,
    registration_endpoint: `${API_BASE()}/oauth/register`,
    revocation_endpoint: `${API_BASE()}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [],
  }),
)

// --- Регистрация клиента (RFC 7591) -------------------------------------------

oauthRoute.post('/oauth/register', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { redirect_uris?: unknown; client_name?: unknown }
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u): u is string => typeof u === 'string') : []
  if (!uris.length || uris.length > 10 || !uris.every(redirectUriOk)) {
    return c.json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https (or http on localhost)' }, 400)
  }
  const name = typeof b.client_name === 'string' ? b.client_name : 'Claude (connector)'
  const client = await registerClient({ name, redirectUris: uris })
  return c.json(
    {
      client_id: client.id,
      client_name: client.name,
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    },
    201,
  )
})

// --- Authorize: запрос → страница согласия в приложении -----------------------

oauthRoute.get('/oauth/authorize', async (c) => {
  const q = c.req.query()
  const client = q.client_id ? await clientById(q.client_id) : undefined
  // Пока адрес возврата не проверен, ошибку отдаём здесь, а не редиректом:
  // иначе код ошибки (и state) уехали бы на непроверенный адрес.
  if (!client) return c.json({ error: 'invalid_client' }, 400)
  const redirectUri = q.redirect_uri ?? clientRedirects(client)[0] ?? ''
  if (!clientRedirects(client).includes(redirectUri)) return c.json({ error: 'invalid_request', error_description: 'redirect_uri not registered' }, 400)

  const back = (error: string, description?: string) => {
    const u = new URL(redirectUri)
    u.searchParams.set('error', error)
    if (description) u.searchParams.set('error_description', description)
    if (q.state) u.searchParams.set('state', q.state)
    return c.redirect(u.toString(), 302)
  }
  if (q.response_type !== 'code') return back('unsupported_response_type')
  if (!q.code_challenge || q.code_challenge_method !== 'S256') return back('invalid_request', 'PKCE S256 required')

  const r = await createRequest({ clientId: client.id, redirectUri, codeChallenge: q.code_challenge, state: q.state ?? null })
  return c.redirect(`${APP()}/#/connect?oauth=${encodeURIComponent(r.id)}`, 302)
})

// --- Token / revoke -------------------------------------------------------------

async function params(c: { req: { header: (k: string) => string | undefined; parseBody: () => Promise<Record<string, unknown>>; json: () => Promise<unknown> } }) {
  const ct = c.req.header('content-type') ?? ''
  const raw = ct.includes('application/json')
    ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>)
    : await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
  const s = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string) : '')
  return s
}

oauthRoute.post('/oauth/token', async (c) => {
  const p = await params(c as never)
  c.header('Cache-Control', 'no-store')
  const grant = p('grant_type')
  if (grant === 'authorization_code') {
    if (!p('code') || !p('code_verifier') || !p('client_id')) return c.json({ error: 'invalid_request' }, 400)
    const r = await exchangeCode({ code: p('code'), verifier: p('code_verifier'), redirectUri: p('redirect_uri'), clientId: p('client_id') })
    return c.json(r, 'error' in r ? 400 : 200)
  }
  if (grant === 'refresh_token') {
    if (!p('refresh_token') || !p('client_id')) return c.json({ error: 'invalid_request' }, 400)
    const r = await refreshGrant({ refreshToken: p('refresh_token'), clientId: p('client_id') })
    return c.json(r, 'error' in r ? 400 : 200)
  }
  return c.json({ error: 'unsupported_grant_type' }, 400)
})

oauthRoute.post('/oauth/revoke', async (c) => {
  const p = await params(c as never)
  if (p('token')) await revokeToken(p('token'))
  return c.body(null, 200)
})

// --- Согласие: зовёт экран подключения в приложении (сессия человека) ---------

export const oauthConsentRoute = new Hono<SessionEnv>()
oauthConsentRoute.use('*', requireSession)

oauthConsentRoute.get('/:id', async (c) => {
  const r = await pendingRequest(c.req.param('id'))
  if (!r) return c.json({ error: 'Request not found or expired' }, 404)
  const client = await clientById(r.clientId)
  return c.json({ client: { name: client?.name || 'AI assistant' }, redirectHost: new URL(r.redirectUri).host, expiresAt: r.expiresAt })
})

/**
 * Согласие: те же правила области, что у подключения кодом (auth.ts
 * /bridge/approve) — компания и проект только свои; больше, чем есть у самого
 * человека, коннектор не получит: права проверяются на каждом запросе.
 */
oauthConsentRoute.post('/:id/approve', async (c) => {
  const { sub } = c.get('session')
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  let scope: GrantScope
  if (b.all === true) scope = { all: true }
  else if (typeof b.companyId === 'string' && b.companyId) {
    const m = await db.query.companyMembers.findFirst({
      where: and(eq(companyMembers.companyId, b.companyId), eq(companyMembers.userId, sub)),
    })
    if (!m) return c.json({ error: 'You are not a member of this company' }, 403)
    scope = { companyId: b.companyId }
  } else if (typeof b.projectId === 'string' && b.projectId) {
    if (!(await memberDomains(b.projectId, sub))) return c.json({ error: 'You are not a member of this project' }, 403)
    scope = { projectId: b.projectId }
  } else return c.json({ error: 'projectId, companyId or all:true is required' }, 400)

  const redirect = await approveRequest(c.req.param('id'), sub, scope)
  return redirect ? c.json({ redirect }) : c.json({ error: 'Request not found or expired' }, 404)
})

oauthConsentRoute.post('/:id/deny', async (c) => {
  const redirect = await denyRequest(c.req.param('id'))
  return redirect ? c.json({ redirect }) : c.json({ error: 'Request not found or expired' }, 404)
})
