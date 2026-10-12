import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Документы компании одним запросом (v2, экран «Документы и заметки»).

const src = readFileSync(join(import.meta.dirname, 'documents.ts'), 'utf8')
const part = src.slice(src.indexOf('export const documentsCompanyRoute'), src.indexOf('// --- Публичная страница'))

describe('документы компании одним запросом', () => {
  it('проверяет членство в компании и право чтения в каждом проекте', () => {
    // Ручка обходит requireProject — проверки повторены здесь: без них были бы
    // видны документы проектов, куда человека не звали.
    expect(part).toContain('requireSession')
    expect(part).toContain('companyRoleOf(companyId, sub)')
    expect(part).toContain("hasPermission(p.id, sub, 'documents.read')")
  })

  it('не отдаёт удалённые и не отдаёт полный текст', () => {
    expect(part).toContain('deletedAt} is null')
    expect(part).not.toMatch(/content: r\.d\.content/)
  })

  it('автор — только id, имя и аватар', () => {
    expect(part).toContain('author: r.author ? { id: r.author.id, name: r.author.name, avatarUrl: r.author.avatarUrl } : null')
  })
})
