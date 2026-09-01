import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Задачу нельзя завести без исполнителя.
 *
 * Такая задача не появляется НИ У КОГО в «Моих задачах»: она есть на доске, но
 * своей её не считает никто, и всплывает, только когда о ней случайно
 * вспомнят. На живых данных таких набралось девять, шесть до сих пор открыты.
 *
 * Проверка стоит в КОДЕ, а не в описании инструмента. Описание — просьба к
 * модели: раньше там было прямо написано «omit for unassigned», но даже без
 * этого модель вольна не прочитать. Отказ прочитать нельзя.
 *
 * Путей создания три, и правило должно стоять в каждом: забыв в одном, мы
 * оставим дыру ровно там, куда однажды заглянут.
 */

const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8')
const memory = readFileSync(join(import.meta.dirname, '../lib/memory.ts'), 'utf8')
const bridge = read('bridge.ts')
const docs = readFileSync(join(import.meta.dirname, '../lib/bridge-docs.ts'), 'utf8')
const mcp = readFileSync(join(import.meta.dirname, '../../../mcp/src/index.ts'), 'utf8')

describe('ассистент в чате', () => {
  it('одиночная задача без исполнителя отклоняется', () => {
    // Саботаж: убрать проверку — вернутся задачи-сироты.
    const at = memory.indexOf('create_task: async')
    const fn = memory.slice(at, memory.indexOf('create_tasks: async'))
    expect(fn, 'исполнитель не требуется').toMatch(/if \(!String\(args\.assignee \?\? ''\)\.trim\(\)\) \{/)
    expect(fn, 'отказ не объясняет, что делать').toMatch(/REFUSED: a task needs an assignee/)
  })

  it('пачка проверяется ЦЕЛИКОМ до создания', () => {
    // Иначе половина задач заведётся, половина отвалится — и человек получит
    // наполовину сделанную работу, которую надо разбирать руками.
    const at = memory.indexOf('create_tasks: async')
    const fn = memory.slice(at, at + 2000)
    expect(fn, 'пачка не проверяется на исполнителей').toMatch(
      /const noAssignee = items\.filter\(\(x\) => !String\(x\.assignee \?\? ''\)\.trim\(\)\)/,
    )
    // Проверка ДО цикла создания: иначе она бессмысленна.
    expect(fn.indexOf('noAssignee'), 'проверка стоит после создания').toBeLessThan(fn.indexOf('for (const item of items)'))
    expect(fn, 'частичное создание не предотвращено').toMatch(/Nothing was created/)
  })

  it('описание больше не разрешает пропуск', () => {
    // Было «omit for unassigned» — прямое разрешение не назначать.
    //
    // Смотрим на ОПИСАНИЕ инструмента, а не на весь файл: рядом стоит
    // комментарий, объясняющий, что там было раньше, и он тоже содержит эту
    // строку. Первая версия теста падала именно на нём.
    const at = memory.indexOf("name: 'create_task'")
    const def = memory.slice(at, memory.indexOf("name: 'update_task'"))
    expect(def, 'описание всё ещё разрешает не назначать').not.toMatch(/omit for unassigned/)
    expect(def, 'в описании не сказано, что исполнитель обязателен').toMatch(/ASSIGNEE IS REQUIRED/)
  })
})

describe('мост', () => {
  it('создание задачи требует исполнителя', () => {
    const at = bridge.indexOf("if (!title) return c.json({ error: 'title is required' }, 400)")
    expect(at, 'создание задачи в мосту не найдено').toBeGreaterThan(-1)
    const fn = bridge.slice(at, at + 1400)
    expect(fn, 'мост создаёт задачи без исполнителя').toMatch(
      /if \(b\.assignee === undefined \|\| !String\(b\.assignee \?\? ''\)\.trim\(\)\)/,
    )
    // Ответ говорит, ЧТО делать дальше — иначе модель повторит тот же вызов.
    expect(fn).toMatch(/GET \/x\/members lists the team/)
  })

  it('гайд не помечает исполнителя необязательным', () => {
    // Гайд читают перед первым вызовом: «assignee?» там означало «можно и без».
    const at = docs.indexOf('POST   /x/tasks${q}')
    const line = docs.slice(at, at + 700)
    expect(line, 'в гайде исполнитель всё ещё необязателен').not.toMatch(/"assignee\?"/)
    expect(line).toMatch(/assignee is REQUIRED/)
  })
})

describe('MCP', () => {
  it('у создания задачи исполнитель обязателен по схеме', () => {
    // Схема сильнее описания: необязательный параметр модель просто не пришлёт.
    const at = mcp.indexOf("'chatick_task_create'")
    const block = mcp.slice(at, at + 2200)
    expect(block, 'исполнитель объявлен необязательным').not.toMatch(/assignee: z\.string\(\)\.optional\(\)/)
    expect(block).toMatch(/assignee: z\.string\(\)/)
  })

  it('запрос сборки тоже заводит задачу — и тоже требует', () => {
    const at = mcp.indexOf("'chatick_release_request'")
    const block = mcp.slice(at, at + 2200)
    expect(block, 'запрос сборки создаёт задачу без исполнителя').toMatch(
      /assignee: z\.string\(\)\.describe\('REQUIRED/,
    )
  })
})
