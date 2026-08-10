import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Кого уведомляют, когда у задачи меняется статус.
//
// Долго уведомляли только исполнителя, и самый обычный случай выпадал целиком:
// я поставил задачу Талю, Таль перевёл её в ревью — и я об этом не узнаю, хотя
// ревью ждут именно от меня. Заказчик работы молча оставался в неведении о её
// ходе, а узнавал, только зайдя на доску сам.
//
// Ошибка тихая с обеих сторон: тот, кто менял статус, видит, что всё прошло;
// тот, кто ждал, просто не получает письма и не знает, что должен был.

const src = readFileSync(join(import.meta.dirname, 'tasks.ts'), 'utf8')
const bridge = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')

/** Блок уведомления о смене статуса. */
const block = (() => {
  const start = src.indexOf('opts.statusChanged')
  expect(start, 'блок уведомления о смене статуса не найден').toBeGreaterThan(-1)
  return src.slice(start - 400, start + 900)
})()

describe('смена статуса', () => {
  it('уведомляет и исполнителя, и автора задачи', () => {
    expect(block).toMatch(/task\.assigneeId, task\.createdById/)
  })

  it('не падает, когда исполнителя нет', () => {
    // Задача без исполнителя — обычное дело: автор всё равно должен узнать.
    // Без фильтра по null в получателях оказался бы undefined.
    expect(block).toMatch(/\.filter\(\(id\): id is string => Boolean\(id\)\)/)
    expect(block).toMatch(/statusRecipients\.length/)
  })

  it('ключ дедупа не содержит id получателя', () => {
    // notify дописывает его сам; лишний id внутри ключа склеил бы автора с
    // исполнителем и один из них уведомления не получил бы.
    expect(block).toMatch(/dedupeKey: `task_status:\$\{task\.id\}:\$\{task\.status\}`/)
    expect(block).not.toMatch(/dedupeKey: `task_status:[^`]*assigneeId/)
  })
})

describe('оба пути ведут через одну функцию', () => {
  it('мост уведомляет тем же notifyTask, а не своей копией', () => {
    // Иначе правило пришлось бы держать в двух местах, и мост отстал бы —
    // ровно так уже случалось с гайдом.
    const calls = bridge.match(/notifyTask\(/g) ?? []
    expect(calls.length, 'мост должен звать общий notifyTask').toBeGreaterThanOrEqual(2)
    expect(bridge).not.toMatch(/event: 'task_status'/)
  })
})
