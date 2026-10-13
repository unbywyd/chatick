import { describe, it, expect } from 'vitest'
import { v2Path } from './links.js'
import { parseTaskRef } from './short-links.js'
// Клиентская копия того же перевода: ею открываются старые ссылки из писем.
import { v2Path as clientV2Path, legacyTarget } from '../../../app/src/v2/legacy.js'
// Перевод входящих ссылок в трее и системных уведомлениях (useDesktop).
import { toV2Link, activeFromLocation } from '../../../app/src/lib/v2-links.js'

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
  ['/notifications', `/c/${C}/settings/notifications`],
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

describe('toV2Link — ссылки, которые приходят в трей и системные уведомления', () => {
  const ctx = { companyId: 'CO', companyOf: (p: string) => (p === 'P1' ? 'C1' : null) }
  const cases: [string, string][] = [
    // задачи внутри приложения — панелью поверх списка
    ['/c/C1/p/P1/tasks/T1', '/c/C1?t=T1'],
    ['/c/C1/p/P1/tasks?task=T1', '/c/C1?t=T1'],
    ['/c/C1/p/P1/tasks', '/c/C1?p=P1'],
    ['/c/C1/p/P1/tasks/', '/c/C1?p=P1'],
    // чата в v2 нет — в проект
    ['/c/C1/p/P1/chat', '/c/C1?p=P1'],
    ['/c/C1/p/P1/chat?msg=M1', '/c/C1?p=P1'],
    ['/c/C1/p/P1', '/c/C1?p=P1'],
    // остальное — общим правилом v2Path: у файла и версии свои адреса
    ['/c/C1/p/P1/notes?note=N1', '/c/C1/notes/n/N1'],
    ['/c/C1/p/P1/notes/N1', '/c/C1/notes/n/N1'],
    ['/c/C1/p/P1/notes', '/c/C1/notes?p=P1'],
    ['/c/C1/p/P1/documents/D1', '/c/C1/docs/d/P1/D1'],
    ['/c/C1/p/P1/time', '/c/C1/time'],
    ['/c/C1/p/P1/releases/R1', '/c/C1/versions/v/P1/R1'],
    ['/c/C1/p/P1/files/F1', '/c/C1/files/f/P1/F1'],
    ['/c/C1/p/P1/notifications', '/c/C1/settings/notifications'],
    ['https://app.chatick.com/#/c/C1/p/P1/tasks/T1', '/c/C1?t=T1'],
    ['/p/P1/tasks/T1', '/c/C1?t=T1'],
    ['/p/P2/chat', '/p/P2/chat'],
    ['/inbox', '/c/CO/notifications'],
    ['/settings/notifications', '/c/CO/settings/notifications'],
    ['/settings/profile', '/c/CO/settings/profile'],
    ['/start', '/c/CO'],
    ['/tasks?task=T9', '/c/CO?t=T9'],
    ['/notes?note=N9', '/c/CO/notes/n/N9'],
    ['/c/C1?t=T1', '/c/C1?t=T1'],
    ['/c/C1/task/T1', '/c/C1/task/T1'],
    ['/c/C1/time', '/c/C1/time'],
    ['/login', '/login'],
  ]
  for (const [from, want] of cases) it(`${from} → ${want}`, () => expect(toV2Link(from, ctx)).toBe(want))
  it('без компании в контексте адреса без компании не трогаем', () => {
    expect(toV2Link('/settings/notifications', {})).toBe('/settings/notifications')
    expect(toV2Link('/inbox')).toBe('/inbox')
  })
  it('где сейчас окно', () => {
    expect(activeFromLocation('/c/C1', '?p=P1&t=T1')).toEqual({ companyId: 'C1', projectId: 'P1', taskId: 'T1' })
    expect(activeFromLocation('/c/C1/task/T2', '')).toEqual({ companyId: 'C1', projectId: null, taskId: 'T2' })
    expect(activeFromLocation('/c/C1/task/new', '')).toEqual({ companyId: 'C1', projectId: null, taskId: null })
    expect(activeFromLocation('/companies', '')).toEqual({ companyId: null, projectId: null, taskId: null })
    // Документ, файл, ресурс, версия — проект в самом адресе.
    expect(activeFromLocation('/c/C1/docs/d/P3/D1', '')).toEqual({ companyId: 'C1', projectId: 'P3', taskId: null })
    expect(activeFromLocation('/c/C1/files/f/P4/F1', '')).toEqual({ companyId: 'C1', projectId: 'P4', taskId: null })
    expect(activeFromLocation('/c/C1/resources/r/P5/R1', '')).toEqual({ companyId: 'C1', projectId: 'P5', taskId: null })
    expect(activeFromLocation('/c/C1/versions/v/P6/V1', '')).toEqual({ companyId: 'C1', projectId: 'P6', taskId: null })
  })
})
