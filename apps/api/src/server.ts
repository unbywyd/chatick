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

// Апгрейд на неизвестный путь никто не обработает — закрываем, чтобы сокет не висел.
// Слушатель добавлен последним, поэтому отрабатывает после хабов /ws и /yjs.
;(server as Server).on('upgrade', (req, socket) => {
  const { pathname } = new URL(req.url ?? '', 'http://localhost')
  if (pathname !== '/ws' && pathname !== '/yjs') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
  }
})

startReminderScheduler()

/**
 * Одна оплошность в фоновой задаче не должна останавливать сервер.
 *
 * Node по умолчанию убивает процесс на необработанном отклонении. База
 * живёт на другой машине, и обрыв связи с ней — обычное дело; любой
 * запрос, начатый без await (рассылка присутствия, отправка почты,
 * веб-хук), при отказе уносил с собой ВЕСЬ сервер. Со стороны это
 * выглядело так: приложение открыто и залогинено, но списки проектов
 * пусты и нет пользователя — отвечать стало некому. Помогал только
 * перезапуск.
 *
 * Сеть рвётся и восстанавливается сама; работающий сервер с одной
 * пропавшей рассылкой лучше мёртвого. Ошибку пишем в лог — молчать о ней
 * нельзя, иначе она станет невидимой.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})

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
