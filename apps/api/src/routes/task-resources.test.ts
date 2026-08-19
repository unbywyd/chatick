import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Ресурсы задачи: стенд, ключ, база.
//
// Опасность здесь одна и она необратимая: УТЕЧКА ЗНАЧЕНИЯ СЕКРЕТА. Задача
// должна ссылаться на доступ, а не носить его копию. Стоит паролю попасть в
// ответ — он осядет в контексте модели и в истории чата, переживёт разговор
// и отозвать его будет нечем. Ровно это здесь и проверяется саботажем.

const src = readFileSync(join(import.meta.dirname, 'tasks.ts'), 'utf8')
const bridge = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')
const memory = readFileSync(join(import.meta.dirname, '..', 'lib', 'memory.ts'), 'utf8')

function handler(text: string, prefix: string, method: string, path: string): string {
  const re = new RegExp(`${prefix}\\.${method}\\(\\s*'${path.replace(/[/:]/g, (m) => `\\${m}`)}'`)
  const m = re.exec(text)
  expect(m, `ручка ${method.toUpperCase()} ${path} не найдена`).not.toBeNull()
  const rest = text.slice(m!.index + prefix.length + 8)
  const end = rest.indexOf(`${prefix}.`)
  return rest.slice(0, end === -1 ? undefined : end)
}

describe('значения секретов не покидают ресурс', () => {
  it('веб отдаёт только id, имя и адрес', () => {
    for (const path of ['/:taskId/resources', '/:taskId/resources/candidates']) {
      const body = handler(src, 'tasksRoute', 'get', path)
      // Саботаж: стоит добавить сюда valueEncrypted или resourceSecrets —
      // пароли поедут в интерфейс и в ответы API.
      expect(body, `${path} выбирает значение секрета`).not.toMatch(/valueEncrypted|resourceSecrets/)
    }
  })

  it('мост отдаёт только id, имя и адрес', () => {
    const body = handler(bridge, 'bridgeRoute', 'get', '/tasks/:id/resources')
    expect(body).not.toMatch(/valueEncrypted|resourceSecrets/)
  })

  it('чат-ассистент не читает значения', () => {
    const at = memory.indexOf('list_task_resources: async')
    expect(at, 'инструмент list_task_resources не найден').toBeGreaterThan(-1)
    const body = memory.slice(at, at + 1400)
    // Именно здесь утечка была бы самой тихой: значение ушло бы в контекст
    // модели и в историю чата.
    expect(body).not.toMatch(/valueEncrypted|resourceSecrets/)
    expect(body).toMatch(/credentials\.name/)
  })
})

describe('привязка не выходит за проект', () => {
  it('веб проверяет проект до вставки', () => {
    const body = handler(src, 'tasksRoute', 'post', '/:taskId/resources')
    const check = body.indexOf('are not in this project')
    const insert = body.search(/\.insert\(taskResources\)/)
    expect(check).toBeGreaterThan(-1)
    expect(insert).toBeGreaterThan(check)
  })

  it('мост проверяет проект до вставки', () => {
    const body = handler(bridge, 'bridgeRoute', 'post', '/tasks/:id/resources')
    const check = body.indexOf('are not in this project')
    const insert = body.search(/\.insert\(taskResources\)/)
    expect(check).toBeGreaterThan(-1)
    expect(insert).toBeGreaterThan(check)
  })

  it('чат-ассистент проверяет проект', () => {
    const at = memory.indexOf('link_resource_to_task: async')
    expect(at).toBeGreaterThan(-1)
    const body = memory.slice(at, at + 1200)
    expect(body).toMatch(/eq\(credentials\.projectId, projectId\)/)
  })

  it('удалённые ресурсы не предлагаются и не привязываются', () => {
    expect(handler(src, 'tasksRoute', 'get', '/:taskId/resources/candidates')).toMatch(
      /isNull\(credentials\.deletedAt\)/,
    )
    expect(handler(src, 'tasksRoute', 'post', '/:taskId/resources')).toMatch(/isNull\(credentials\.deletedAt\)/)
  })
})

describe('отвязка убирает одно, а не всё', () => {
  it('веб удаляет ровно указанную пару', () => {
    const body = handler(src, 'tasksRoute', 'delete', '/:taskId/resources/:resourceId')
    expect(body).toMatch(/eq\(taskResources\.taskId, taskId\)/)
    expect(body).toMatch(/eq\(taskResources\.resourceId/)
  })

  it('мост удаляет ровно указанную пару', () => {
    const body = handler(bridge, 'bridgeRoute', 'delete', '/tasks/:id/resources/:resourceId')
    expect(body).toMatch(/eq\(taskResources\.taskId, task\.id\)/)
    expect(body).toMatch(/eq\(taskResources\.resourceId/)
  })

  it('POST добавляет, а не заменяет список', () => {
    // Замена — это то, чем опасен resourceIds в PATCH: приславший один id
    // молча стирает чужие привязки.
    for (const [text, prefix, path] of [
      [src, 'tasksRoute', '/:taskId/resources'],
      [bridge, 'bridgeRoute', '/tasks/:id/resources'],
    ] as const) {
      const body = handler(text, prefix, 'post', path)
      expect(body, `${path} стирает прежние привязки`).not.toMatch(/\.delete\(taskResources\)/)
    }
  })

  it('повторная привязка не падает', () => {
    expect(handler(src, 'tasksRoute', 'post', '/:taskId/resources')).toMatch(/onConflictDoNothing/)
    expect(handler(bridge, 'bridgeRoute', 'post', '/tasks/:id/resources')).toMatch(/onConflictDoNothing/)
  })

  it('разрушительность resourceIds названа в коде', () => {
    // Поле осталось для тех, кто действительно задаёт список целиком, но
    // следующий читатель должен узнать про замену до того, как ею воспользуется.
    const at = bridge.indexOf('async function linkResources')
    const before = bridge.slice(Math.max(0, at - 700), at)
    expect(before).toMatch(/ЗАМЕНЯЕТ/)
  })
})

describe('права', () => {
  it('видеть — tasks.read, менять — tasks.edit', () => {
    expect(handler(src, 'tasksRoute', 'get', '/:taskId/resources')).toMatch(/'tasks\.read'/)
    expect(handler(src, 'tasksRoute', 'post', '/:taskId/resources')).toMatch(/'tasks\.edit'/)
    expect(handler(src, 'tasksRoute', 'delete', '/:taskId/resources/:resourceId')).toMatch(/'tasks\.edit'/)
  })

  it('чат-ассистент проверяет права до записи', () => {
    for (const tool of ['link_resource_to_task', 'unlink_resource_from_task']) {
      const at = memory.indexOf(`${tool}: async`)
      expect(at, `${tool} не найден`).toBeGreaterThan(-1)
      const body = memory.slice(at, at + 500)
      expect(body).toMatch(/PERMISSION DENIED/)
      expect(body).toMatch(/'tasks\.edit'/)
    }
  })
})

describe('ассистент знает про привязку', () => {
  it('инструменты объявлены', () => {
    for (const tool of ['link_resource_to_task', 'unlink_resource_from_task', 'list_task_resources']) {
      expect(memory, `${tool} не объявлен`).toMatch(new RegExp(`name: '${tool}'`))
    }
  })

  it('описание отговаривает вставлять пароль в описание задачи', () => {
    // Без этой оговорки ассистент решит задачу самым коротким путём —
    // впишет доступ текстом, откуда его уже не убрать.
    const at = memory.indexOf("name: 'link_resource_to_task'")
    const body = memory.slice(at, at + 1200)
    expect(body).toMatch(/never paste|cannot be taken back/)
  })

  it('диспетчер перечисляет новые инструменты', () => {
    const dispatcher = readFileSync(join(import.meta.dirname, '..', 'lib', 'dispatcher.ts'), 'utf8')
    expect(dispatcher).toMatch(/link_resource_to_task/)
  })

  it('MCP умеет привязывать и отвязывать', () => {
    const mcp = readFileSync(join(import.meta.dirname, '..', '..', '..', 'mcp', 'src', 'index.ts'), 'utf8')
    for (const tool of ['chatick_task_resources', 'chatick_task_resource_link', 'chatick_task_resource_unlink']) {
      expect(mcp, tool + ' не зарегистрирован').toMatch(new RegExp("'" + tool + "'"))
    }
    // Та же оговорка, что и у чат-ассистента: иначе доступ впишут текстом.
    expect(mcp).toMatch(/cannot be taken back/)
    expect(mcp).toMatch(/Secret VALUES are never/)
  })

  it('гайд моста объясняет разницу с resourceIds', () => {
    const docs = readFileSync(join(import.meta.dirname, '..', 'lib', 'bridge-docs.ts'), 'utf8')
    expect(docs).toMatch(/tasks\/<id>\/resources/)
    expect(docs).toMatch(/REPLACES the whole list/)
    expect(docs).toMatch(/secret VALUES/)
  })
})
