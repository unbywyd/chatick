const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

/**
 * Локальная ручка одобрения доступа ассистенту.
 *
 * Зачем: без неё каждая сессия Claude начинается с того, что человек читает
 * код из чата и вводит его в браузере. У кого приложение открыто, у того
 * сессия и права уже есть — просить код значит заставлять подтверждать то,
 * что и так известно.
 *
 * Токен отсюда НЕ выдаётся. Ассистент получает код у сервера сам, а
 * приложение лишь одобряет его от лица вошедшего человека — тем же вызовом,
 * что и кнопка «одобрить» на экране подключения. Второго пути выдачи токена
 * не появляется, и защищать отдельно нечего.
 *
 * Ничего не ломает, если его нет: MCP при отказе молча уходит на device flow.
 * Поэтому все ошибки здесь — это «нет», а не исключение наружу.
 *
 * Что здесь НЕ является защитой: секрет в файле. На Windows права 0600 не
 * применяются — проверено, файл остаётся 666, и прочитать его может любой
 * процесс пользователя. Секрет отсекает случайный стук, но не злонамеренный.
 *
 * Настоящая преграда — человек: каждая просьба поднимает окно, где он видит,
 * КТО просит и на что, и жмёт кнопку. Без его нажатия отсюда не выходит
 * ничего, а токен не выходит вовсе — ассистент забирает его у сервера сам.
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
    // Права — на системах, где они значат хоть что-то. На Windows chmod
    // молча не действует: проверил — файл остаётся 666. Поэтому секрет здесь
    // не единственная преграда (см. подтверждение человеком ниже), а всего
    // лишь способ отсеять случайный стук в порт.
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
 * @param onRequest вызывается, когда ассистент просит одобрить код. Должен
 *   показать человеку окно и ответить через resolve(): true — одобрил,
 *   false — отказался.
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
      let code = ''
      try {
        const parsed = JSON.parse(raw || '{}')
        if (typeof parsed.client === 'string') client = parsed.client.slice(0, 80)
        if (typeof parsed.code === 'string') code = parsed.code.slice(0, 40)
      } catch {
        // Тело не разобралось — не повод отказывать, имя останется общим.
      }
      // Без кода одобрять нечего: это не наш клиент.
      if (!code) return reply(400, { error: 'code is required' })

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
        onRequest({ id, client, code })
      } catch {
        clearTimeout(timer)
        pending.delete(id)
        return reply(500, { error: 'app is not ready' })
      }

      const approved = await done
      clearTimeout(timer)
      if (!approved) return reply(403, { error: 'declined' })
      reply(200, { approved: true })
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

/** Ответ человека: true — одобрил, false — отказался или закрыл окно. */
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
