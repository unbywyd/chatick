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
    // Саботаж: убрать rtl:flex-row-reverse — номер снова уедет вправо.
    const r = row()
    expect(r).toMatch(/flex/)
    expect(r, 'нет разворота порядка в RTL').toMatch(/rtl:flex-row-reverse/)
  })

  it('в RTL строка прижата к началу', () => {
    // Без justify-end развёрнутый ряд разъезжается по ширине, и номер
    // отрывается от названия на всю строку.
    expect(row()).toMatch(/rtl:justify-end/)
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
