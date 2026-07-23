import { serve } from '@hono/node-server'
import { app } from './app.js'
import { env } from './env.js'

serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  console.log(`🚀 chatick-next api on http://${info.address}:${info.port} (${env.NODE_ENV})`)
})
