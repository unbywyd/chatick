import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Должность на уровне КОМПАНИИ через мост.
 *
 * Ассистент умел менять должность внутри проекта и не умел — в компании.
 * Просьба «расставь роли всем: Таль — CEO, Ханан — QA» выполнялась по одному
 * проекту за раз или не выполнялась вовсе, хотя должность по природе общая:
 * человек бэкендер и здесь, и там. Это пришло живым репортом от ассистента.
 *
 * Роль в компании — другой вес, и её открытость проверяется отдельно: admin и
 * manager видят ВСЕ проекты компании, включая те, куда человека не звали.
 */

const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8')
const bridge = read('bridge.ts')
const docs = read('../lib/bridge-docs.ts')
const mcp = readFileSync(join(import.meta.dirname, '../../../mcp/src/index.ts'), 'utf8')

function endpoint(src: string, head: string): string {
  const at = src.indexOf(head)
  if (at < 0) return ''
  const next = src.indexOf('Route.', at + head.length)
  return src.slice(at, next < 0 ? undefined : next)
}

const patch = endpoint(bridge, "bridgeRoute.patch('/company/members/:userId'")

describe('ручка компании', () => {
  it('список людей компании есть', () => {
    expect(endpoint(bridge, "bridgeRoute.get('/company/members'"), 'ручка не найдена').toBeTruthy()
  })

  it('менять может ТОЛЬКО админ компании', () => {
    // Саботаж: ослабить до manager — и человек, которого не звали в проект,
    // раздаст себе роли, открывающие все проекты компании.
    expect(patch, 'ручка не найдена').toBeTruthy()
    expect(patch).toMatch(/companyRoleOf\(companyId, id\.userId\)\) !== 'admin'/)
  })

  it('последнего админа не понижаем', () => {
    // Иначе компания остаётся без хозяина и вернуть права некому.
    expect(patch).toMatch(/Cannot demote the only admin/)
  })

  it('роль проверяется по списку, а не берётся как есть', () => {
    expect(patch).toMatch(/\['admin', 'manager', 'member'\]\.includes\(body\.role\)/)
  })

  it('пустое тело отвергается, а не молча ничего не делает', () => {
    expect(patch).toMatch(/Nothing to change/)
  })
})

describe('ассистент предупреждён о весе роли', () => {
  it('инструмент называет опасность прямо', () => {
    const from = mcp.indexOf("'chatick_company_member_role'")
    expect(from, 'инструмента нет').toBeGreaterThan(-1)
    const tool = mcp.slice(from, from + 2200)
    // Не «нельзя», а «спроси человека»: это его решение, но принятое зряче.
    expect(tool).toMatch(/see EVERY project/)
    expect(tool).toMatch(/ask the human/)
  })

  it('инструмент чтения тоже есть — id брать неоткуда иначе', () => {
    expect(mcp).toMatch(/'chatick_company_members'/)
  })
})

describe('гайд объясняет, чем это отличается от проектной должности', () => {
  it('сказано про наследование проектами', () => {
    expect(docs).toMatch(/COMPANY-wide: every project inherits it/)
  })

  it('и про вес роли — тоже', () => {
    expect(docs).toMatch(/manager and admin see EVERY project/)
  })
})
