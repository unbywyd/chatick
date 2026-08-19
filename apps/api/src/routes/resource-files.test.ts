import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Файлы под ресурсом: кейстор, сертификат, приватный ключ.
//
// Здесь три необратимые ошибки, и каждая проверяется саботажем:
//   1. файл всплыл в общих файлах проекта — ключ подписи увидят все;
//   2. содержимое ушло в ответ API или ассистенту — секрет осел в чужом
//      контексте и в истории, откуда его не отозвать;
//   3. в хранилище лёг исходник вместо шифротекста — доступ к бакету стал
//      доступом к ключу.

const src = readFileSync(join(import.meta.dirname, 'resources.ts'), 'utf8')
const files = readFileSync(join(import.meta.dirname, 'files.ts'), 'utf8')
const schema = readFileSync(join(import.meta.dirname, '..', 'db', 'schema.ts'), 'utf8')

function handler(text: string, method: string, path: string): string {
  const re = new RegExp(`resourcesRoute\\.${method}\\(\\s*'${path.replace(/[/:]/g, (m) => `\\${m}`)}'`)
  const m = re.exec(text)
  expect(m, `ручка ${method.toUpperCase()} ${path} не найдена`).not.toBeNull()
  const rest = text.slice(m!.index + 20)
  const end = rest.indexOf('resourcesRoute.')
  return rest.slice(0, end === -1 ? undefined : end)
}

describe('файл ресурса не попадает в общие файлы', () => {
  it('таблица отдельная, а не флаг в files', () => {
    expect(schema).toMatch(/export const resourceFiles = pgTable\(\s*'resource_files'/)
    // Саботаж: если однажды кто-то заведёт признак «это секретный файл»
    // внутри files, этот тест обязан упасть — именно забытый в выборке флаг
    // и вынес бы кейстор в общий менеджер.
    const filesTable = schema.slice(schema.indexOf("'files',"), schema.indexOf("'files',") + 1800)
    expect(filesTable).not.toMatch(/secret|resourceId|isSecret/i)
  })

  it('файловый менеджер не знает про resource_files', () => {
    // Ни одной выборки из resourceFiles в маршрутах файлов проекта.
    expect(files, 'files.ts читает resourceFiles — файл ресурса окажется в менеджере').not.toMatch(
      /resourceFiles/,
    )
  })

  it('у файла ресурса нет projectId — его нельзя выбрать «по проекту»', () => {
    const t = schema.slice(schema.indexOf("'resource_files'"), schema.indexOf("'resource_files'") + 900)
    expect(t).toMatch(/resourceId/)
    // Отсутствие projectId — не экономия, а защита: выборка «все файлы
    // проекта» физически не сможет зацепить эту таблицу.
    expect(t).not.toMatch(/projectId/)
  })
})

describe('содержимое не утекает', () => {
  it('список файлов отдаёт имя и размер, но не данные', () => {
    const body = handler(src, 'get', '/:id/files')
    expect(body).toMatch(/resourceFiles\.name/)
    expect(body).toMatch(/resourceFiles\.size/)
    // Ключ в хранилище — тоже лишнее: по нему можно пойти в бакет напрямую.
    expect(body).not.toMatch(/GetObjectCommand|decryptBytes/)
  })

  it('скачивание требует прав на секреты, а не просто на проект', () => {
    const body = handler(src, 'get', '/:id/files/:fileId')
    expect(body).toMatch(/canSeeSecrets/)
  })

  it('скачивание попадает в журнал доступа', () => {
    // Кто забрал ключ подписи — вопрос, который задают через полгода.
    const body = handler(src, 'get', '/:id/files/:fileId')
    expect(body).toMatch(/audit\(projectId, sub, 'reveal'/)
  })

  it('ответ не кешируется', () => {
    const body = handler(src, 'get', '/:id/files/:fileId')
    expect(body).toMatch(/'cache-control': 'no-store'/)
  })
})

describe('в хранилище лежит шифротекст', () => {
  it('загрузка шифрует до отправки', () => {
    const body = handler(src, 'post', '/:id/files')
    const enc = body.indexOf('encryptBytes')
    const put = body.indexOf('PutObjectCommand')
    expect(enc, 'encryptBytes не вызывается при загрузке').toBeGreaterThan(-1)
    // Саботаж: положить Body: plain вместо encryptBytes(plain) — тест упадёт.
    expect(body).toMatch(/Body: encryptBytes\(plain\)/)
    expect(put).toBeGreaterThan(-1)
  })

  it('скачивание расшифровывает', () => {
    const body = handler(src, 'get', '/:id/files/:fileId')
    expect(body).toMatch(/decryptBytes/)
  })

  it('presigned-ссылок на файл ресурса нет', () => {
    // Ссылка прямо в бакет отдала бы шифротекст — тупик, который выглядит
    // как рабочая ссылка. Расшифровать может только сервер.
    for (const path of ['/:id/files', '/:id/files/:fileId']) {
      expect(handler(src, 'get', path)).not.toMatch(/presignDownload|presignView|getSignedUrl/)
    }
  })

  it('тип объекта в хранилище обезличен', () => {
    const body = handler(src, 'post', '/:id/files')
    expect(body).toMatch(/ContentType: 'application\/octet-stream'/)
  })
})

describe('мост и ассистент', () => {
  const bridge = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')
  const mcp = readFileSync(join(import.meta.dirname, '..', '..', '..', 'mcp', 'src', 'index.ts'), 'utf8')

  it('мост отдаёт список без содержимого', () => {
    const at = bridge.indexOf("bridgeRoute.get('/resources/:id/files'")
    expect(at, 'ручка списка не найдена').toBeGreaterThan(-1)
    const body = bridge.slice(at, at + 1600)
    expect(body).toMatch(/resourceFiles\.name/)
    expect(body, 'список тянет содержимое из хранилища').not.toMatch(/GetObjectCommand|decryptBytes/)
  })

  it('скачивание через мост пишется в журнал доступа', () => {
    const at = bridge.indexOf("bridgeRoute.get('/resources/:id/files/:fileId'")
    expect(at).toBeGreaterThan(-1)
    const body = bridge.slice(at, at + 2600)
    expect(body).toMatch(/credentialAccessLog/)
    expect(body).toMatch(/action: 'reveal'/)
  })

  it('мост принимает файл под ресурс и шифрует его', () => {
    const at = bridge.indexOf("bridgeRoute.post('/resources/:id/files'")
    expect(at, 'ручка загрузки не найдена').toBeGreaterThan(-1)
    const body = bridge.slice(at, at + 2600)
    // Саботаж: Body: plain вместо encryptBytes(plain) — тест упадёт.
    expect(body).toMatch(/Body: encryptBytes\(plain\)/)
    // Загрузить файл под ресурс — по весу то же, что завести секрет.
    expect(body).toMatch(/'resources\.manage'/)
  })

  it('ассистент грузит файл одним инструментом, без токена и curl', () => {
    // Гайд показывал curl с <token>, но через MCP подставить его неоткуда —
    // ассистент видел инструкцию, которую не мог выполнить, и сдавался.
    expect(mcp).toMatch(/'chatick_upload'/)
    const at = mcp.indexOf("'chatick_upload'")
    const body = mcp.slice(at, at + 2600)
    expect(body).toMatch(/resourceId/)
    expect(body).toMatch(/readFile/)
  })

  it('токен не отдаётся модели', () => {
    // upload подставляет его внутри: отданный наружу токен осел бы в
    // контексте и в истории переписки, откуда не отзывается.
    const b = readFileSync(join(import.meta.dirname, '..', '..', '..', 'mcp', 'src', 'bridge.ts'), 'utf8')
    const at = b.indexOf('export async function upload')
    expect(at, 'upload не найден').toBeGreaterThan(-1)
    expect(b.slice(at, at + 1400)).toMatch(/authorization: \`Bearer \$\{scope\.token\}/)
    // Ни один инструмент не возвращает токен наружу.
    expect(mcp).not.toMatch(/return json\(\{ token/)
  })

  it('что ассистент может положить, то может и убрать', () => {
    // Асимметрия «создать можно, исправить нельзя» уже приводила к дублям
    // ресурсов: ошибочно приложенный кейстор удалял бы человек руками.
    expect(bridge).toMatch(/bridgeRoute\.delete\(\s*.\/resources\/:id\/files\/:fileId./)
    expect(mcp).toMatch(/.chatick_resource_file_remove./)
    const at = bridge.indexOf("bridgeRoute.delete('/resources/:id/files/:fileId'")
    const body = bridge.slice(at, at + 2200)
    // Объект уходит из хранилища вместе с записью.
    expect(body).toMatch(/DeleteObjectCommand/)
    expect(body).toMatch(/'resources\.manage'/)
  })

  it('гайд больше не велит просить человека', () => {
    const docs = readFileSync(join(import.meta.dirname, '..', 'lib', 'bridge-docs.ts'), 'utf8')
    expect(docs).toMatch(/POST   \/x\/resources\/<id>\/files/)
    expect(docs).toMatch(/Do not ask the human/)
  })

  it('MCP умеет править ресурс и видеть файлы', () => {
    // Без правки ассистент плодил дубли: заново вводил секреты, перепривязывал
    // задачу и просил человека удалить старое руками.
    expect(mcp).toMatch(/'chatick_resource_update'/)
    expect(mcp).toMatch(/'chatick_resource_files'/)
  })

  it('MCP разбирает ответ по типу, а не вслепую', () => {
    // GET /guide отдаёт markdown: слепой JSON.parse ронял вызов, и инструкция
    // была недостижима через инструмент, который велит её прочитать.
    const b = readFileSync(join(import.meta.dirname, '..', '..', '..', 'mcp', 'src', 'bridge.ts'), 'utf8')
    expect(b).toMatch(/looksJson/)
    expect(b).toMatch(/content-type/)
  })

  it('гайд объясняет, почему файл живёт в ресурсе', () => {
    const docs = readFileSync(join(import.meta.dirname, '..', 'lib', 'bridge-docs.ts'), 'utf8')
    expect(docs).toMatch(/resources\/<id>\/files/)
    expect(docs).toMatch(/cannot be reissued/)
    expect(docs).toMatch(/never listed among project files/)
  })
})

describe('удалённый ресурс не оставляет файлов в хранилище', () => {
  const cleanup = readFileSync(join(import.meta.dirname, '..', 'lib', 'file-cleanup.ts'), 'utf8')

  it('уборка корзины забирает ключи ДО удаления ресурсов', () => {
    // Каскад в базе уносит строки resource_files, но хранилище про каскады
    // не знает: объекты остались бы там навсегда.
    const keys = cleanup.indexOf('resourceFiles.key')
    const del = cleanup.indexOf('db.delete(credentials)')
    expect(keys, 'уборка не читает ключи файлов ресурса').toBeGreaterThan(-1)
    expect(del).toBeGreaterThan(keys)
  })

  it('объекты действительно удаляются из хранилища', () => {
    const at = cleanup.indexOf('resourceFiles.key')
    const body = cleanup.slice(at, at + 1200)
    expect(body).toMatch(/deleteObject/)
  })

  it('сбой одного объекта не роняет всю уборку', () => {
    // Иначе один недоступный ключ остановил бы очистку остальных.
    const at = cleanup.indexOf('resourceFiles.key')
    const body = cleanup.slice(at, at + 1200)
    expect(body).toMatch(/catch/)
  })
})

describe('права и границы', () => {
  it('все четыре ручки проверяют доступ к секретам', () => {
    expect(handler(src, 'get', '/:id/files')).toMatch(/canSeeSecrets/)
    expect(handler(src, 'post', '/:id/files')).toMatch(/canSeeSecrets/)
    expect(handler(src, 'get', '/:id/files/:fileId')).toMatch(/canSeeSecrets/)
    expect(handler(src, 'delete', '/:id/files/:fileId')).toMatch(/canSeeSecrets/)
  })

  it('ресурс берётся строго из своего проекта', () => {
    for (const [m, p] of [
      ['get', '/:id/files'],
      ['post', '/:id/files'],
      ['get', '/:id/files/:fileId'],
      ['delete', '/:id/files/:fileId'],
    ] as const) {
      expect(handler(src, m, p), `${m} ${p} не ограничена проектом`).toMatch(
        /eq\(credentials\.projectId, projectId\)/,
      )
    }
  })

  it('файл ищется только внутри своего ресурса', () => {
    // Иначе по чужому fileId можно было бы скачать файл другого ресурса.
    const body = handler(src, 'get', '/:id/files/:fileId')
    expect(body).toMatch(/eq\(resourceFiles\.resourceId, resource\.id\)/)
  })

  it('размер ограничен', () => {
    expect(src).toMatch(/MAX_RESOURCE_FILE/)
    expect(handler(src, 'post', '/:id/files')).toMatch(/too large/i)
  })

  it('удаление убирает и объект из хранилища', () => {
    // Иначе шифротекст висит вечно там, откуда его считали удалённым.
    const body = handler(src, 'delete', '/:id/files/:fileId')
    expect(body).toMatch(/DeleteObjectCommand/)
  })
})
