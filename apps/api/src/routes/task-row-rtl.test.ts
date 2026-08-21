import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Номер задачи и её название в списке — на иврите тоже.
//
// Симптом: «testTASK-2» вместо «TASK-2 test». Номер уезжал вправо и
// прижимался к названию.
//
// Причина не в отступе: в RTL-строке первый инлайновый элемент И ЕСТЬ самый
// правый. Ни dir, ни unicode-bidi, ни поля этого не меняют — проверено
// замером всех вариантов в браузере. Меняет только порядок во flex-строке.

const tab = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/tabs/TasksTab.tsx'),
  'utf8',
)

/** Разметка строки задачи: от номера до конца названия. */
function row(): string {
  const at = tab.indexOf('{task.number}')
  expect(at, 'номер задачи в строке не найден').toBeGreaterThan(-1)
  // Назад до открывающего контейнера, вперёд — до названия.
  const from = tab.lastIndexOf('<span', tab.lastIndexOf('<span', at - 1) - 1)
  const to = tab.indexOf('{task.title}', at)
  expect(to).toBeGreaterThan(-1)
  return tab.slice(from, to + 40)
}

describe('номер задачи стоит перед названием', () => {
  it('порядок задан flex, а не инлайном', () => {
    // Инлайновый поток здесь не годится: правило «первый элемент — самый
    // правый» работает в нём, но не даёт управлять шириной и обрезкой.
    expect(row()).toMatch(/flex/)
  })

  it('порядок разметки не переворачивается', () => {
    /**
     * Во flex-строке RTL уже ставит первый элемент справа — номер и так
     * оказывается перед названием. row-reverse переворачивал это ещё раз и
     * отправлял номер в хвост строки, за название.
     *
     * Прежняя правка добавила его по инерции от инлайнового варианта, где
     * порядок работал иначе. Симптом вернулся: «название TASK-31» вместо
     * «TASK-31 название».
     */
    const r = row()
    expect(r, 'номер снова уедет за название').not.toMatch(/rtl:flex-row-reverse/)
    // justify-end нужен был только развёрнутому ряду.
    expect(r).not.toMatch(/rtl:justify-end/)
  })

  it('номер читается слева направо', () => {
    // Иначе «TASK-9» в ивритской строке читается как «9-TASK».
    expect(row()).toMatch(/dir="ltr"/)
  })

  it('номер не сжимается и не обрезается', () => {
    // Обрезаться должно название, а не номер: по номеру задачу ищут.
    const r = row()
    expect(r).toMatch(/shrink-0/)
    expect(r).toMatch(/truncate|text-ellipsis/)
  })

  it('название остаётся самостоятельным куском', () => {
    // <bdi> держит направление названия при любом языке: латиница внутри
    // ивритской строки иначе переставляется словами.
    expect(row()).toMatch(/<bdi/)
  })
})
