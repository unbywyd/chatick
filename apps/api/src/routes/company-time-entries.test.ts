import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Записи компании за период (веб v2, экран «Часы») и ручная запись по сессии.
//
// Обе ручки собирают или пишут чужие и свои часы без проектного токена — то,
// что раньше гарантировал токен, здесь обязаны гарантировать строки ниже:
//   1. участник получает только свои записи, даже если назвал чужой userId;
//   2. чужие записи — только менеджеру и админу ЭТОЙ компании;
//   3. ручная запись — только туда, где человек состоит, и не дольше суток.

const src = readFileSync(join(import.meta.dirname, 'time.ts'), 'utf8')

function handler(re: RegExp): string {
  const m = re.exec(src)
  expect(m, `ручка ${re} не найдена`).not.toBeNull()
  const rest = src.slice(m!.index + 20)
  const end = rest.search(/time(Mine|Company)?Route\.(get|post|patch|delete)\(/)
  return rest.slice(0, end === -1 ? undefined : end)
}

describe('записи компании: доступ', () => {
  const body = handler(/timeCompanyRoute\.get\(\s*'\/company\/:companyId\/entries'/)

  it('не член компании получает 403', () => {
    expect(body).toMatch(/if \(!role\) return c\.json\(\{ error: 'Forbidden' \}, 403\)/)
  })

  it('чужие записи видят только менеджер и админ компании', () => {
    expect(body).toMatch(/const lead = role === 'admin' \|\| role === 'manager'/)
    // Участнику фильтр по себе ставится всегда, userId из запроса — только руководству.
    expect(body).toMatch(/if \(!lead\) conds\.push\(eq\(timeEntries\.userId, sub\)\)\s*else if \(f\.userId\)/)
  })

  it('не выходит за пределы компании', () => {
    expect(body).toMatch(/eq\(timeEntries\.companyId, companyId\)/)
  })
})

describe('ручная запись по сессии', () => {
  const body = handler(/timeMineRoute\.post\(\s*'\/',/)

  it('проект — только где человек состоит, компания — только своя', () => {
    expect(body).toMatch(/if \(!\(await projectRoleOf\(b\.projectId, sub\)\)\)/)
    expect(body).toMatch(/if \(!\(await companyRoleOf\(b\.companyId, sub\)\)\)/)
  })

  it('конец позже начала и не дольше суток', () => {
    expect(body).toMatch(/ended\.getTime\(\) <= started\.getTime\(\)/)
    expect(body).toMatch(/> MAX_ENTRY_MS/)
  })

  it('пишет только от своего имени', () => {
    expect(body).toMatch(/userId: sub/)
  })
})
