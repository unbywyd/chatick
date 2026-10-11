import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import {
  createChatickServer,
  isInitializeRequest,
  setApiBase,
  WebStandardStreamableHTTPServerTransport,
  type Scope,
} from '@chatick/mcp/hosted'
import { authenticateBridge, type BridgeIdentity } from '../lib/bridge-auth.js'
import { env } from '../env.js'
import { API_BASE } from './oauth.js'

/**
 * MCP по адресу (v2): https://api.chatick.com/mcp — Streamable HTTP + OAuth.
 *
 * Человеку не нужно ничего ставить: Claude подключается по адресу, вход —
 * через браузер. Инструменты те же, что у программы (apps/mcp/src/tools.ts),
 * кроме тех, что живут на машине человека (подключение кодом, его диск и
 * браузер). Каждый инструмент ходит в мост /x этого же сервера с токеном
 * коннектора — права, гайд и правила одни на всех.
 *
 * Сессии MCP — в памяти процесса: после перезапуска клиент получает 404 на
 * старую сессию и сам начинает новую (так требует спецификация).
 */
export const mcpRoute = new Hono()

// Инструменты зовут мост этого же процесса: через интернет к себе незачем.
setApiBase(`http://127.0.0.1:${env.PORT}`)

type Session = {
  transport: InstanceType<typeof WebStandardStreamableHTTPServerTransport>
  userId: string
  token: string
  lastUsed: number
}
const sessions = new Map<string, Session>()
const IDLE_MS = 30 * 60_000
const PER_USER = 10

// Забытые сессии не держим: клиент вернётся — начнёт новую.
setInterval(() => {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > IDLE_MS) {
      sessions.delete(id)
      void s.transport.close().catch(() => {})
    }
  }
}, 60_000).unref()

const kindOf = (id: BridgeIdentity): Scope['kind'] => (id.scopeAll ? 'all' : id.projectId ? 'project' : 'company')

/**
 * 401 по спецификации MCP: WWW-Authenticate указывает, где искать
 * авторизацию, — по нему клиент сам запускает OAuth.
 */
function unauthorized(hadToken: boolean) {
  const meta = `${API_BASE()}/.well-known/oauth-protected-resource/mcp`
  return new Response(JSON.stringify({ error: hadToken ? 'invalid_token' : 'unauthorized' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': `Bearer resource_metadata="${meta}"${hadToken ? ', error="invalid_token"' : ''}`,
    },
  })
}

const rpcError = (status: number, code: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

mcpRoute.all('/mcp', async (c) => {
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  const identity = token ? await authenticateBridge(token) : null
  if (!identity) return unauthorized(Boolean(token))

  const sid = c.req.header('mcp-session-id')
  if (sid) {
    const s = sessions.get(sid)
    // Чужую или забытую сессию не продолжаем: 404 велит клиенту начать заново.
    if (!s || s.userId !== identity.userId) return rpcError(404, -32001, 'Session not found')
    s.token = token // токен мог обновиться по refresh
    s.lastUsed = Date.now()
    return s.transport.handleRequest(c.req.raw)
  }

  if (c.req.method !== 'POST') return rpcError(400, -32000, 'No session: start with initialize')
  const body = (await c.req.raw.clone().json().catch(() => null)) as unknown
  const isInit = Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body)
  if (!isInit) return rpcError(400, -32000, 'No session: start with initialize')

  // Не больше PER_USER сессий на человека: старейшие закрываем.
  const mine = [...sessions.entries()].filter(([, s]) => s.userId === identity.userId).sort((a, b) => a[1].lastUsed - b[1].lastUsed)
  for (const [id, s] of mine.slice(0, Math.max(0, mine.length - PER_USER + 1))) {
    sessions.delete(id)
    void s.transport.close().catch(() => {})
  }

  const holder: Session = {
    transport: undefined as never,
    userId: identity.userId,
    token,
    lastUsed: Date.now(),
  }
  const server = createChatickServer({
    local: false,
    // Токен берём из ТЕКУЩЕГО запроса сессии: коннектор обновляет его раз в час.
    need: async () => ({ token: holder.token, projectId: identity.projectId, kind: kindOf(identity) }),
  })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, holder)
    },
    onsessionclosed: (id) => {
      sessions.delete(id)
    },
  })
  holder.transport = transport
  await server.connect(transport)
  return transport.handleRequest(c.req.raw, { parsedBody: body })
})
