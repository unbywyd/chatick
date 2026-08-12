import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Короткая ссылка в ответах ассистентам.
//
// Длинный адрес задачи — 90 символов с двумя nanoid'ами и решёткой. В переписке
// он переносится по строкам, а в карточке уведомления это одно слово шире
// карточки: она растягивалась на восемь строк и ломала всю ленту.
//
// Проверяется не «есть ли ссылка», а два условия, которые легко нарушить
// незаметно: одиночные ответы её отдают, а списки — нет. Второе важнее: там,
// где ссылок пятьдесят, каждая это ещё и вставка в базу.

const bridge = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')
const memory = readFileSync(join(import.meta.dirname, '../lib/memory.ts'), 'utf8')
const docs = readFileSync(join(import.meta.dirname, '../lib/bridge-docs.ts'), 'utf8')

function handler(src: string, method: string, path: string): string {
  const start = src.indexOf(`bridgeRoute.${method}('${path}'`)
  expect(start, `ручка ${method.toUpperCase()} ${path} не найдена`).toBeGreaterThan(-1)
  const rest = src.slice(start + 20)
  const end = rest.indexOf('bridgeRoute.')
  return rest.slice(0, end === -1 ? undefined : end)
}

describe('мост: короткая ссылка на задачу', () => {
  it('одиночные ответы про задачу её отдают', () => {
    for (const [method, path] of [
      ['get', '/tasks/:id'],
      ['post', '/tasks'],
      ['patch', '/tasks/:id'],
    ] as const) {
      expect(handler(bridge, method, path), `${method} ${path} без короткой ссылки`).toMatch(
        /shortUrlFor\('task'/,
      )
    }
  })

  it('список задач её НЕ запрашивает — иначе полсотни вставок в базу на один вызов', () => {
    expect(handler(bridge, 'get', '/tasks')).not.toMatch(/shortUrlFor/)
  })

  it('массовая правка тоже обходится без неё', () => {
    expect(handler(bridge, 'patch', '/tasks/bulk')).not.toMatch(/shortUrlFor/)
  })

  it('инструкция объясняет, какую из двух ссылок давать человеку', () => {
    expect(docs).toMatch(/shortUrl/)
    // Без объяснения «почему» агент выберет ту, что длиннее и «полнее».
    expect(docs).toMatch(/90 characters/)
  })
})

describe('внутренний ассистент: короткая ссылка', () => {
  function tool(name: string): string {
    const start = memory.indexOf(`    ${name}: async (args`)
    expect(start, `инструмент ${name} не найден`).toBeGreaterThan(-1)
    const rest = memory.slice(start + 10)
    const end = rest.search(/\n    \w+: async \(args/)
    return rest.slice(0, end === -1 ? undefined : end)
  }

  it('create_task и get_task отдают ссылку', () => {
    expect(tool('create_task')).toMatch(/shortUrlFor\('task'/)
    expect(tool('get_task')).toMatch(/shortUrlFor\('task'/)
  })

  it('create_tasks (до 50 штук) — без ссылок', () => {
    expect(tool('create_tasks')).not.toMatch(/shortUrlFor/)
  })

  it('list_tasks — без ссылок', () => {
    expect(tool('list_tasks')).not.toMatch(/shortUrlFor/)
  })
})
