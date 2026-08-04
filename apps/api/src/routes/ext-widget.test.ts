import { describe, it, expect, vi, beforeEach } from 'vitest'

// Ручки для виджета во внешней системе (SPEC §8.43).
//
// Виджет рисуется на чужой странице задач и спрашивает: интегрирован ли этот
// проект и кто в нём. Проверяем три вещи, на которых он ломается молча:
// «не интегрирован» отвечает 200 (иначе код ответа приходится читать как
// данные), наружу уходят ЧУЖИЕ идентификаторы вместо наших, и ключ одной
// компании не видит проекты другой.

const state = {
  projects: [] as any[],
  projectMembers: [] as any[],
  companyMembers: [] as any[],
  users: [] as any[],
  scopes: ['read:all'] as string[],
  companyId: 'c1',
}

// Ключ проверяется настоящим guard'ом, поэтому подменяем только его источник.
vi.mock('../lib/company-key.js', () => ({
  checkKey: async (header: string | undefined, needed: string) => {
    if (!header?.startsWith('Bearer ck_live_')) return { ok: false, reason: 'unknown' }
    if (!state.scopes.includes(needed)) return { ok: false, reason: 'scope' }
    return { ok: true, keyId: 'k1', companyId: state.companyId, scopes: state.scopes }
  },
  // Модуль экспортирует больше, чем нужно этим тестам, но заглушка обязана
  // отдать всё, что импортирует ext.ts.
  logCall: () => {},
  issueKey: async () => ({ id: 'k1', key: 'ck_live_x', prefix: 'ck_live_x' }),
  listKeys: async () => [],
  revokeKey: async () => true,
}))

vi.mock('../env.js', () => ({
  env: { APP_URL: 'https://app.chatick.com', ENCRYPTION_KEY: 'a'.repeat(64) },
  isProd: false,
}))

// Минимальная подделка Drizzle: запоминаем условия и фильтруем массивы.
const cond = (kind: string, field: string, value: unknown) => ({ kind, field, value })
vi.mock('drizzle-orm', () => ({
  eq: (col: any, v: unknown) => cond('eq', String(col), v),
  and: (...cs: any[]) => cond('and', '', cs),
  desc: (c: any) => c,
  gte: () => cond('gte', '', null),
  lte: () => cond('lte', '', null),
  inArray: (col: any, vs: unknown[]) => cond('in', String(col), vs),
  isNull: () => cond('isNull', '', null),
  sql: Object.assign(() => ({}), { raw: () => ({}) }),
}))

vi.mock('../db/schema.js', () => ({
  projects: { id: 'projects.id', companyId: 'projects.companyId', externalId: 'projects.externalId' },
  projectMembers: schemaRef.projectMembers,
  companyMembers: schemaRef.companyMembers,
  users: { id: 'users.id', externalId: 'users.externalId' },
  companies: { id: 'companies.id' },
  tasks: {},
  timeEntries: {},
}))

// Те же объекты, что видит ext.ts: сравниваем по ссылке, а не по строке.
const schemaRef = {
  projectMembers: { projectId: 'pm.projectId', userId: 'pm.userId', role: 'pm.role' },
  companyMembers: { companyId: 'cm.companyId', userId: 'cm.userId', role: 'cm.role' },
}

const matches = (row: any, c: any): boolean => {
  if (!c) return true
  if (c.kind === 'and') return c.value.every((x: any) => matches(row, x))
  if (c.kind === 'eq') {
    const key = String(c.field).split('.').pop()!
    return row[key] === c.value
  }
  return true
}

vi.mock('../db/client.js', () => {
  // Подделка ровно под два запроса виджета: participants проекта и люди
  // компании. Таблицу узнаём по объекту, переданному в .from().
  const chain = () => {
    let table: unknown = null
    const api: any = {
      from: (t: unknown) => {
        table = t
        return api
      },
      innerJoin: () => api,
      where: (c: any) => {
        const isProjectMembers = table === schemaRef.projectMembers
        const src = isProjectMembers ? state.projectMembers : state.companyMembers
        const rows = src
          .filter((m) => matches(m, c))
          .map((m) => ({ m, user: state.users.find((u) => u.id === m.userId) }))
          .filter((r) => r.user)
        return Promise.resolve(
          rows.map((r) => ({
            user: r.user,
            role: r.m.role,
            externalId: r.user!.externalId,
            userId: r.user!.id,
          })),
        )
      },
    }
    return api
  }

  return {
    db: {
      query: {
        projects: { findFirst: async ({ where }: any) => state.projects.find((p) => matches(p, where)) ?? null },
        companies: { findFirst: async () => ({ id: state.companyId, name: 'Atlas' }) },
      },
      select: () => chain(),
    },
  }
})

const { extRoute } = await import('./ext.js')

const call = (path: string, key = 'Bearer ck_live_ok') =>
  extRoute.request(path, { headers: { Authorization: key } })

beforeEach(() => {
  state.scopes = ['read:all']
  state.companyId = 'c1'
  state.projects = [
    { id: 'p-internal', companyId: 'c1', externalId: '1178667', name: 'Dev tasks', slug: 'dev', externalName: null, about: '', color: '#fff', createdAt: new Date() },
  ]
  state.users = [
    { id: 'u1', externalId: 'atlas-448', email: 'tal@atlas.co.il', name: 'Tal', avatarUrl: null },
    { id: 'u2', externalId: 'atlas-71', email: 'dana@atlas.co.il', name: 'Dana', avatarUrl: null },
  ]
  state.projectMembers = [{ projectId: 'p-internal', userId: 'u1', role: 'member' }]
  state.companyMembers = [
    { companyId: 'c1', userId: 'u1', role: 'member' },
    { companyId: 'c1', userId: 'u2', role: 'member' },
  ]
})

describe('GET /projects/:externalId/status', () => {
  // Главное свойство: виджет читает тело, а не код ответа. 404 заставил бы
  // трактовать ошибку как данные — и любой сетевой сбой выглядел бы как
  // «не интегрирован».
  it('неизвестный проект — это 200 и integrated: false', async () => {
    const res = await call('/projects/нет-такого/status')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ integrated: false, externalId: 'нет-такого' })
  })

  it('интегрированный проект отдаёт состав и ссылку', async () => {
    const res = await call('/projects/1178667/status')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.integrated).toBe(true)
    expect(body.memberCount).toBe(1)
    // Идентификаторы ВНЕШНЕЙ системы: виджет сверяет со своим списком и не
    // должен ничего знать про наши id.
    expect(body.memberExternalIds).toEqual(['atlas-448'])
    expect(body.url).toBe('https://app.chatick.com/#/p/p-internal')
  })

  // Ключ компании А не должен видеть проекты компании Б — даже зная externalId,
  // который во внешней системе легко угадывается по номеру.
  it('чужая компания не видит проект', async () => {
    state.companyId = 'c2'
    const body = (await (await call('/projects/1178667/status')).json()) as any
    expect(body.integrated).toBe(false)
  })

  it('без ключа — 401', async () => {
    expect((await call('/projects/1178667/status', 'Bearer nonsense')).status).toBe(401)
  })

  it('ключ без read:all не проходит', async () => {
    state.scopes = ['users:write']
    expect((await call('/projects/1178667/status')).status).toBe(403)
  })
})

describe('GET /projects/:externalId/members', () => {
  it('делит людей на «в проекте» и «можно добавить»', async () => {
    const res = await call('/projects/1178667/members')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.members.map((m: any) => m.externalId)).toEqual(['atlas-448'])
    // available — те, кого в проекте ещё нет: иначе виджету пришлось бы
    // пересекать списки самому.
    expect(body.available.map((m: any) => m.externalId)).toEqual(['atlas-71'])
  })

  it('несуществующий проект — 404', async () => {
    expect((await call('/projects/нет-такого/members')).status).toBe(404)
  })
})
