import { describe, it, expect } from 'vitest'
import { v2Path } from './links.js'
import { parseTaskRef } from './short-links.js'
// Клиентская копия того же перевода: ею открываются старые ссылки из писем.
import { v2Path as clientV2Path, legacyTarget } from '../../../app/src/v2/legacy.js'

/**
 * Адреса v2. Ссылки строят уведомления, письма, короткие ссылки, мост (MCP) и
 * внешний API — все через v2Path; старые адреса из уже отправленных писем
 * переводит клиент. Две копии одного правила обязаны совпадать.
 */

const C = 'co1'
const P = 'pr1'
const CASES: [string, string][] = [
  ['', `/c/${C}?p=${P}`],
  ['/chat', `/c/${C}?p=${P}`],
  ['/chat?msg=m1', `/c/${C}?p=${P}`],
  ['/tasks', `/c/${C}?p=${P}`],
  ['/tasks/t1', `/c/${C}/task/t1`],
  ['/tasks?task=t1', `/c/${C}/task/t1`],
  ['?task=t1', `/c/${C}/task/t1`],
  ['/notes', `/c/${C}/notes?p=${P}`],
  ['/notes/n1', `/c/${C}/notes/n/n1`],
  ['/notes?note=n1', `/c/${C}/notes/n/n1`],
  ['/documents/d1', `/c/${C}/docs/d/${P}/d1`],
  ['/docs/d1', `/c/${C}/docs/d/${P}/d1`],
  ['/files', `/c/${C}/files?p=${P}`],
  ['/files/f1', `/c/${C}/files/f/${P}/f1`],
  ['/resources/r1', `/c/${C}/resources/r/${P}/r1`],
  ['/releases', `/c/${C}/versions?p=${P}`],
  ['/releases/v1', `/c/${C}/versions/v/${P}/v1`],
  ['/time', `/c/${C}/time`],
  ['/history', `/c/${C}/history?p=${P}`],
  ['/team', `/c/${C}/company`],
  ['/notifications', `/c/${C}/notifications`],
  ['/ai/usage', `/c/${C}?p=${P}`],
  ['/worklog', `/c/${C}?p=${P}`],
  ['tasks/t1', `/c/${C}/task/t1`],
]

describe('v2Path — хвост адреса проекта первой версии → экран v2', () => {
  for (const [tail, want] of CASES) {
    it(`«${tail || '(пусто)'}» → ${want}`, () => {
      expect(v2Path(C, P, tail)).toBe(want)
    })
  }
  it('клиентская копия совпадает с серверной на всех примерах', () => {
    // Саботаж: поменять одну ветку в одной из копий — тест падает.
    for (const [tail] of CASES) expect(clientV2Path(C, P, tail), tail).toBe(v2Path(C, P, tail))
  })
})

describe('legacyTarget — старые адреса из писем и закладок', () => {
  it('адрес проекта первой версии', () => {
    expect(legacyTarget(`/c/${C}/p/${P}/tasks/t1`, '', null)).toBe(`/c/${C}/task/t1`)
    expect(legacyTarget(`/c/${C}/p/${P}/tasks`, '?task=t2', null)).toBe(`/c/${C}/task/t2`)
    expect(legacyTarget(`/c/${C}/p/${P}`, '', null)).toBe(`/c/${C}?p=${P}`)
  })
  it('старый экран компании', () => {
    expect(legacyTarget(`/start/${C}`, '', null)).toBe(`/c/${C}`)
    expect(legacyTarget(`/start/${C}/time`, '', null)).toBe(`/c/${C}/time`)
    expect(legacyTarget(`/start/${C}/team`, '', null)).toBe(`/c/${C}/company`)
  })
  it('адреса без компании — в последнюю открытую', () => {
    expect(legacyTarget('/inbox', '', C)).toBe(`/c/${C}/notifications`)
    expect(legacyTarget('/settings/notifications', '', C)).toBe(`/c/${C}/settings/notifications`)
    expect(legacyTarget('/settings/profile', '', null)).toBe('/start')
  })
  it('незнакомое — не трогаем', () => {
    expect(legacyTarget('/something/else', '', C)).toBeNull()
  })
})

describe('MCP: ссылка v2 на задачу распознаётся', () => {
  it('страница задачи и панель ?t=', () => {
    expect(parseTaskRef('https://app.chatick.com/#/c/co1/task/abc_12')).toEqual({ kind: 'id', taskId: 'abc_12' })
    expect(parseTaskRef('https://app.chatick.com/#/c/co1?t=abc-12')).toEqual({ kind: 'id', taskId: 'abc-12' })
  })
  it('старые формы работают как раньше', () => {
    expect(parseTaskRef('.../#/c/co1/p/pr1/tasks/t9')).toEqual({ kind: 'long', projectId: 'pr1', taskId: 't9' })
    expect(parseTaskRef('TASK-81')).toEqual({ kind: 'number', number: 'TASK-81' })
  })
})
