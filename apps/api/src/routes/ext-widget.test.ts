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

const deleted: string[] = []
vi.mock('../lib/delete-project.js', () => ({
  deleteProjectCompletely: async (id: string) => {
    deleted.push(id)
    return { deletedFiles: 3, notified: 2 }
  },
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
        // Ручка добавления проверяет, состоит ли человек в проекте, и по этому
        // решает: вставлять или менять роль.
        projectMembers: {
          findFirst: async () => state.projectMembers[0] ?? null,
        },
      },
      select: () => chain(),
      update: (table: unknown) => ({
        set: (patch: Record<string, unknown>) => ({
          where: async () => {
            // Роль участника или поля проекта — по таблице, в которую пишем.
            if (table === schemaRef.projectMembers) Object.assign(state.projectMembers[0]!, patch)
            else Object.assign(state.projects[0]!, patch)
          },
        }),
      }),
      insert: () => ({
        values: () => ({ onConflictDoNothing: async () => {}, onConflictDoUpdate: async () => {} }),
      }),
    },
  }
})

const { extRoute } = await import('./ext.js')

const call = (path: string, key = 'Bearer ck_live_ok') =>
  extRoute.request(path, { headers: { Authorization: key } })

beforeEach(() => {
  deleted.length = 0
  state.scopes = ['read:all', 'projects:write']
  state.companyId = 'c1'
  state.projects = [
    { id: 'p-internal', companyId: 'c1', externalId: '1178667', name: 'Dev tasks', slug: 'dev', externalName: null, about: '', color: '#fff', createdAt: new Date() },
  ]
  state.users = [
    { id: 'u1', externalId: 'atlas-448', email: 'tal@atlas.co.il', name: 'Tal', avatarUrl: null },
    { id: 'u2', externalId: 'atlas-71', email: 'dana@atlas.co.il', name: 'Dana', avatarUrl: null },
  ]
  state.projectMembers = [{ id: 'pm1', projectId: 'p-internal', userId: 'u1', role: 'member' }]
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
    // Компания в адресе: без неё приложение подставляло первую из списка.
    expect(body.url).toBe('https://app.chatick.com/#/c/c1/p/p-internal')
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

// Отвязка и удаление проекта извне (SPEC §8.46).
//
// Ручка разрушительная: во втором режиме уносит переписку, задачи и файлы. И
// вызывается она не человеком, а чужим сервером по ключу — подтвердить некому.
// Поэтому проверяем прежде всего, что случайно снести проект нельзя.
describe('DELETE /projects/:externalId', () => {
  const del = (path: string, body: unknown) =>
    extRoute.request(path, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ck_live_ok', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('по умолчанию — отвязка: проект остаётся', async () => {
    const res = await del('/projects/1178667', {})
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body).toMatchObject({ unlinked: true, deleted: false })
    expect(deleted).toHaveLength(0)
    // Связь оборвана — по этому id проект больше не найти.
    expect(state.projects[0]!.externalId).toBeNull()
  })

  // Главная защита: удаление без точного имени не проходит. Опечатка в цикле
  // чужого скрипта иначе стирала бы переписку команды без единого вопроса.
  it('удаление без подтверждения именем отклоняется', async () => {
    const res = await del('/projects/1178667', { deleteProject: true })
    expect(res.status).toBe(400)
    expect(deleted).toHaveLength(0)
    expect(state.projects[0]!.externalId).toBe('1178667')
  })

  it('удаление с чужим именем отклоняется', async () => {
    const res = await del('/projects/1178667', { deleteProject: true, confirm: 'Другой проект' })
    expect(res.status).toBe(400)
    expect(deleted).toHaveLength(0)
  })

  it('удаление с точным именем срабатывает', async () => {
    const res = await del('/projects/1178667', { deleteProject: true, confirm: 'Dev tasks' })
    expect(res.status).toBe(200)
    expect((await res.json()) as any).toMatchObject({ deleted: true, deletedFiles: 3 })
    expect(deleted).toEqual(['p-internal'])
  })

  it('чужая компания не удалит и не отвяжет', async () => {
    state.companyId = 'c2'
    expect((await del('/projects/1178667', {})).status).toBe(404)
    expect(deleted).toHaveLength(0)
  })
})

// Смена роли при повторном пуше (SPEC §8.42).
//
// Ошибка здесь тихая вдвойне: внешняя система шлёт новую роль, получает 200 и
// считает, что человека повысили. На деле роль остаётся прежней, и разойдётся
// это молча — как раз то, ради чего внешняя система и объявлена источником
// правды по людям.
describe('POST /projects/:externalId/members — роль', () => {
  const post = (body: unknown) =>
    extRoute.request('/projects/1178667/members', {
      method: 'POST',
      headers: { Authorization: 'Bearer ck_live_ok', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  beforeEach(() => {
    state.scopes = ['read:all', 'users:write']
  })

  it('повторный вызов с другой ролью повышает участника', async () => {
    expect(state.projectMembers[0]!.role).toBe('member')
    const res = await post({ members: [{ externalUserId: 'atlas-448', role: 'admin' }] })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).updatedRoles).toEqual(['atlas-448'])
    expect(state.projectMembers[0]!.role).toBe('admin')
  })

  // Владельца понижать нельзя: проект остался бы без хозяина, а внешняя
  // система про наше понятие владельца ничего не знает.
  it('владельца не понижает', async () => {
    state.projectMembers[0]!.role = 'owner'
    await post({ members: [{ externalUserId: 'atlas-448', role: 'member' }] })
    expect(state.projectMembers[0]!.role).toBe('owner')
  })

  it('та же роль — ничего не меняет и не числится обновлением', async () => {
    const res = await post({ members: [{ externalUserId: 'atlas-448', role: 'member' }] })
    expect(((await res.json()) as any).updatedRoles).toEqual([])
    expect(state.projectMembers[0]!.role).toBe('member')
  })
})

// Аватары из внешней системы (SPEC §8.50).
//
// Две вещи, на которых это ломается тихо: ссылка на чужой приватный бакет
// отдаёт битую картинку вместо аватара, а повторный пуш затирает картинку,
// которую человек загрузил у нас сам.
describe('adoptAvatar', () => {
  it('чужой адрес во внутреннюю сеть не скачивается', async () => {
    const { adoptAvatar } = await import('../lib/avatar.js')
    // SSRF: внешняя система не должна заставить нас читать localhost.
    for (const url of ['http://127.0.0.1/a.png', 'http://169.254.169.254/meta', 'http://10.0.0.5/x.png']) {
      expect(await adoptAvatar('u1', url)).toBeNull()
    }
  })

  it('не-адрес не роняет создание человека', async () => {
    const { adoptAvatar } = await import('../lib/avatar.js')
    expect(await adoptAvatar('u1', 'не ссылка')).toBeNull()
  })
})
