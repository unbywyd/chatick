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

// Граница проходит между «кто в команде» и «кем он в ней работает».
//
// Состав ведёт внешняя система; роли и права — мы: про наших админов проекта и
// доступ к ресурсам она не знает и знать не может. Проверяем ОБЕ стороны:
// ошибка в любую одинаково плоха — либо уволенный остаётся с доступом, либо
// админ компании не может назначить руководителя проекта.
//
// Проверяем по исходникам, а не поведением: прятать кнопки бесполезно, к
// ручкам ходят и мост ИИ, и curl.
describe('граница запрета', () => {
  const read = (f: string) => readFileSync(new URL(`../routes/${f}`, import.meta.url), 'utf8')

  /**
   * Тело ручки — от её объявления до следующего.
   *
   * Путь пишется либо сразу за скобкой, либо со следующей строки (когда между
   * ними стоит zValidator). Проверяем оба варианта явно: отматывать назад от
   * найденного пути нельзя — ближайшим объявлением окажется соседняя ручка.
   */
  const endpoint = (src: string, routeVar: string, verb: string, path: string) => {
    // Регуляркой, а не парой точных строк: перенос бывает CRLF, и якорь
    // «\n  '» молча не находился — тест сообщал «ручки нет» вместо того, чтобы
    // проверить её содержимое.
    const re = new RegExp(
      `${routeVar}\\.${verb}\\(\\s*'${path.replace(/[/:]/g, (m) => `\\${m}`)}'`,
    )
    const m = re.exec(src)
    const head = m?.index
    if (head === undefined) return null
    const next = src.indexOf(`\n${routeVar}.`, head + 1)
    return src.slice(head, next < 0 ? undefined : next)
  }

  it('состав проекта закрыт: добавление и удаление', () => {
    const src = read('projects.ts')
    for (const [verb, path] of [
      ['post', '/:projectId/members'],
      ['delete', '/:projectId/members/:userId'],
    ] as const) {
      const ch = endpoint(src, 'projectsRoute', verb, path)
      expect(ch, `ручка ${verb} ${path} не найдена`).toBeTruthy()
      expect(ch, `ручка ${verb} ${path} без запрета`).toMatch(/MEMBERS_LOCKED/)
    }
  })

  it('роли, права и профиль НЕ закрыты — иначе некому назначить админа', () => {
    const src = read('projects.ts')
    for (const path of [
      '/:projectId/members/:userId/role',
      '/:projectId/members/:userId/permissions',
      '/:projectId/members/:userId/profile',
    ]) {
      const ch = endpoint(src, 'projectsRoute', 'patch', path)
      expect(ch, `ручка ${path} не найдена`).toBeTruthy()
      expect(ch, `ручка ${path} заперта, хотя это НАША настройка`).not.toMatch(/MEMBERS_LOCKED/)
    }
  })

  it('в компании: удаление и приглашения закрыты, смена роли открыта', () => {
    const src = read('companies.ts')
    expect(endpoint(src, 'companiesRoute', 'delete', '/:companyId/members/:userId')).toMatch(/MEMBERS_LOCKED/)

    // PATCH того же пути, что и DELETE, — это смена роли в компании.
    const role = endpoint(src, 'companiesRoute', 'patch', '/:companyId/members/:userId')
    expect(role, 'ручка смены роли не найдена').toBeTruthy()
    expect(role).not.toMatch(/MEMBERS_LOCKED/)
  })

  it('мост ИИ: добавление закрыто, смена роли открыта', () => {
    const src = read('bridge.ts')
    expect(endpoint(src, 'bridgeRoute', 'post', '/members')).toMatch(/MEMBERS_LOCKED/)
    expect(endpoint(src, 'bridgeRoute', 'patch', '/members/:userId')).not.toMatch(/MEMBERS_LOCKED/)
  })

  // Дыра, найденная этими же тестами: настройка «проекты только через API»
  // существовала, но мост её не проверял — ассистент создавал проекты в обход.
  it('мост не создаёт проекты в обход настройки', () => {
    const src = read('bridge.ts')
    expect(endpoint(src, 'bridgeRoute', 'post', '/projects')).toMatch(/projectsViaApiOnly/)
  })
})
