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

  it('двоеточие читается как на счётчике: мм:сс', () => {
    // Счётчик показывает мм:сс, пока часа нет. Прочитать «2:30» как два с
    // половиной часа значило бы записать время, которого человек не вводил:
    // на экране это две с половиной минуты.
    expect(parseElapsed('2:30')).toBe(3)
    expect(parseElapsed('2:02')).toBe(2)
    // С часом — полный формат счётчика.
    expect(parseElapsed('1:03:25')).toBe(63)
  })

  it('короткий таймер не обнуляется', () => {
    // «0:05» — пять секунд. Округление вниз давало ноль, и человек видел,
    // как его время исчезает при попытке его же поправить.
    expect(parseElapsed('0:05')).toBe(1)
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
    expect(panel).toMatch(/if \(\$\('elapsedEdit'\)\.hidden\)/)
  })

  it('без таймера править нечего', () => {
    expect(panel).toMatch(/if \(state\.timer && canEditElapsed\) openElapsedEdit\(\)/)
  })

  it('со старой оболочкой правку не предлагаем', () => {
    // preload живёт ВНУТРИ установленного приложения, а панель грузится с
    // сайта. Приложение лежит в магазине и обновляется не по нашей воле:
    // вызов метода, которого там нет, ронял панель насмерть.
    expect(panel).toMatch(/typeof window\.panel\.setTimerElapsed === 'function'/)
    expect(panel).toMatch(/window\.panel\.setTimerElapsed\?\./)
  })

  it('признак объявлен ДО первой отрисовки', () => {
    // const не поднимается: обращение из renderTimer к переменной ниже дало бы
    // ReferenceError — ту же пустую панель, от которой защищаемся.
    const decl = panel.indexOf("const canEditElapsed =")
    const use = panel.indexOf("classList.toggle('editable', canEditElapsed)")
    expect(decl).toBeGreaterThan(-1)
    expect(use).toBeGreaterThan(-1)
    expect(decl).toBeLessThan(use)
  })

  it('веб не требует свежей оболочки', () => {
    // Тот же промах на стороне приложения: bridge.onTimerElapsed вызывался
    // напрямую, и весь useDesktop падал — чёрный экран вместо приложения.
    expect(desktop).toMatch(/onTimerElapsed\?:/)
    expect(desktop).toMatch(/bridge\.onTimerElapsed\?\./)
    expect(desktop).toMatch(/offTimerElapsed\?\.\(\)/)
  })
})

describe('поле и счётчик — одно состояние', () => {
  it('в поле подставляется РОВНО показанное', () => {
    // Любой пересчёт давал два числа для одного времени: на экране 2:02, в
    // поле 0:02 — и человек правил не то, что видел.
    expect(panel).toMatch(/inp\.value = elapsedText\(t\)/)
  })

  it('есть чем подтвердить и чем отменить', () => {
    // Без кнопок непонятно, чем закончить правку, а клик мимо терял
    // набранное — на маленькой панели это происходит постоянно.
    expect(panel).toMatch(/id="elapsedOk"/)
    expect(panel).toMatch(/id="elapsedCancel"/)
  })

  it('нажатие галочки не считается уходом', () => {
    // blur срабатывает раньше клика: без проверки правка терялась ровно в
    // тот момент, когда её подтверждали.
    expect(panel).toMatch(/relatedTarget\.closest\('#elapsedEdit'\)/)
  })
})

describe('правка идёт в свою ручку', () => {
  it('зовём /my/time, а не проектную', () => {
    // Свой таймер правится сессионным токеном. Путь /time/... попадает в
    // проектный роут и отвечает «Project token required» — а панель проекта
    // не выбирает вовсе.
    expect(desktop).toMatch(/\/api\/v1\/my\/time\/\$\{id}/)
  })

  it('ручка смонтирована именно там', () => {
    // Проверяем не память, а сервер: путь менялся, и клиент об этом не узнал.
    const app = readFileSync(join(import.meta.dirname, '../app.ts'), 'utf8')
    expect(app).toMatch(/'\/api\/v1\/my\/time', timeMineRoute/)
  })
})
