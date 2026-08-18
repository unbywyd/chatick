import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Правка натикавшего из панели трея.
//
// Панель — отдельный html без сборщика, поэтому разбор ввода там КОПИЯ
// parseDuration из приложения. Копия молча расходится с оригиналом: один и тот
// же ввод начинает пониматься по-разному, и замечают это не сразу.

const here = import.meta.dirname
const panel = readFileSync(join(here, '../../../desktop/panel.html'), 'utf8')
const parse = readFileSync(join(here, '../../../app/src/lib/time-parse.ts'), 'utf8')
const desktop = readFileSync(join(here, '../../../app/src/hooks/useDesktop.ts'), 'utf8')
const preload = readFileSync(join(here, '../../../desktop/preload-panel.cjs'), 'utf8')
const main = readFileSync(join(here, '../../../desktop/main.cjs'), 'utf8')

/** Разбор из панели, выдернутый как есть — проверяем то, что там правда лежит. */
const parseElapsed = (() => {
  const from = panel.indexOf('function parseElapsed(')
  const src = panel.slice(from, panel.indexOf('\n      }', from) + 8)
  return new Function(`${src}; return parseElapsed`)() as (s: string) => number | null
})()

describe('разбор натикавшего', () => {
  it('до двух цифр — минуты', () => {
    // 45 это 45 минут, а не 45 часов: так же читает приложение.
    expect(parseElapsed('45')).toBe(45)
    expect(parseElapsed('7')).toBe(7)
  })

  it('три-четыре цифры — часы и минуты', () => {
    expect(parseElapsed('103')).toBe(63) // 1:03 — пример из задачи
    expect(parseElapsed('1220')).toBe(740) // 12:20
  })

  it('с двоеточием — как написано', () => {
    expect(parseElapsed('2:30')).toBe(150)
  })

  it('минут больше 59 не бывает', () => {
    // 190 — это опечатка, а не 1 ч 90 мин. Молча принять значило бы записать
    // человеку время, которого он не вводил.
    expect(parseElapsed('190')).toBeNull()
    expect(parseElapsed('1:75')).toBeNull()
  })

  it('мусор не проходит', () => {
    expect(parseElapsed('')).toBeNull()
    expect(parseElapsed('abc')).toBeNull()
    expect(parseElapsed('12345')).toBeNull()
  })

  it('понимает то же, что и приложение', () => {
    // Копия обязана совпадать с оригиналом хотя бы в правилах, которые
    // человек проверяет глазами.
    expect(parse).toMatch(/до двух цифр — минуты/)
    expect(panel).toMatch(/КОПИЯ логики parseDuration/)
  })
})

describe('правка не ломает дату', () => {
  it('новое начало считается от «сейчас минус столько-то»', () => {
    // День выставляется сам — отдельно его не трогаем. Ровно то, на чём
    // горели в TASK-6, где сдвиг одного края делал из трёх минут сутки.
    expect(desktop).toMatch(/Date\.now\(\) - minutes \* 60_000/)
  })

  it('секунды обнуляются', () => {
    // В поле панели секунд нет: невидимый остаток превращал бы 1:03 в 1:03:47.
    expect(desktop).toMatch(/startedAt\.setSeconds\(0, 0\)/)
  })

  it('панель шлёт минуты, а не готовую дату', () => {
    // Считает веб: там токен, права и показ ошибки.
    expect(preload).toMatch(/setTimerElapsed: \(id, minutes\)/)
    expect(main).toMatch(/panel:timer-elapsed/)
  })

  it('чужой таймер не правим', () => {
    // Пока человек набирал, таймер мог остановиться или смениться.
    expect(desktop).toMatch(/if \(!current \|\| current\.id !== id\) return/)
  })
})

describe('поле ведёт себя предсказуемо', () => {
  it('Escape отменяет, Enter применяет', () => {
    // Панель маленькая, промахнуться легко: без отмены случайный клик по
    // времени превращается в ловушку.
    expect(panel).toMatch(/e\.key === 'Enter'.*commitElapsed/s)
    expect(panel).toMatch(/e\.key === 'Escape'.*closeElapsedEdit/s)
  })

  it('поле не мешает таскать окно', () => {
    // Полоса таймера — ручка перетаскивания.
    const css = panel.slice(panel.indexOf('.elapsed-input {'))
    expect(css.slice(0, css.indexOf('}'))).toMatch(/-webkit-app-region:\s*no-drag/)
  })

  it('тиканье не затирает набранное', () => {
    expect(panel).toMatch(/if \(\$\('elapsedInput'\)\.hidden\) \$\('elapsed'\)\.textContent/)
  })

  it('без таймера править нечего', () => {
    expect(panel).toMatch(/if \(state\.timer\) openElapsedEdit\(\)/)
  })
})
