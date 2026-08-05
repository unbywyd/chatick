import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Ресурсы через мост.
//
// Долго были только на чтение: блок в интерфейсе есть, ручки нет, и ассистент
// складывал ссылки на макеты в заметки — то есть в другое место, где их потом
// никто не искал.
//
// Ограничение ровно одно и оно принципиальное: секреты. Значение, отправленное
// через мост, прошло бы через внешнюю модель и осталось в её истории. Поэтому
// мост их не отдаёт И не принимает, а отказывает явно, а не роняет молча.

const src = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')
const docs = readFileSync(join(import.meta.dirname, '../lib/bridge-docs.ts'), 'utf8')

function handler(method: string, path: string): string {
  const start = src.indexOf(`bridgeRoute.${method}('${path}'`)
  expect(start, `ручка ${method.toUpperCase()} ${path} не найдена`).toBeGreaterThan(-1)
  const rest = src.slice(start + 20)
  const end = rest.indexOf('bridgeRoute.')
  return rest.slice(0, end === -1 ? undefined : end)
}

describe('POST /x/resources', () => {
  const body = handler('post', '/resources')

  it('требует право управлять ресурсами, а не просто читать', () => {
    expect(body).toMatch(/require\(c as never, 'resources\.manage'/)
  })

  it('заводит ресурс в том проекте, куда открыт туннель', () => {
    expect(body).toMatch(/projectId: scope\.projectId/)
  })

  it('секреты отвергает явно — молчаливый пропуск хуже отказа', () => {
    expect(body).toMatch(/'secrets' in b/)
    expect(body).toMatch(/400/)
    // Значение не должно попасть в базу ни при каком раскладе.
    expect(body, 'секреты не пишем через мост').not.toMatch(/resourceSecrets/)
    expect(body, 'шифровать через мост нечего').not.toMatch(/encrypt\(/)
  })

  it('чужие поля не проглатывает', () => {
    expect(body).toMatch(/unknownFields\(b, RESOURCE_FIELDS\)/)
  })

  it('пустую карточку не создаёт', () => {
    expect(body).toMatch(/Provide a link or a name/)
  })

  it('без имени берёт его из ссылки', () => {
    expect(body).toMatch(/nameFromUrl\(link\)/)
  })

  it('пишет в аудит ресурсов — иначе не видно, кто завёл', () => {
    expect(body).toMatch(/credentialAccessLog/)
    expect(body).toMatch(/action: 'create'/)
  })
})

describe('PATCH /x/resources/:id', () => {
  const body = handler('patch', '/resources/:id')

  it('требует право управлять ресурсами', () => {
    expect(body).toMatch(/require\(c as never, 'resources\.manage'/)
  })

  it('правит только ресурс своего проекта и только живой', () => {
    expect(body).toMatch(/eq\(credentials\.projectId, scope\.projectId\)/)
    expect(body).toMatch(/isNull\(credentials\.deletedAt\)/)
  })

  it('секреты через правку тоже не проходят', () => {
    expect(body).toMatch(/'secrets' in b/)
    expect(body, 'секреты не пишем через мост').not.toMatch(/resourceSecrets/)
  })

  it('сменилась ссылка — старый значок сбрасывается', () => {
    expect(body).toMatch(/patch\.icon = null/)
  })

  it('пустое тело не выдаёт за успех', () => {
    expect(body).toMatch(/Nothing to change/)
  })

  it('пишет в аудит', () => {
    expect(body).toMatch(/action: 'update'/)
  })
})

describe('удаление ресурсов остаётся людям', () => {
  it('ручки нет: ресурс уносит с собой свои секреты', () => {
    expect(src).not.toMatch(/bridgeRoute\.delete\('\/resources/)
  })
})

describe('гайд для ассистента', () => {
  it('перечисляет запись, а не только чтение', () => {
    expect(docs).toMatch(/POST   \/x\/resources/)
    expect(docs).toMatch(/PATCH  \/x\/resources/)
  })

  it('говорит, что секреты не пишутся через мост', () => {
    expect(docs).toMatch(/cannot be written/)
  })

  it('объясняет, почему ссылка — это ресурс, а не заметка', () => {
    expect(docs).toMatch(/rather than in a note/)
  })
})
