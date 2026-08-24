import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTaskRef } from '../lib/short-links.js'

/**
 * Открыть задачу по ссылке, какой бы она ни была.
 *
 * Человек кидает ассистенту то, что у него под рукой: адрес из строки
 * браузера, короткую ссылку из чата, «TASK-81» из разговора. Раньше ассистент
 * должен был разобрать это сам и позвать GET /x/tasks/<id> с проектом.
 *
 * С короткой ссылкой это было невозможно в принципе: в ней только код, и что
 * за ним стоит — знает лишь база. Свою же ссылку ассистент прочитать не мог,
 * хотя сам их и раздаёт.
 */

const bridge = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')
const mcp = readFileSync(join(import.meta.dirname, '../../../mcp/src/index.ts'), 'utf8')

describe('разбор ссылки', () => {
  it('короткая — по коду', () => {
    expect(parseTaskRef('https://chatick.com/t-cDfWe')).toEqual({ kind: 'short', code: 'cDfWe' })
    // И без домена: человек копирует по-разному.
    expect(parseTaskRef('t-cDfWe')).toEqual({ kind: 'short', code: 'cDfWe' })
  })

  it('длинная — проект и задача', () => {
    const r = parseTaskRef('https://app.chatick.com/#/c/UefX2Rs4S7rdbVtaD-Ymp/p/SFcT-rIqcFquFHAmjKo9A/tasks/BF-Ygr3SMOcNP86c3d6Rz')
    expect(r).toEqual({ kind: 'long', projectId: 'SFcT-rIqcFquFHAmjKo9A', taskId: 'BF-Ygr3SMOcNP86c3d6Rz' })
  })

  it('голый номер тоже', () => {
    expect(parseTaskRef('TASK-81')).toEqual({ kind: 'number', number: 'TASK-81' })
    // Регистр не должен решать: человек пишет как придётся.
    expect(parseTaskRef('task-81')).toEqual({ kind: 'number', number: 'TASK-81' })
  })

  it('мусор отвергается, а не угадывается', () => {
    // Молча вернуть «что-то похожее» хуже, чем сказать «не понял».
    for (const junk of ['', 'привет', 'https://example.com/', 'https://chatick.com/']) {
      expect(parseTaskRef(junk), junk).toBeNull()
    }
  })
})

describe('ручка моста', () => {
  const handler = bridge.slice(bridge.indexOf("bridgeRoute.get('/open'"), bridge.indexOf("bridgeRoute.get('/tasks/:id'"))

  it('проект берётся из ссылки, а не спрашивается', () => {
    // Он там уже есть — спрашивать второй раз значит просить человека сделать
    // работу за машину.
    expect(handler).toMatch(/projectId = link\.projectId/)
    expect(handler).toMatch(/projectId = ref\.projectId/)
  })

  it('короткая ссылка разрешается на сервере', () => {
    expect(handler).toMatch(/resolveShortCode\('task', ref\.code\)/)
  })

  it('членство проверяется ВСЕГДА', () => {
    /**
     * Ссылка сокращает путь, а не открывает двери. Без этой проверки чужая
     * короткая ссылка показала бы задачу из проекта, куда человека не звали.
     */
    expect(handler, 'ссылка стала пропуском в чужой проект').toMatch(
      /memberDomains\(projectId, id\.userId\)/,
    )
    expect(handler).toMatch(/require\(c as never, 'tasks\.read', projectId\)/)
  })

  it('в ответе назван проект', () => {
    // Ассистент пришёл по ссылке и мог не знать, где оказался, — а следующий
    // его вызов потребует projectId.
    expect(handler).toMatch(/^\s+projectId,$/m)
  })

  it('непонятная ссылка объясняет, что принимается', () => {
    expect(handler).toMatch(/Pass a task link/)
  })
})

describe('инструмент ассистента', () => {
  it('объявлен и не занимает чужое имя', () => {
    /**
     * chatick_open уже существует — он открывает страницу в браузере. Взяв то
     * же имя, новый инструмент перекрыл бы старый (поймано тестом open-in-ui).
     */
    expect(mcp).toMatch(/'chatick_task_by_link'/)
    const mine = mcp.indexOf("'chatick_task_by_link'")
    const browser = mcp.indexOf("'chatick_open'")
    expect(mine).toBeGreaterThan(-1)
    expect(browser).toBeGreaterThan(-1)
    expect(mine, 'инструменты слиплись в один').not.toBe(browser)
  })

  it('говорит ассистенту не разбирать ссылку самому', () => {
    // Иначе он продолжит выковыривать id из адреса и спотыкаться на коротких.
    const tool = mcp.slice(mcp.indexOf("'chatick_task_by_link'"), mcp.indexOf("'chatick_task',"))
    expect(tool).toMatch(/do NOT try to pull the project and id out of the URL yourself/)
  })
})
