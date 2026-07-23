import { serve } from '@hono/node-server'
import type { Server } from 'node:http'
import { app } from './app.js'
import { env } from './env.js'
import { attachWs } from './ws.js'

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  console.log(`🚀 chatick-next api on http://${info.address}:${info.port} (${env.NODE_ENV})`)
})

attachWs(server as Server)
