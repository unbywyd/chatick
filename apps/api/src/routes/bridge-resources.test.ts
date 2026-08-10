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

  it('секреты пишет зашифрованными, а не как есть', () => {
    // Запрет на секреты через мост снят: ассистент с доступом к терминалу и
    // так может отправить что угодно, а heroku config:set никто не запрещает.
    // Но хранилище одно и правило одно — в базу только шифротекст.
    expect(body).toMatch(/resourceSecrets/)
    expect(body).toMatch(/valueEncrypted: encrypt\(/)
  })

  it('через мост секреты по умолчанию не видит никто, кроме автора', () => {
    // Умолчание обратное интерфейсу намеренно: человек видит форму с тегами
    // команды и снимает лишних глазами, ассистент отдаёт запрос вслепую.
    // Тихо раздать пароль всему проекту из-за забытого поля нельзя отменить.
    expect(body).toMatch(/Array\.isArray\(b\.viewers\)/)
    // Никакого «взять всех участников», если список не назвали.
    const beforeViewers = body.slice(0, body.indexOf('const viewers'))
    expect(beforeViewers).not.toMatch(/projectMembers/)
  })

  it('в зрители пускает только участников этого проекта', () => {
    // Чужой id не должен давать доступ к секрету.
    expect(body).toMatch(/eq\(projectMembers\.projectId, scope\.projectId\)/)
    expect(body).toMatch(/inArray\(projectMembers\.userId, viewers\)/)
  })

  it('автор в список зрителей не попадает', () => {
    // Он видит всегда по created_by_id; запись о нём можно было бы снять и
    // оставить секрет без единственного владельца.
    expect(body).toMatch(/x !== id\.userId/)
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

// Срок у задач через мост убран намеренно: дедлайн живёт на проекте, а не на
// каждой задаче. Важно, чтобы поле именно ОТВЕРГАЛОСЬ: молча проглоченный
// dueDate — худший исход, ассистент доложит о проставленной дате, которой нет.
describe('срока у задач через мост нет', () => {
  it('dueDate не в списке допустимых полей задачи', () => {
    const fields = src.slice(src.indexOf('const TASK_FIELDS = ['), src.indexOf('] as const', src.indexOf('const TASK_FIELDS = [')))
    expect(fields).not.toMatch(/'dueDate'/)
    // Проверка неизвестных полей — то, что превращает отсутствие в явный отказ.
    expect(src).toMatch(/unknownFields\(b, TASK_FIELDS\)/)
  })

  it('в задачу ничего не пишется и наружу не отдаётся', () => {
    expect(src).not.toMatch(/dueDate: dueDate/)
    expect(src).not.toMatch(/dueDate: t\.dueDate/)
    expect(src).not.toMatch(/patch\.dueDate/)
  })

  it('разбор «tomorrow» и прочих дат удалён вместе с полем', () => {
    // Оставшаяся функция выглядела бы действующей и однажды вернулась бы в дело.
    expect(src).not.toMatch(/function parseDue/)
  })

  it('гайд говорит об этом прямо, а не умалчивает', () => {
    expect(docs).toMatch(/Tasks have NO due date/)
    expect(docs).not.toMatch(/dueDate accepts/)
  })
})
