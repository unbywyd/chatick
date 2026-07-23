import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { env, isProd } from './env.js'
import { health } from './routes/health.js'
import { auth } from './routes/auth.js'

export const app = new Hono()

app.use('*', cors({ origin: env.CORS_ORIGIN === '*' ? '*' : env.CORS_ORIGIN.split(',') }))
if (!isProd) app.use('*', logger())

app.route('/health', health)
app.route('/api/v1/auth', auth)

// Модули дальше по мере разработки:
// app.route('/api/v1/projects', projects)   — проекты/группы, участники
// app.route('/api/v1/messages', messages)   — чат + SSE-стрим
// app.route('/api/v1/tasks', tasks)         — таск-менеджер
// app.route('/api/v1/files', files)         — файлы (R2)
// app.route('/api/v1/credentials', creds)   — кредишены (шифрование)
// app.route('/mcp', mcp)                    — MCP server (streamable HTTP, api-tokens)

app.notFound((c) => c.json({ error: 'Not found' }, 404))
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: isProd ? 'Internal error' : String(err) }, 500)
})
