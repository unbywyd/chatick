const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

/**
 * Локальная ручка выдачи доступа ассистенту.
 *
 * Зачем: без неё каждая сессия Claude начинается с ввода кода в браузере. У
 * кого приложение уже открыто, у того сессия и права — спрашивать код значит
 * заставлять человека доказывать то, что и так известно.
 *
 * Что здесь НЕ решается: подтверждение. Оно остаётся за веб-слоем, где живут
 * сессия и роли, — тем же путём, которым панель подтверждает код руками. Этот
 * сервер только принимает просьбу и передаёт её дальше.
 *
 * Ничего не ломает, если его нет: MCP при отказе молча уходит на device flow.
 * Поэтому все ошибки здесь — это «нет», а не исключение наружу.
 */

/**
 * Порт не жёсткий.
 *
 * 17325 может быть занят чем угодно — от чужого сервиса до второй копии
 * Chatick. Поэтому порт выбирается свободный, а его номер пишется в файл,
 * куда смотрит MCP. Жёсткий порт означал бы, что приложение либо не
 * запустится, либо молча перестанет отвечать на просьбы о доступе.
 */
const PREFERRED_PORT = 17325
const PORT_FILE = path.join(os.homedir(), '.chatick', 'desktop-port.json')

/** Кто сейчас ждёт ответа: id → resolve. */
const pending = new Map()

let server = null

function writePortFile(port, secret) {
  try {
    fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true })
    fs.writeFileSync(PORT_FILE, JSON.stringify({ port, secret, pid: process.pid }, null, 2))
    // Файл — это ключ к выдаче доступа: читать его должен только владелец.
    fs.chmodSync(PORT_FILE, 0o600)
  } catch {
    // Не записалось — MCP просто не найдёт приложение и пойдёт через код.
  }
}

function clearPortFile() {
  try {
    const saved = JSON.parse(fs.readFileSync(PORT_FILE, 'utf8'))
    // Чужой файл не трогаем: вторая копия приложения могла записать свой.
    if (saved.pid === process.pid) fs.unlinkSync(PORT_FILE)
  } catch {
    // Уже удалён или не наш.
  }
}

/**
 * @param onRequest вызывается, когда ассистент просит доступ. Должен показать
 *   человеку окно и вернуть токен либо null, если тот отказался.
 */
function start(onRequest) {
  if (server) return

  // Общий секрет в файле: сам по себе localhost не защита — любой процесс на
  // машине может постучаться на порт. Секрет знает только тот, кто смог
  // прочитать файл, то есть тот же пользователь.
  const secret = crypto.randomBytes(24).toString('hex')

  server = http.createServer((req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    // Только с этой машины: слушаем 127.0.0.1, но проверяем и адрес — на
    // случай проброшенного порта.
    const addr = req.socket.remoteAddress ?? ''
    if (!addr.includes('127.0.0.1') && addr !== '::1') return reply(403, { error: 'local only' })

    if (req.method !== 'POST' || req.url !== '/grant') return reply(404, { error: 'not found' })
    if (req.headers['x-chatick-secret'] !== secret) return reply(403, { error: 'bad secret' })

    let raw = ''
    req.on('data', (c) => {
      raw += c
      // Тело здесь крошечное; всё, что больше, — не наш клиент.
      if (raw.length > 4096) req.destroy()
    })
    req.on('end', async () => {
      let client = 'An assistant'
      try {
        const parsed = JSON.parse(raw || '{}')
        if (typeof parsed.client === 'string') client = parsed.client.slice(0, 80)
      } catch {
        // Тело не разобралось — не повод отказывать, имя просто останется общим.
      }

      const id = crypto.randomUUID()
      const done = new Promise((resolve) => pending.set(id, resolve))
      // Если человек не ответил — не держим соединение вечно.
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reply(408, { error: 'no answer' })
        }
      }, 120_000)

      try {
        onRequest({ id, client })
      } catch {
        clearTimeout(timer)
        pending.delete(id)
        return reply(500, { error: 'app is not ready' })
      }

      const result = await done
      clearTimeout(timer)
      if (!result) return reply(403, { error: 'declined' })
      reply(200, result)
    })
  })

  server.on('listening', () => writePortFile(server.address().port, secret))

  server.on('error', (e) => {
    // Порт занят — берём любой свободный. Занять его может что угодно: чужой
    // сервис, вторая копия Chatick, старый процесс. Настаивать на одном
    // номере значило бы молча остаться без выдачи доступа.
    if (e && e.code === 'EADDRINUSE' && server.__triedFallback !== true) {
      server.__triedFallback = true
      server.listen(0, '127.0.0.1')
      return
    }
    // Что-то другое: приложение работает как работало, ассистент пойдёт
    // обычным путём через код.
    server = null
  })

  server.listen(PREFERRED_PORT, '127.0.0.1')
}

/** Ответ человека: токен — согласие, null — отказ. */
function resolve(id, result) {
  const fn = pending.get(id)
  if (!fn) return
  pending.delete(id)
  fn(result)
}

function stop() {
  clearPortFile()
  try {
    server?.close()
  } catch {
    // Уже закрыт.
  }
  server = null
}

module.exports = { start, resolve, stop }
