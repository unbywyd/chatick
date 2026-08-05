import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Спринты через мост.
//
// Долго были только чтение и создание: опечатка в названии — и починить её
// мог только человек в приложении. Особенно с не-ASCII названиями, которые
// шелл на Windows бьёт молча.
//
// Удаление тут допустимо ровно потому, что задачи оно НЕ трогает: у них
// пропадает группа, и только. Это условие и проверяется — если однажды
// удаление начнёт задевать задачи, ручку надо закрывать.

const src = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')
const docs = readFileSync(join(import.meta.dirname, '../lib/bridge-docs.ts'), 'utf8')

function handler(method: string, path: string): string {
  const start = src.indexOf(`bridgeRoute.${method}('${path}'`)
  expect(start, `ручка ${method.toUpperCase()} ${path} не найдена`).toBeGreaterThan(-1)
  const rest = src.slice(start + 20)
  const end = rest.indexOf('bridgeRoute.')
  return rest.slice(0, end === -1 ? undefined : end)
}

describe('PATCH /x/sprints/:id', () => {
  const body = handler('patch', '/sprints/:id')

  it('требует право править задачи', () => {
    expect(body).toMatch(/require\(c as never, 'tasks\.edit'/)
  })

  it('правит только спринт своего проекта', () => {
    expect(body).toMatch(/eq\(taskGroups\.projectId, scope\.projectId\)/)
  })

  it('не даёт стереть название пустой строкой', () => {
    expect(body).toMatch(/name cannot be empty/)
  })

  it('проверяет цвет', () => {
    expect(body).toMatch(/#\[0-9a-fA-F\]\{6\}/)
  })
})

describe('DELETE /x/sprints/:id', () => {
  const body = handler('delete', '/sprints/:id')

  it('требует право править задачи', () => {
    expect(body).toMatch(/require\(c as never, 'tasks\.edit'/)
  })

  it('удаляет только спринт своего проекта', () => {
    expect(body).toMatch(/eq\(taskGroups\.projectId, scope\.projectId\)/)
  })

  it('НЕ удаляет задачи — трогает только сам спринт', () => {
    expect(body).toMatch(/db\.delete\(taskGroups\)/)
    expect(body, 'удаление спринта не должно задевать задачи').not.toMatch(/db\.delete\(tasks\)/)
  })

  it('непустой спринт не расформировывает молча', () => {
    expect(body).toMatch(/c\.req\.query\('force'\) !== '1'/)
    expect(body).toMatch(/taskCount: n/)
  })

  it('пишет в журнал проекта', () => {
    expect(body).toMatch(/logActivity/)
  })
})

describe('GET /x/sprints', () => {
  it('показывает, сколько задач внутри — иначе не видно, что расформирует удаление', () => {
    expect(handler('get', '/sprints')).toMatch(/taskCount:/)
  })
})

describe('гайд для ассистента', () => {
  it('описывает переименование и удаление', () => {
    expect(docs).toMatch(/PATCH  \/x\/sprints/)
    expect(docs).toMatch(/DELETE \/x\/sprints/)
  })

  it('говорит, что задачи при удалении не пропадают', () => {
    expect(docs).toMatch(/Deleting a sprint deletes NO tasks/)
  })

  it('предупреждает про кодировку тела запроса в обоих гайдах', () => {
    // Проектный и компанейский — агент видит только свой, и правило нужно в обоих.
    expect(docs.match(/NON-ASCII BODIES/g) ?? []).toHaveLength(2)
  })

  it('показывает рабочий способ — тело через stdin', () => {
    expect(docs.match(/--data-binary @-/g) ?? []).toHaveLength(2)
  })

  it('объясняет, что битую запись ничто не выдаёт', () => {
    expect(docs).toMatch(/request SUCCEEDS/)
  })
})
