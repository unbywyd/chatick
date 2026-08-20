import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Ассистент открывает страницу сам.
//
// Раньше он заканчивал словами «вот задача TASK-5», и человек шёл искать её
// руками — хотя ассистент уже знает, где она. Два пути: в приложении он
// переключает рабочую зону, из MCP открывает браузер.

const memory = readFileSync(join(import.meta.dirname, '../lib/memory.ts'), 'utf8')
const ws = readFileSync(join(import.meta.dirname, '../ws.ts'), 'utf8')
const guide = readFileSync(join(import.meta.dirname, '../lib/dispatcher.ts'), 'utf8')
const socket = readFileSync(join(import.meta.dirname, '../../../app/src/hooks/useProjectSocket.ts'), 'utf8')
const panel = readFileSync(join(import.meta.dirname, '../../../app/src/components/chat/ChatPanel.tsx'), 'utf8')
const mcp = readFileSync(join(import.meta.dirname, '../../../mcp/src/index.ts'), 'utf8')

/** Тело обработчика open_in_ui. */
function handler(): string {
  const at = memory.indexOf('open_in_ui: async (args)')
  expect(at, 'обработчик не найден').toBeGreaterThan(-1)
  return memory.slice(at, memory.indexOf('list_files: async', at))
}

describe('переключает экран только того, с кем говорит', () => {
  it('событие адресное', () => {
    // Чужой экран переключать нельзя ни при каких обстоятельствах — это не
    // подсказка, а вмешательство.
    expect(handler()).toMatch(/sendToUser\(projectId, actorUserId, 'open_in_ui'/)
  })

  it('путь собирает сервер, а не модель', () => {
    // Иначе она предложила бы строку, и интерфейс перешёл бы куда угодно.
    const h = handler()
    expect(h).toMatch(/const allowed = \[/)
    expect(h).toMatch(/Unknown target/)
  })

  it('номер задачи переводится в id', () => {
    // Человек и модель говорят номерами (TASK-5), интерфейс адресует по id.
    expect(handler()).toMatch(/tasks\.number/)
  })

  it('чужую задачу не откроет', () => {
    // Проверка по проекту: номер из другого проекта не должен уводить туда.
    expect(handler()).toMatch(/eq\(tasks\.projectId, projectId\)/)
  })
})

describe('не врёт о доставке', () => {
  it('sendToUser сообщает, дошло ли', () => {
    // Человек может говорить с ассистентом из трея или уйти с сайта.
    expect(ws).toMatch(/export function sendToUser\([^)]*\): boolean/)
    expect(ws).toMatch(/delivered = true/)
  })

  it('ответ честен, когда никто не смотрит', () => {
    // Иначе модель строит следующий шаг на несбывшемся.
    expect(handler()).toMatch(/Nobody is looking/)
  })
})

describe('интерфейс принимает команду', () => {
  it('сокет доставляет событие', () => {
    expect(socket).toMatch(/event === 'open_in_ui'/)
  })

  it('путь проверяется и на стороне интерфейса', () => {
    // Событие пришло по нашему сокету, но доверять содержимому на слово всё
    // равно нельзя: одна ошибка на сервере — и переход уводит из приложения.
    const at = panel.indexOf('onOpenInUi:')
    expect(at, 'обработчик в UI не найден').toBeGreaterThan(-1)
    const body = panel.slice(at, at + 500)
    expect(body).toMatch(/startsWith\('\/'\)/)
    expect(body).toMatch(/includes\('\.\.'\)/)
    expect(body).toMatch(/includes\(':\/\/'\)/)
  })
})

describe('MCP открывает браузер', () => {
  it('инструмент есть', () => {
    expect(mcp).toMatch(/'chatick_open'/)
  })

  it('только свои адреса', () => {
    // Инструмент запускает программу по строке, которую предложила модель:
    // без проверки достаточно подсунуть чужую ссылку в тексте задачи.
    const at = mcp.indexOf("'chatick_open'")
    const body = mcp.slice(at, at + 3000)
    expect(body).toMatch(/host !== 'chatick\.com'/)
    // endsWith, а не includes: chatick.com.evil.net прошёл бы.
    expect(body).toMatch(/endsWith\('\.chatick\.com'\)/)
  })

  it('только http(s)', () => {
    // file:// и javascript: открывать нельзя вовсе.
    const at = mcp.indexOf("'chatick_open'")
    expect(mcp.slice(at, at + 3000)).toMatch(/protocol !== 'https:'/)
  })

  it('адрес не уходит в оболочку', () => {
    // execFile передаёт его одним аргументом; exec со строкой позволил бы
    // дописать команду через кавычки.
    const at = mcp.indexOf("'chatick_open'")
    const body = mcp.slice(at, at + 3000)
    expect(body).toMatch(/execFile\(/)
    expect(body).not.toMatch(/\bexec\(`/)
  })
})

describe('ассистент знает про инструмент', () => {
  it('он описан в перечне', () => {
    // Инструмент, о котором не сказано, не будет вызван ни разу.
    expect(guide).toMatch(/open_in_ui/)
  })
})
