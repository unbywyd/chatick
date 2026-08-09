import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// «Своя компания» — это та, которую человек завёл, а не та, где он админ.
//
// Разница неочевидна ровно до того момента, когда кого-то повышают в ЧУЖОЙ
// компании: он мгновенно теряет право завести собственную и возможность из
// чужой выйти — при том, что своей у него нет вовсе. Ошибку не видно на
// типичном пути (человек с одной своей компанией), она проявляется только у
// тех, кого позвали и повысили.
//
// Проверяем и сервер, и интерфейс: запрет стоял в двух местах, и починка
// одного оставила бы кнопку скрытой либо ручку закрытой.

const api = readFileSync(join(import.meta.dirname, 'companies.ts'), 'utf8')
const switcher = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/CompanySwitcher.tsx'),
  'utf8',
)

/** Тело ручки от объявления до следующего объявления маршрута. */
function handler(method: string, path: string): string {
  // Аргументы могут стоять и на той же строке, и с переноса — файл
  // отформатирован по-разному в разных местах, и якорь на пробелы ломался бы
  // от одного прогона prettier.
  const re = new RegExp(`companiesRoute\\.${method}\\(\\s*'${path.replace('/', '\\/')}'`)
  const m = re.exec(api)
  expect(m, `ручка ${method.toUpperCase()} ${path} не найдена`).not.toBeNull()
  const from = m!.index
  const rest = api.slice(from + 20)
  const end = rest.indexOf('companiesRoute.')
  return rest.slice(0, end === -1 ? undefined : end)
}

describe('создание своей компании', () => {
  const body = handler('post', '/')

  it('ограничение считается по создателю, а не по роли', () => {
    expect(body).toMatch(/eq\(companies\.createdById, sub\)/)
  })

  it('роль admin больше не закрывает создание', () => {
    // Ровно то условие, из-за которого админ в чужой компании не мог завести
    // свою. Если оно вернётся — тест упадёт.
    expect(body).not.toMatch(/eq\(companyMembers\.role, 'admin'\)/)
  })

  it('создатель записывается при создании', () => {
    // Без этого следующая проверка ничего не найдёт и человек заведёт вторую.
    expect(body).toMatch(/createdById: sub/)
  })

  it('вторую свою всё ещё не даёт', () => {
    expect(body).toMatch(/You already have a company/)
    expect(body).toMatch(/409/)
  })
})

describe('список компаний', () => {
  it('говорит, какая из них своя', () => {
    // Клиенту нужен готовый признак: от него зависят и кнопка создания, и
    // возможность выйти.
    expect(api).toMatch(/isOwner: m\.company\.createdById === sub/)
  })
})

describe('переключатель компаний', () => {
  it('своя определяется по isOwner, а не по роли', () => {
    expect(switcher).toMatch(/const hasOwn = companies\.some\(\(c\) => c\.isOwner\)/)
    expect(switcher).not.toMatch(/c\.myRole === 'admin'/)
  })

  it('выйти можно из чужой, даже будучи в ней админом', () => {
    expect(switcher).toMatch(/const canLeave = !current\.isOwner/)
    expect(switcher).not.toMatch(/current\.myRole !== 'admin'/)
  })
})
