import { serve } from '@hono/node-server'
import type { Server } from 'node:http'
import { app } from './app.js'
import { env } from './env.js'
import { attachWs } from './ws.js'
import { attachYjs, flushYjsRooms } from './yjs.js'
import { startReminderScheduler } from './lib/reminders.js'

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  console.log(`🚀 chatick-next api on http://${info.address}:${info.port} (${env.NODE_ENV})`)
})

attachWs(server as Server)
attachYjs(server as Server)
startReminderScheduler()

// При рестарте (pm2 restart / деплой) успеваем сохранить незаписанные правки документов.
let shuttingDown = false
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return
    shuttingDown = true
    void flushYjsRooms()
      .catch((e) => console.error('[yjs] flush on shutdown failed:', e))
      .finally(() => process.exit(0))
  })
}
