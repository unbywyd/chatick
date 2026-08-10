import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Доступ к секретам ресурса.
//
// Раньше пароль от прода видел любой участник с правом resources.manage.
// Теперь у ресурса есть список зрителей — и вся ценность этого списка держится
// на одной проверке в /reveal. Забыть её значит оставить украшение: замки в
// интерфейсе рисуются, а значение по-прежнему отдаётся каждому.
//
// Ошибка тихая: на своих ресурсах всё работает (автор видит всегда), и
// заметит её только тот, кто откроет чужой секрет и промолчит.

const api = readFileSync(join(import.meta.dirname, 'resources.ts'), 'utf8')
const bridge = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')

/** Тело ручки от объявления до следующего маршрута. */
function handler(src: string, prefix: string, method: string, path: string): string {
  const re = new RegExp(`${prefix}\\.${method}\\(\\s*'${path.replace(/\//g, '\\/')}'`)
  const m = re.exec(src)
  expect(m, `ручка ${method.toUpperCase()} ${path} не найдена`).not.toBeNull()
  const rest = src.slice(m!.index + 20)
  const end = rest.search(new RegExp(`${prefix}\\.(get|post|patch|delete)\\(`))
  return rest.slice(0, end === -1 ? undefined : end)
}

describe('раскрытие секрета', () => {
  const body = handler(api, 'resourcesRoute', 'post', '/:id/secrets/:secretId/reveal')

  it('проверяет право видеть, а не только читать ресурсы', () => {
    // Без этой строки список зрителей — украшение.
    expect(body).toMatch(/canSeeSecrets\(r, sub\)/)
    expect(body).toMatch(/403/)
  })

  it('проверка стоит ДО расшифровки', () => {
    // Иначе значение уже достали, и остаётся надеяться, что его не вернут.
    const check = body.indexOf('canSeeSecrets')
    const decryptAt = body.indexOf('decrypt(')
    expect(check, 'нет проверки доступа').toBeGreaterThan(-1)
    expect(decryptAt, 'нет расшифровки').toBeGreaterThan(-1)
    expect(check).toBeLessThan(decryptAt)
  })
})

describe('кто считается зрителем', () => {
  it('автор видит свои секреты всегда', () => {
    // По created_by_id, а не записью в таблице: запись можно снять и оставить
    // секрет без единственного человека, способного его открыть.
    expect(api).toMatch(/if \(resource\.createdById === userId\) return true/)
  })

  it('право управлять ресурсами доступа к чужим секретам не даёт', () => {
    const fn = api.slice(api.indexOf('async function canSeeSecrets'), api.indexOf('async function viewerIds'))
    expect(fn).not.toMatch(/hasPermission/)
  })

  it('автор не попадает в список зрителей', () => {
    expect(api).toMatch(/\.filter\(\(u\) => u && u !== authorId\)/)
  })
})

describe('изменение списка зрителей', () => {
  const body = handler(api, 'resourcesRoute', 'patch', '/:id')

  it('менять может только автор, а не администратор проекта', () => {
    // Управлять ресурсами и раздавать чужой пароль — разные вещи.
    expect(body).toMatch(/r\.createdById !== sub/)
    expect(body).toMatch(/Only the person who created the resource/)
  })
})

describe('мост: умолчание доступа обратное интерфейсу', () => {
  const body = handler(bridge, 'bridgeRoute', 'post', '/resources')

  it('без явного списка доступ не выдаётся никому', () => {
    // Ассистент отдаёт запрос вслепую: тихо раздать пароль всему проекту
    // из-за забытого поля нельзя отменить.
    const beforeViewers = body.slice(0, body.indexOf('const viewers'))
    expect(beforeViewers).not.toMatch(/projectMembers/)
  })

  it('в зрители пускает только участников проекта', () => {
    expect(body).toMatch(/eq\(projectMembers\.projectId, scope\.projectId\)/)
  })

  it('значение секрета хранится зашифрованным', () => {
    expect(body).toMatch(/valueEncrypted: encrypt\(/)
    // Открытым текстом в базу не пишем ни при каком раскладе.
    expect(body).not.toMatch(/valueEncrypted: \(?x\.value/)
  })
})

describe('список ресурсов', () => {
  const body = handler(api, 'resourcesRoute', 'get', '/')

  it('говорит про каждый, открыт ли он мне', () => {
    // По этому признаку интерфейс рисует замок вместо ключа.
    expect(body).toMatch(/canSeeSecrets: r\.r\.createdById === sub \|\| shared\.has\(r\.r\.id\)/)
  })

  it('спрашивает доступ одним запросом, а не по строке на ресурс', () => {
    expect(body).toMatch(/inArray\(resourceViewers\.resourceId, ids\)/)
  })
})
