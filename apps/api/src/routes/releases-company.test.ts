import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Версии на экране компании (v2) и то, что уходит наружу в ответе версии.

const company = readFileSync(join(import.meta.dirname, 'releases-company.ts'), 'utf8')
const releases = readFileSync(join(import.meta.dirname, 'releases.ts'), 'utf8')

describe('версии компании одним запросом', () => {
  it('проверяет те же права, что и проектная ручка', () => {
    // Ручка обходит requireProject, поэтому каждое условие повторено здесь:
    // забудь одно — и видны версии чужого проекта или выключенной функции.
    expect(company).toContain('companyRoleOf(')
    expect(company).toContain('canCreateProjects(role)')
    expect(company).toContain("eq(projectFeatures.feature, 'releases')")
    expect(company).toContain("'releases.read'")
  })

  it('не отдаёт секрет вебхука', () => {
    // Секрет — для тех, у кого releases.manage, через /integrations/expo.
    expect(company).not.toMatch(/secret/)
  })
})

describe('автор версии в ответе', () => {
  it('только id, имя и аватар — не вся строка users', () => {
    // В serialize приходит целая строка users (с хешем пароля и почтой),
    // и раньше она уходила в ответ как есть.
    expect(releases).not.toMatch(/owner: owner \?\? null/)
    expect(releases).toContain('owner: owner ? { id: owner.id, name: owner.name, avatarUrl: owner.avatarUrl } : null')
  })
})
