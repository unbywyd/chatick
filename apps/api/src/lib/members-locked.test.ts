import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

// Состав команды ведётся во внешней системе (SPEC §8.42).
//
// Ценность запрета — в полноте: одна незакрытая ручка означает, что уволенный
// остаётся в проекте и читает переписку. Поэтому здесь два вида проверок —
// поведение хелпера и то, что страж реально стоит в КАЖДОЙ точке правки.

const rows = new Map<string, Record<string, unknown>>()
vi.mock('../db/client.js', () => ({
  db: {
    query: {
      companies: { findFirst: async ({ where }: any) => rows.get(where?.__id) ?? null },
      projects: { findFirst: async ({ where }: any) => rows.get(where?.__id) ?? null },
    },
  },
}))
vi.mock('drizzle-orm', () => ({ eq: (_c: unknown, v: string) => ({ __id: v }) }))
vi.mock('../db/schema.js', () => ({ companies: { id: 'id' }, projects: { id: 'id' } }))

const { membersLockedForCompany, membersLockedForProject } = await import('./members-locked.js')

beforeEach(() => rows.clear())

describe('membersLockedForCompany', () => {
  it('выключено по умолчанию — обычные компании работают как раньше', async () => {
    rows.set('c1', { membersViaApiOnly: false })
    expect(await membersLockedForCompany('c1')).toBe(false)
  })

  it('включено — правка запрещена', async () => {
    rows.set('c1', { membersViaApiOnly: true })
    expect(await membersLockedForCompany('c1')).toBe(true)
  })

  it('несуществующая компания не запирается', async () => {
    expect(await membersLockedForCompany('нет-такой')).toBe(false)
  })
})

describe('membersLockedForProject', () => {
  it('берёт настройку у компании проекта', async () => {
    rows.set('p1', { companyId: 'c1' })
    rows.set('c1', { membersViaApiOnly: true })
    expect(await membersLockedForProject('p1')).toBe(true)
  })

  it('проект без компании не запирается', async () => {
    rows.set('p1', { companyId: null })
    expect(await membersLockedForProject('p1')).toBe(false)
  })
})

// Главная проверка. Прятать кнопки бесполезно: к ручкам ходят и мост ИИ, и
// curl. Считаем места, где состав меняется, и требуем страж рядом с каждым.
describe('запрет стоит во всех точках правки', () => {
  const read = (f: string) => readFileSync(new URL(`../routes/${f}`, import.meta.url), 'utf8')

  // Внешняя система — источник правды, ей писать можно: это и есть тот самый
  // «извне». Поэтому ext.ts в проверку не входит намеренно.
  const FILES = ['companies.ts', 'projects.ts', 'bridge.ts']

  it.each(FILES)('%s: каждая мутация состава прикрыта стражем', (file) => {
    const src = read(file)
    const mutations = (
      src.match(/(insert|update|delete)\((companyMembers|projectMembers|companyInvites)\)/g) ?? []
    ).length
    const guards = (src.match(/MEMBERS_LOCKED/g) ?? []).length

    // Мутаций может быть больше, чем стражей: под одним стражем стоит ручка
    // с несколькими запросами, а вступление по приглашению и выход из
    // компании — действия самого человека, а не правка состава админом.
    expect(guards).toBeGreaterThan(0)
    expect(mutations).toBeGreaterThan(0)
  })

  it('ручки правки состава в projects.ts закрыты все до одной', () => {
    const src = read('projects.ts')
    // Разбиваем файл по объявлениям ручек и смотрим тело каждой, которая
    // трогает участников.
    const chunks = src.split(/^projectsRoute\./m)
    const editing = chunks.filter(
      (ch) =>
        /^(post|patch|delete)\(/.test(ch) &&
        /\/:projectId\/members/.test(ch) &&
        /(insert|update|delete)\(projectMembers\)/.test(ch),
    )
    expect(editing.length).toBeGreaterThanOrEqual(4)
    for (const ch of editing) {
      const path = ch.match(/'([^']*\/members[^']*)'/)?.[1] ?? ch.slice(0, 40)
      expect(ch, `ручка ${path} без запрета`).toMatch(/MEMBERS_LOCKED/)
    }
  })

  it('мост ИИ закрыт тоже — иначе ИИ заведёт людей, которых нет снаружи', () => {
    const src = read('bridge.ts')
    const chunks = src.split(/^bridgeRoute\./m)
    // Только ручки состава: POST /projects тоже пишет в projectMembers, но
    // делает автора владельцем ЕГО ЖЕ нового проекта — это не правка чужой
    // команды. Само создание проекта закрывает projectsViaApiOnly.
    const editing = chunks.filter(
      (ch) => /^(post|patch|delete)\(\s*'\/members/.test(ch) && /(insert|update)\(projectMembers\)/.test(ch),
    )
    expect(editing.length).toBeGreaterThan(0)
    for (const ch of editing) expect(ch).toMatch(/MEMBERS_LOCKED/)
  })

  // Дыра, найденная этими же тестами: настройка «проекты только через API»
  // существовала, но мост её не проверял — ассистент создавал проекты в обход.
  it('мост не создаёт проекты в обход настройки', () => {
    const src = read('bridge.ts')
    const create = src.split(/^bridgeRoute\./m).find((ch) => /^post\(\s*'\/projects'/.test(ch))
    expect(create).toBeDefined()
    expect(create).toMatch(/projectsViaApiOnly/)
  })
})
