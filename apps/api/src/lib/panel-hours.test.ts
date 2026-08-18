import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Кнопка «часы проекта» в панели трея.
//
// Панель — единственное место, где таймер виден постоянно, и именно оттуда
// хотят посмотреть наработанное. Пути туда не было: «Открыть Chatick» ведёт в
// приложение вообще, клик по названию — в чат проекта.

const here = import.meta.dirname
const panel = readFileSync(join(here, '../../../desktop/panel.html'), 'utf8')
const strings = readFileSync(join(here, '../../../app/src/hooks/useDesktop.ts'), 'utf8')

describe('кнопка часов в панели', () => {
  it('ведёт в часы ПРОЕКТА, а не компании', () => {
    // Компанейская вкладка «Часы» показывает больше, но открывается только
    // руководству (canManage в StartScreen). Рядовой участник попал бы в
    // настройки — то есть в никуда.
    expect(panel).toMatch(/\/c\/\$\{companyId\}\/p\/\$\{id\}\/time/)
  })

  it('без компании ссылки нет, и кнопка прячется', () => {
    // Маршрут в приложении — /c/<companyId>/p/<id>/…; без компании он не
    // совпадает ни с чем и открывает пустой роутер.
    const fn = panel.slice(panel.indexOf('const openHoursLink'))
    expect(fn.slice(0, fn.indexOf('\n      }'))).toMatch(/companyId \?.*: null/s)
    expect(panel).toMatch(/openHoursLink\(id\) \|\| '\/start'/)
  })

  it('кнопка не мешает таскать окно', () => {
    // Полоса таймера — ручка перетаскивания (-webkit-app-region: drag).
    // Кнопка внутри неё обязана быть no-drag, иначе по ней не нажать.
    const css = panel.slice(panel.indexOf('.hours-btn {'))
    expect(css.slice(0, css.indexOf('}'))).toMatch(/-webkit-app-region:\s*no-drag/)
  })

  it('переход к часам не гасит уведомления проекта', () => {
    // projectId в panel:open означает «ушёл разбирать проект». Часы — не
    // разбор дел, и гасить бейдж за это нельзя.
    expect(panel).toMatch(/openProject\(id \? openHoursLink/)
  })

  it('подпись приходит переводом, а не зашита', () => {
    expect(strings).toMatch(/openHours: t\('desktop\.openHours'\)/)
    expect(panel).toMatch(/T\('openHours'/)
  })
})

describe('кнопка часов срабатывает, а не притворяется', () => {
  it('ссылка считается в момент клика, а не при отрисовке', () => {
    // Замкнув ссылку при отрисовке, кнопку получали живой, а ссылку пустой:
    // панель показывается сразу, список проектов приезжает следом. Клик тогда
    // молча не делал ничего — и отладить это нечем, консоли в панели нет.
    expect(panel).toMatch(/closest\('#hoursBtn'\)/)
    expect(panel).toMatch(/currentTimerProject\(\)/)
    expect(panel).toMatch(/hours\.hidden = !selId/)
  })
})
