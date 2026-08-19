import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Связанные задачи: «эта выросла из той», «эти про одно и то же».
//
// Главная опасность здесь не кольцо (связь ничего не держит, замкнутая
// цепочка «похоже на» никому не мешает), а СМЕШЕНИЕ С БЛОКЕРАМИ. Стоит
// связям попасть в расчёт блокировок — и замочек начнёт врать: задача,
// которую просто пометили похожей, погасит чужую работу. Ровно ради этого
// таблицы и разведены, и ровно это здесь проверяется саботажем.

const src = readFileSync(join(import.meta.dirname, 'tasks.ts'), 'utf8')
const bridge = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')
const schema = readFileSync(join(import.meta.dirname, '..', 'db', 'schema.ts'), 'utf8')

function handler(src: string, prefix: string, method: string, path: string): string {
  const re = new RegExp(`${prefix}\\.${method}\\(\\s*'${path.replace(/[/:]/g, (m) => `\\${m}`)}'`)
  const m = re.exec(src)
  expect(m, `ручка ${method.toUpperCase()} ${path} не найдена`).not.toBeNull()
  const rest = src.slice(m!.index + prefix.length + 8)
  const end = rest.indexOf(`${prefix}.`)
  return rest.slice(0, end === -1 ? undefined : end)
}

describe('связи не притворяются блокерами', () => {
  it('таблица отдельная, а не kind внутри блокеров', () => {
    expect(schema).toMatch(/export const taskLinks = pgTable\(\s*'task_links'/)
    // Саботаж: если однажды kind переедет в task_blockers, этот тест обязан
    // упасть — иначе «похожая задача» начнёт гасить работу замочком.
    const blockers = schema.slice(schema.indexOf("'task_blockers'"), schema.indexOf("'task_links'"))
    expect(blockers).not.toMatch(/kind:/)
  })

  it('расчёт блокировок не заглядывает в связи', () => {
    // Именно этот саботаж и охраняем: обе функции обхода обязаны ходить
    // только по task_blockers.
    for (const fn of ['dependentsOf', 'blockersOf']) {
      const at = src.indexOf(`async function ${fn}`)
      expect(at, `${fn} не найдена`).toBeGreaterThan(-1)
      const body = src.slice(at, at + 900)
      expect(body, `${fn} читает taskLinks — связь станет блокировкой`).not.toMatch(/taskLinks/)
    }
  })

  it('в мосте openBlockers считается без связей', () => {
    const at = bridge.indexOf("bridgeRoute.get('/tasks/:id/blockers'")
    expect(at).toBeGreaterThan(-1)
    const body = bridge.slice(at, at + 1800)
    expect(body).toMatch(/openBlockers/)
    expect(body, 'ручка блокеров читает taskLinks').not.toMatch(/taskLinks/)
  })

  it('связи и блокеры живут в разных ручках', () => {
    // Одна ручка на оба вида связей означала бы флаг, а забытый флаг — это
    // и есть тот самый врущий замочек.
    expect(src).toMatch(/tasksRoute\.get\(\s*'\/:taskId\/links'/)
    expect(src).toMatch(/tasksRoute\.get\(\s*'\/:taskId\/blockers'/)
  })
})

describe('связь остаётся внутри проекта', () => {
  const body = handler(src, 'tasksRoute', 'post', '/:taskId/links')

  it('чужие задачи отвергаются до вставки', () => {
    const check = body.indexOf('are not in this project')
    const insert = body.search(/\.insert\(taskLinks\)/)
    expect(check).toBeGreaterThan(-1)
    expect(insert).toBeGreaterThan(check)
  })

  it('кандидаты ограничены проектом', () => {
    const cand = handler(src, 'tasksRoute', 'get', '/:taskId/links/candidates')
    expect(cand).toMatch(/eq\(tasks\.projectId, projectId\)/)
  })
})

describe('дубли и самосвязь', () => {
  const body = handler(src, 'tasksRoute', 'post', '/:taskId/links')

  it('задача не связывается сама с собой', () => {
    expect(body).toMatch(/cannot link to itself/)
  })

  it('связь в обратную сторону считается той же связью', () => {
    // Уникальный индекс ловит только одинаковый порядок пары: (A,B) и (B,A)
    // для него разные строки, а для человека — один и тот же пункт дважды.
    expect(body).toMatch(/or\(eq\(taskLinks\.fromTaskId/)
    expect(body).toMatch(/linkedAlready|already/)
  })

  it('повторная вставка не падает', () => {
    expect(body).toMatch(/onConflictDoNothing/)
  })

  it('уникальный индекс на пару есть в схеме', () => {
    const t = schema.slice(schema.indexOf("'task_links'"))
    expect(t).toMatch(/uniqueIndex\('task_links_pair_idx'\)\.on\(t\.fromTaskId, t\.toTaskId\)/)
  })
})

describe('права и удалённые', () => {
  it('читать — tasks.read, ставить и снимать — tasks.edit', () => {
    expect(handler(src, 'tasksRoute', 'get', '/:taskId/links')).toMatch(/'tasks\.read'/)
    expect(handler(src, 'tasksRoute', 'post', '/:taskId/links')).toMatch(/'tasks\.edit'/)
    expect(handler(src, 'tasksRoute', 'delete', '/:taskId/links/:linkId')).toMatch(/'tasks\.edit'/)
  })

  it('мягкоудалённые задачи в списке не показываются', () => {
    const body = handler(src, 'tasksRoute', 'get', '/:taskId/links')
    // Оба направления фильтруются: иначе с одной стороны удалённая задача
    // осталась бы висеть номером, который не открывается.
    expect(body.match(/isNull\(tasks\.deletedAt\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('удаление связи ограничено проектом', () => {
    const body = handler(src, 'tasksRoute', 'delete', '/:taskId/links/:linkId')
    expect(body).toMatch(/eq\(taskLinks\.projectId, projectId\)/)
  })
})

describe('два вида связи различимы', () => {
  it('derived читается с двух сторон по-разному', () => {
    const body = handler(src, 'tasksRoute', 'get', '/:taskId/links')
    expect(body).toMatch(/derivedFrom/)
    expect(body).toMatch(/derivedInto/)
  })

  it('related симметрична — обе стороны в одном списке', () => {
    const body = handler(src, 'tasksRoute', 'get', '/:taskId/links')
    expect(body).toMatch(/related:\s*\[\.\.\.out, \.\.\.inc\]/)
  })

  it('вид ограничен двумя значениями', () => {
    const body = handler(src, 'tasksRoute', 'post', '/:taskId/links')
    expect(body).toMatch(/z\.enum\(\['derived', 'related'\]\)/)
  })
})

describe('ассистент связывает при создании', () => {
  it('поле links разрешено в create_task', () => {
    expect(bridge).toMatch(/'links',/)
    expect(bridge).toMatch(/async function linkTasks/)
  })

  it('принимает номера задач, а не только id', () => {
    const at = bridge.indexOf('async function linkTasks')
    const body = bridge.slice(at, at + 1800)
    expect(body).toMatch(/taskByKey/)
  })

  it('ненайденный номер не роняет создание задачи', () => {
    // Задача уже создана к этому моменту: падение из-за опечатки в номере
    // потеряло бы её целиком.
    const at = bridge.indexOf('async function linkTasks')
    const body = bridge.slice(at, at + 1800)
    expect(body).toMatch(/if \(!found \|\| found\.id === taskId \|\| seen\.has\(found\.id\)\) continue/)
  })

  it('ответ сообщает, что реально связалось', () => {
    expect(bridge).toMatch(/\.\.\.\(linked\.length \? \{ links: linked \} : \{\}\)/)
  })
})

describe('связи видны там, где читают задачу', () => {
  it('GET одной задачи отдаёт связи, а не молчит про них', () => {
    // Без этого ассистент, прочитавший задачу перед работой, не узнает, из
    // чего она выросла, — и переспросит либо не свяжет следующую.
    const at = bridge.indexOf("bridgeRoute.get('/tasks/:id'")
    expect(at).toBeGreaterThan(-1)
    const body = bridge.slice(at, at + 3000)
    expect(body).toMatch(/linksOfTask/)
    expect(bridge).toMatch(/async function linksOfTask/)
  })

  it('пустые связи не засоряют ответ', () => {
    // Три пустых массива в каждом ответе читаются как данные, которых нет.
    const at = bridge.indexOf('async function linksOfTask')
    const body = bridge.slice(at, at + 1800)
    expect(body).toMatch(/derivedFrom\.length \? \{ derivedFrom \}/)
    expect(body).toMatch(/related\.length \? \{ related \}/)
  })

  it('удалённые задачи не всплывают в связях', () => {
    const at = bridge.indexOf('async function linksOfTask')
    const body = bridge.slice(at, at + 1800)
    expect(body.match(/isNull\(tasks\.deletedAt\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })
})

describe('правка задачи умеет связи', () => {
  it('links принимается при PATCH', () => {
    const at = bridge.indexOf("bridgeRoute.patch('/tasks/:id',")
    expect(at).toBeGreaterThan(-1)
    // Ручка длинная: до применения связей от её начала около 3.5 тыс символов.
    const body = bridge.slice(at, at + 9000)
    expect(body).toMatch(/linkTasks\(b\.links/)
  })

  it('запрос ТОЛЬКО со связями не отвергается как пустой', () => {
    // Ровно та ловушка, на которой уже спотыкались ресурсы: поле разрешено,
    // а ручка считает тело пустым и отвечает «Nothing to update».
    const at = bridge.indexOf("bridgeRoute.patch('/tasks/:id',")
    const body = bridge.slice(at, at + 9000)
    // lastIndexOf, а не indexOf: строка «Nothing to update» встречается выше
    // в комментарии, объясняющем прошлую такую же ловушку с ресурсами.
    const at2 = body.lastIndexOf('Nothing to update')
    const guard = body.slice(at2 - 400, at2)
    expect(guard).toMatch(/b\.links === undefined/)
  })

  it('правка ДОБАВЛЯЕТ связи, а не заменяет их', () => {
    // В отличие от releaseIds: стереть историю происхождения коротким списком
    // было бы потерей, которую никто не заметит.
    const at = bridge.indexOf('async function linkTasks')
    const body = bridge.slice(at, at + 2000)
    expect(body, 'linkTasks удаляет прежние связи').not.toMatch(/\.delete\(taskLinks\)/)
  })
})

describe('инструменты ассистента знают про связи', () => {
  const mcp = readFileSync(join(import.meta.dirname, '..', '..', '..', 'mcp', 'src', 'index.ts'), 'utf8')

  it('создание задачи принимает links', () => {
    const at = mcp.indexOf("'chatick_task_create'")
    expect(at).toBeGreaterThan(-1)
    expect(mcp.slice(at, at + 3000)).toMatch(/links: z/)
  })

  it('правка задачи принимает links', () => {
    const at = mcp.indexOf("'chatick_task_update'")
    expect(at).toBeGreaterThan(-1)
    expect(mcp.slice(at, at + 3000)).toMatch(/links: z/)
  })

  it('описание предупреждает, что это не блокеры', () => {
    // Без этой оговорки связь однажды поставят через /blockers, и замочек
    // соврёт — а один совравший замочек обесценивает все остальные.
    expect(mcp).toMatch(/NOT blockers/)
  })

  it('сырой вызов упоминает ручки связей', () => {
    const at = mcp.indexOf("'chatick_request'")
    expect(at).toBeGreaterThan(-1)
    expect(mcp.slice(at, at + 2000)).toMatch(/task links/)
  })
})

describe('мост отдаёт и принимает связи', () => {
  it('три ручки на месте', () => {
    expect(bridge).toMatch(/bridgeRoute\.get\(\s*'\/tasks\/:id\/links'/)
    expect(bridge).toMatch(/bridgeRoute\.post\(\s*'\/tasks\/:id\/links'/)
    expect(bridge).toMatch(/bridgeRoute\.delete\(\s*'\/tasks\/:id\/links\/:linkId'/)
  })

  it('в мосте тоже нельзя связать задачу с собой', () => {
    const body = handler(bridge, 'bridgeRoute', 'post', '/tasks/:id/links')
    expect(body).toMatch(/cannot link to itself/)
  })

  it('гайд объясняет, что это НЕ блокеры', () => {
    const docs = readFileSync(join(import.meta.dirname, '..', 'lib', 'bridge-docs.ts'), 'utf8')
    expect(docs).toMatch(/Links are NOT blockers/)
    // Главный сценарий должен быть назван прямо, иначе связи ставить не будут.
    expect(docs).toMatch(/kind="derived"/)
  })
})
