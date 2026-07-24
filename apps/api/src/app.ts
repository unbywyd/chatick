import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { env, isProd } from './env.js'
import { health } from './routes/health.js'
import { auth } from './routes/auth.js'
import { companiesRoute } from './routes/companies.js'
import { projectsRoute } from './routes/projects.js'
import { filesRoute, filesPublicRoute } from './routes/files.js'
import { resourcesRoute } from './routes/resources.js'
import { tasksRoute } from './routes/tasks.js'
import { messagesRoute } from './routes/messages.js'

export const app = new Hono()

app.use('*', cors({ origin: env.CORS_ORIGIN === '*' ? '*' : env.CORS_ORIGIN.split(',') }))
if (!isProd) app.use('*', logger())

app.route('/health', health)
app.route('/api/v1/auth', auth)
app.route('/api/v1/companies', companiesRoute)
app.route('/api/v1/projects', projectsRoute)
app.route('/api/v1/files', filesRoute)
app.route('/files', filesPublicRoute) // публичная прокси-отдача по file-токену (iframe/img/Google)
app.route('/api/v1/resources', resourcesRoute)
app.route('/api/v1/tasks', tasksRoute)
app.route('/api/v1/messages', messagesRoute)

// Дальше:
// app.route('/api/v1/tasks', tasks)         — таск-менеджер
// app.route('/api/v1/files', files)         — файлы (R2)
// app.route('/api/v1/credentials', creds)   — кредишены (шифрование)
// app.route('/mcp', mcp)                    — MCP server (streamable HTTP, api-tokens)

app.notFound((c) => c.json({ error: 'Not found' }, 404))
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: isProd ? 'Internal error' : String(err) }, 500)
})
