import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { env, isProd } from './env.js'
import { health } from './routes/health.js'
import { auth } from './routes/auth.js'
import { companiesRoute, companyLogoRoute } from './routes/companies.js'
import { projectsRoute, projectLogoRoute } from './routes/projects.js'
import { linkPreviewRoute } from './routes/link-preview.js'
import { dbConnectionsRoute } from './routes/db-connections.js'
import { filesRoute, filesPublicRoute } from './routes/files.js'
import { resourcesRoute } from './routes/resources.js'
import { tasksRoute } from './routes/tasks.js'
import { messagesRoute } from './routes/messages.js'
import { notificationsRoute } from './routes/notifications.js'
import { extRoute } from './routes/ext.js'
import { aiRoute } from './routes/ai.js'
import { activityRoute } from './routes/activity.js'
import { inboxRoute } from './routes/inbox.js'
import { reviewsRoute } from './routes/reviews.js'
import { documentsRoute, documentsPublicRoute } from './routes/documents.js'
import { notesRoute } from './routes/notes.js'
import { releasesRoute } from './routes/releases.js'
import { timeRoute, timeMineRoute, timeCompanyRoute } from './routes/time.js'
import { bridgeRoute } from './routes/bridge.js'
import { backupRoute } from './routes/backup.js'
import { sharesRoute, publicShareRoute } from './routes/shares.js'
import { aboutRoute } from './routes/about.js'

export const app = new Hono()

app.use('*', cors({ origin: env.CORS_ORIGIN === '*' ? '*' : env.CORS_ORIGIN.split(',') }))
if (!isProd) app.use('*', logger())

app.route('/health', health)
// Превью ссылок на проект для мессенджеров: путь БЕЗ решётки, чтобы сервер
// видел проект. Без сессии — превью скачивают серверы WhatsApp и Telegram.
app.route('/link', linkPreviewRoute)
// Внешний API для систем-заказчиков: только ключ компании, сессий тут нет.
app.route('/api/v1/ext', extRoute)
app.route('/api/v1/auth', auth)
// Логотип — до общей проверки: <img> не шлёт заголовок авторизации.
app.route('/api/v1/companies', companyLogoRoute)
app.route('/api/v1/companies', companiesRoute)
app.route('/api/v1/projects', projectLogoRoute)
app.route('/api/v1/projects', projectsRoute)
app.route('/api/v1/files', filesRoute)
app.route('/files', filesPublicRoute) // публичная прокси-отдача по file-токену (iframe/img/Google)
app.route('/api/v1/resources', resourcesRoute)
app.route('/api/v1/tasks', tasksRoute)
// Подключения к внешним БД. Фича за выключателем: выключено — ручки 404.
app.route('/api/v1/db-connections', dbConnectionsRoute)
app.route('/api/v1/messages', messagesRoute)
app.route('/api/v1/notifications', notificationsRoute)
app.route('/api/v1/ai', aiRoute)
app.route('/api/v1/activity', activityRoute)
app.route('/api/v1/inbox', inboxRoute)
// отзывы — публичные: их оставляют и читают без входа
app.route('/api/v1/reviews', reviewsRoute)
app.route('/api/v1/documents', documentsRoute)
app.route('/api/v1/notes', notesRoute)
app.route('/api/v1/releases', releasesRoute)
// Сводка по компании — по сессии: проектного токена на этом экране нет.
app.route('/api/v1/time', timeCompanyRoute)
app.route('/api/v1/time', timeRoute)
app.route('/api/v1/my/time', timeMineRoute) // свой таймер без привязки к проекту — для трея
app.route('/d', documentsPublicRoute) // публичный доступ к документу по слагу
app.route('/api/v1/shares', sharesRoute) // управление публичными ссылками — SPEC §8.34
app.route('/s', publicShareRoute) // чтение по публичной ссылке, без входа
app.route('/api/v1/about', aboutRoute) // «О проекте» и обратная связь — SPEC §8.35
app.route('/x', bridgeRoute) // мост для внешнего ИИ (Claude Code) — SPEC §8.27
app.route('/api/v1/backup', backupRoute) // экспорт/импорт компании — SPEC §8.28

// Дальше:
// app.route('/api/v1/tasks', tasks)         — таск-менеджер
// app.route('/api/v1/files', files)         — файлы (R2)
// app.route('/api/v1/credentials', creds)   — кредишены (шифрование)

app.notFound((c) => c.json({ error: 'Not found' }, 404))
app.onError((err, c) => {
  // HTTPException несёт собственный статус — например, 400 на сломанный JSON в
  // теле. Затирать его на 500 вдвойне неудобно: клиент думает, что упали мы, а
  // в логах копится шум от чужих кривых запросов, в котором тонут аварии.
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status)
  console.error(err)
  return c.json({ error: isProd ? 'Internal error' : String(err) }, 500)
})
