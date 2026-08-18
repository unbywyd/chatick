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
  it('голые цифры не принимаются', () => {
    // «200» читалось как два часа, а «2:00» — как две минуты: одна мысль,
    // два ответа, и заметить это можно было только по чужим часам в отчёте.
    // Пусть лучше не примет, чем примет НЕ ТО.
    expect(parseElapsed('45')).toBeNull()
    expect(parseElapsed('200')).toBeNull()
    expect(parseElapsed('2000')).toBeNull()
  })

  it('часы — только третьим числом', () => {
    // Как на счётчике: два числа это минуты и секунды, три — часы, минуты,
    // секунды. Значения в СЕКУНДАХ: в базе метки времени, а не минуты.
    expect(parseElapsed('2:00')).toBe(120)
    expect(parseElapsed('2:00:00')).toBe(7200)
    expect(parseElapsed('20:10:00')).toBe(72600)
  })

  it('двоеточие читается как на счётчике: мм:сс', () => {
    // «2:30» на экране — две с половиной минуты, а не два с половиной часа.
    expect(parseElapsed('2:30')).toBe(150)
    expect(parseElapsed('2:02')).toBe(122)
    expect(parseElapsed('1:03:25')).toBe(3805)
  })

  it('секунды сохраняются точно', () => {
    // Округление до минуты делало правку одних секунд бессмысленной:
    // «10:10» и «10:20» давали одинаковый результат.
    expect(parseElapsed('0:05')).toBe(5)
    expect(parseElapsed('10:10')).toBe(610)
    expect(parseElapsed('10:20')).toBe(620)
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
  it('начало отсчитывается назад точно', () => {
    expect(desktop).toContain('Date.now() - seconds * 1000')
  })

  it('секунды НЕ обнуляются', () => {
    // В базе лежат метки времени — секунды там хранятся. Обнуляя их, мы
    // теряли то, что человек только что ввёл.
    expect(desktop).not.toContain('setSeconds')
  })

  it('панель шлёт секунды, а не готовую дату', () => {
    // Считает веб: там токен, права и показ ошибки.
    expect(preload).toMatch(/setTimerElapsed: \(id, seconds\)/)
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

describe('ввод не даёт напортачить', () => {
  it('принимаются только цифры и двоеточие', () => {
    // Буквы всё равно кончатся отказом при разборе, но человек узнает об
    // этом лишь нажав галочку. Дешевле не дать набрать.
    expect(panel).toMatch(/replace\(\/\[\^\\d:\]\/g, ''\)/)
    expect(panel).toMatch(/slice\(0, 8\)/)
  })

  it('панель узнаёт о правке сразу', () => {
    // Панель читает свой ключ. Обновляя только ключ вкладки «Время», я
    // оставлял её ждать опроса — до 30 секунд со старым числом.
    const at = desktop.indexOf('Date.now() - seconds * 1000')
    expect(desktop.slice(at, at + 900)).toMatch(/'desktop-running'/)
  })
})
