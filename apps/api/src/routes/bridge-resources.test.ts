import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Ресурсы через мост.
//
// Долго были только на чтение: блок в интерфейсе есть, ручки нет, и ассистент
// складывал ссылки на макеты в заметки — то есть в другое место, где их потом
// никто не искал.
//
// Секреты через мост писать МОЖНО: запрет держался на том, что значение
// пройдёт через контекст модели, — но ассистент с доступом к терминалу и так
// может отправить что угодно, а heroku config:set никто не запрещает.
//
// Осталось другое, и оно важнее: у секретов свой список зрителей, и через мост
// ресурс по умолчанию не открыт НИКОМУ, кроме автора. Ассистент отдаёт запрос
// вслепую — тихо раздать пароль всему проекту из-за забытого поля нельзя
// отменить.

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

  it('новые секреты добавляются, а не заменяют прежние', () => {
    // PATCH со списком легко отправить неполным. Тихо стереть чужой ключ —
    // не та цена за опечатку; удаление есть отдельной ручкой.
    expect(body).toMatch(/db\.insert\(resourceSecrets\)/)
    expect(body, 'PATCH не должен удалять секреты').not.toMatch(/db\.delete\(resourceSecrets\)/)
  })

  it('список зрителей меняет только автор', () => {
    // resources.manage мало: администратор ведает ресурсами, но раздавать
    // чужой пароль от имени владельца не должен.
    expect(body).toMatch(/existing\.createdById !== id\.userId/)
    expect(body).toMatch(/403/)
  })

  it('правка одних зрителей не падает на пустом обновлении', () => {
    // Пустой set() — ошибка драйвера: запрос «дай Талю доступ» не меняет
    // полей самого ресурса.
    expect(body).toMatch(/if \(Object\.keys\(patch\)\.length\)/)
    expect(body).toMatch(/b\.viewers === undefined && !newSecrets\.length/)
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
  it('ресурс целиком через мост не удаляется — он уносит с собой все секреты', () => {
    // Точный путь, а не любой /resources: удаление ОДНОГО секрета разрешено
    // (см. ниже) — иначе ассистент не может исправить собственную ошибку.
    expect(src).not.toMatch(/bridgeRoute\.delete\('\/resources\/:id'/)
  })

  it('один секрет убрать можно — это отмена своей же ошибки', () => {
    // PATCH секреты только добавляет; без этой ручки ассистент, ошибившийся
    // меткой, оставлял мусор, который приходилось чистить человеку.
    expect(src).toMatch(/bridgeRoute\.delete\('\/resources\/:id\/secrets\/:secretId'/)
    const body = handler('delete', '/resources/:id/secrets/:secretId')
    // Удаляется ровно названный секрет и только внутри своего ресурса.
    expect(body).toMatch(/eq\(resourceSecrets\.resourceId, existing\.id\)/)
    expect(body).toMatch(/credentialAccessLog/)
  })
})

describe('гайд для ассистента', () => {
  it('перечисляет запись, а не только чтение', () => {
    expect(docs).toMatch(/POST   \/x\/resources/)
    expect(docs).toMatch(/PATCH  \/x\/resources/)
  })

  it('предупреждает, что созданный ассистентом ресурс не открыт никому', () => {
    // Без этого ассистент решит, что «сохранил — значит доступно», и человек
    // упрётся в замок, не понимая почему.
    expect(docs).toMatch(/starts shared with NOBODY but its\s+author/)
    expect(docs).toMatch(/Only the author changes "viewers"/)
  })

  it('про уровень resources у зрителя сказано в ОБОИХ разделах гайда', () => {
    // Разделов два — проектный и компанейский, — и агент видит только свой.
    // Правило, попавшее в один, для половины подключений молча не существует;
    // на этих граблях я стоял дважды за сессию, поэтому считаем вхождения.
    const mentions = docs.match(/resources" level in|"resources" level|resources: none/g) ?? []
    expect(
      mentions.length,
      'правило описано только в одном разделе — второй о нём не узнает',
    ).toBeGreaterThanOrEqual(2)
  })

  it('запрещает искать секреты самому', () => {
    // Записывать — только явно данное для этого. Не выуживать из .env и
    // не «сохранить заодно» найденное в логах.
    expect(docs).toMatch(/Do not go looking for secrets/)
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
