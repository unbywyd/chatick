import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Автосообщения о задачах в чате.
//
// Каждое завершение отдельным сообщением превращает чат в ленту событий: за
// день их десятки, и живой разговор тонет между ними. О том же самом уже
// сообщают уведомления — адресно и только тем, кого это касается.

const src = readFileSync(join(import.meta.dirname, 'task-events.ts'), 'utf8')
const route = readFileSync(join(import.meta.dirname, '..', 'routes', 'projects.ts'), 'utf8')

describe('по умолчанию чат молчит', () => {
  it('включение только явное', () => {
    // Саботаж: `!== false` включал бы автопостинг всем, кто настройку не
    // трогал, — а это большинство проектов.
    expect(src).toMatch(/cfg\.autoPostTaskEvents === true/)
    expect(src, 'умолчание снова стало включённым').not.toMatch(/autoPostTaskEvents !== false/)
  })

  it('схема проекта тоже по умолчанию выключена', () => {
    const at = route.indexOf('autoPostTaskEvents')
    expect(at).toBeGreaterThan(-1)
    expect(route.slice(at, at + 60)).toMatch(/default\(false\)/)
  })

  it('настройку по-прежнему можно включить по проекту', () => {
    // Выключить у всех насовсем — не то же, что дать выбор.
    expect(src).toMatch(/autoPostEnabled/)
    expect(route).toMatch(/autoPostTaskEvents/)
  })
})

describe('что не должно шуметь и при включённом', () => {
  it('назначение самому себе не постится', () => {
    expect(src).toMatch(/actorId === assigneeId/)
  })

  it('сбой автопостинга не роняет саму задачу', () => {
    // Задача уже создана или закрыта: падение здесь потеряло бы действие
    // человека ради сообщения о нём.
    const done = src.indexOf('postTaskDone')
    expect(src.slice(done, done + 900)).toMatch(/catch/)
  })
})
