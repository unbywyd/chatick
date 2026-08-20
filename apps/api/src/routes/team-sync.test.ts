import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Работа с командой одинакова во всех трёх местах: интерфейс, мост, MCP.
//
// Раньше слои расходились: мост умел звать людей со стороны, а интерфейс нет;
// интерфейс умел убирать из проекта, а мост нет; MCP умел только смотреть.
// Человек и ассистент видели разный продукт.

const bridge = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')
const projects = readFileSync(join(import.meta.dirname, 'projects.ts'), 'utf8')
const mcp = readFileSync(join(import.meta.dirname, '../../../mcp/src/index.ts'), 'utf8')
const guide = readFileSync(join(import.meta.dirname, '../lib/bridge-docs.ts'), 'utf8')

describe('мост умеет всё, что умеет интерфейс', () => {
  it('убрать из проекта', () => {
    // Команда росла и не убывала: за каждым уходом человек шёл в интерфейс.
    expect(bridge).toMatch(/bridgeRoute\.delete\('\/members\/:userId'/)
  })

  it('удаление шлёт письмо, как и в интерфейсе', () => {
    // Иначе человек узнаёт о потере доступа, наткнувшись на отказ.
    const at = bridge.indexOf("bridgeRoute.delete('/members/:userId'")
    expect(bridge.slice(at, at + 2000)).toMatch(/sendRemovedFromProjectMail/)
  })

  it('удаление попадает в историю проекта', () => {
    const at = bridge.indexOf("bridgeRoute.delete('/members/:userId'")
    expect(bridge.slice(at, at + 2000)).toMatch(/logActivity/)
  })
})

describe('владельца проекта не трогаем нигде', () => {
  it('мост не даёт убрать', () => {
    // Владелец один на проект и часто единственное начальство: без него
    // некому вернуть людей и раздать права.
    const at = bridge.indexOf("bridgeRoute.delete('/members/:userId'")
    expect(bridge.slice(at, at + 2000)).toMatch(/owner cannot be removed/)
  })

  it('интерфейсная ручка тоже', () => {
    // Здесь дыра оставалась открытой, пока мост уже запрещал смену роли.
    const at = projects.indexOf("projectsRoute.delete('/:projectId/members/:userId'")
    expect(at, 'ручка удаления не найдена').toBeGreaterThan(-1)
    const body = projects.slice(at, projects.indexOf('return c.json({ ok: true })', at))
    expect(body).toMatch(/victim\?\.role === 'owner'/)
  })
})

describe('MCP догнал остальных', () => {
  it('умеет добавлять и звать со стороны', () => {
    expect(mcp).toMatch(/'chatick_member_add'/)
    // Один инструмент на оба случая: у ассистента не должно быть развилки
    // «а этот уже в компании или нет» — сервер разберётся сам.
    const at = mcp.indexOf("'chatick_member_add'")
    const body = mcp.slice(at, at + 1800)
    expect(body).toMatch(/userId/)
    expect(body).toMatch(/email/)
  })

  it('умеет менять роль', () => {
    expect(mcp).toMatch(/'chatick_member_role'/)
  })

  it('умеет убирать', () => {
    expect(mcp).toMatch(/'chatick_member_remove'/)
  })

  it('видит, кого ещё можно добавить', () => {
    // Без этого ассистент предлагал бы тех, кто уже в проекте.
    expect(mcp).toMatch(/'chatick_members_available'/)
  })

  it('предупреждает спросить человека перед удалением', () => {
    // Потеря доступа посреди работы необратима по последствиям: вернуть
    // участника можно, а сделанное им — нет.
    const at = mcp.indexOf("'chatick_member_remove'")
    expect(mcp.slice(at, at + 1200)).toMatch(/Ask the human/)
  })
})

describe('гайд рассказывает то же самое', () => {
  it('удаление описано', () => {
    expect(guide).toMatch(/DELETE \/x\/members\/<userId>/)
  })

  it('сказано, что приглашение несёт с собой проект', () => {
    // Иначе ассистент делает два шага там, где хватает одного.
    expect(guide).toMatch(/company AND this project/)
  })

  it('сказано, что владельца трогать нельзя', () => {
    expect(guide).toMatch(/owner cannot be removed/)
  })
})
