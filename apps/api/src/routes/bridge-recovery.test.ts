import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Отмена сделанного и тихие потери.
//
// Мост удалял задачи и файлы, отвечая «restorableForDays: 7», но вернуть их не
// мог — обещание было пустым, и ассистент, удаливший не то, отправлял человека
// чинить это руками. Через семь дней уборщик стирает запись насовсем, и чинить
// уже нечего. То же с документами: снимки версий мост создавал, но не показывал.
//
// Отдельно — тихая потеря файлов: несколько file= в одном multipart-запросе
// схлопывались в последний, и три файла из четырёх пропадали с ответом 201.

const src = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')
const filesSrc = readFileSync(join(import.meta.dirname, 'files.ts'), 'utf8')
const docs = readFileSync(join(import.meta.dirname, '../lib/bridge-docs.ts'), 'utf8')

function handler(method: string, path: string): string {
  const start = src.indexOf(`bridgeRoute.${method}('${path}'`)
  expect(start, `ручка ${method.toUpperCase()} ${path} не найдена`).toBeGreaterThan(-1)
  const rest = src.slice(start + 20)
  const end = rest.indexOf('bridgeRoute.')
  return rest.slice(0, end === -1 ? undefined : end)
}

describe('корзина', () => {
  const body = handler('get', '/trash')

  it('показывает только удалённое своего проекта', () => {
    expect(body).toMatch(/eq\(tasks\.projectId, scope\.projectId\)/)
    expect(body).toMatch(/eq\(files\.projectId, scope\.projectId\)/)
  })

  it('говорит, сколько дней осталось — через семь суток возвращать нечего', () => {
    expect(body).toMatch(/daysLeft/)
    expect(src).toMatch(/function daysLeft/)
  })
})

describe('восстановление задачи', () => {
  const body = handler('post', '/tasks/:id/restore')

  it('только своего проекта', () => {
    // Здесь проверка остаётся явной: restore ищет ВКЛЮЧАЯ удалённые и общим
    // taskByKey пользоваться не может — тот отдаёт только живые задачи.
    expect(body).toMatch(/eq\(tasks\.projectId, scope\.projectId\)/)
  })

  it('требует право удалять', () => {
    expect(body).toMatch(/require\(c as never, 'tasks\.delete'/)
  })

  it('не делает вид, что вернуло неудалённое', () => {
    expect(body).toMatch(/not in the trash/)
  })

  it('пишет в журнал проекта', () => {
    expect(body).toMatch(/action: 'restore'/)
  })
})

describe('восстановление файла', () => {
  const body = handler('post', '/files/:id/restore')

  it('только своего проекта', () => {
    expect(body).toMatch(/eq\(files\.projectId, scope\.projectId\)/)
  })

  it('свой файл возвращает и загрузивший, чужой — по праву', () => {
    expect(body).toMatch(/file\.uploadedById === id\.userId/)
    expect(body).toMatch(/require\(c as never, 'files\.delete'/)
  })
})

describe('версии документа', () => {
  it('список — только документа своего проекта', () => {
    expect(handler('get', '/documents/:id/versions')).toMatch(/eq\(documents\.projectId, scope\.projectId\)/)
  })

  it('откат требует права писать', () => {
    expect(handler('post', '/documents/:id/versions/:versionId/restore')).toMatch(
      /require\(c as never, 'documents\.write'/,
    )
  })

  it('откат сам обратим — текущее состояние тоже уходит в историю', () => {
    expect(handler('post', '/documents/:id/versions/:versionId/restore')).toMatch(/snapshot\(doc\.id/)
  })

  it('версию берём только у этого документа', () => {
    expect(handler('post', '/documents/:id/versions/:versionId/restore')).toMatch(
      /eq\(documentVersions\.documentId, doc\.id\)/,
    )
  })
})

describe('загрузка нескольких файлов', () => {
  const body = handler('post', '/files')

  it('берёт все части file=, а не последнюю', () => {
    expect(body).toMatch(/form\.getAll\('file'\)/)
  })

  it('один файл отвечает как раньше — вызывающие ждут объект, не список', () => {
    expect(body).toMatch(/parts\.length === 1/)
  })

  it('судьба каждого файла видна, отказ по одному не роняет остальные', () => {
    expect(body).toMatch(/uploaded:/)
    expect(body).toMatch(/failed/)
  })

  it('REST не теряет лишние файлы молча', () => {
    expect(filesSrc).toMatch(/parseBody\(\{ all: true \}\)/)
    expect(filesSrc).toMatch(/One file per request/)
  })
})

describe('пункт чек-листа можно убрать', () => {
  const body = handler('delete', '/tasks/:id/checklist/:itemId')

  it('только у задачи своего проекта', () => {
    // Область проекта проверяется либо здесь, либо в taskByKey — он ищет
    // строго внутри scope.projectId. Важна гарантия, а не написание.
    expect(body).toMatch(/eq\(tasks\.projectId, scope\.projectId\)|taskByKey\(scope\.projectId/)
  })

  it('и только у пункта этой задачи', () => {
    expect(body).toMatch(/eq\(taskChecklist\.taskId, task\.id\)/)
  })
})

describe('проверка публикации', () => {
  const body = handler('get', '/shares/:type/:id')

  it('чужой проект не выдаёт', () => {
    expect(body).toMatch(/row\.projectId !== scope\.projectId/)
  })

  it('требует членства в проекте', () => {
    expect(body).toMatch(/projectRoleOf\(scope\.projectId, id\.userId\)/)
  })
})

describe('гайд для ассистента', () => {
  it('описывает корзину и восстановление', () => {
    expect(docs).toMatch(/\/x\/trash/)
    expect(docs).toMatch(/restore/)
  })

  it('предупреждает про семь дней', () => {
    expect(docs).toMatch(/seven days/)
  })

  it('описывает загрузку нескольких файлов', () => {
    expect(docs).toMatch(/Several files in one call/)
  })

  it('описывает версии документа', () => {
    expect(docs).toMatch(/versions\/<versionId>\/restore/)
  })
})
