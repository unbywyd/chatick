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

describe('«Мои часы» в панели', () => {
  // В v2 часы — на компанию (/c/<компания>/time, проект — фильтром ?p=):
  // отдельной страницы часов проекта больше нет.
  it('ведёт в часы компании, выбранной в панели', () => {
    expect(panel).toMatch(/const base = coSel \? `\/c\/\$\{coSel\}` : null/)
    expect(panel).toMatch(/if \(go === 'hours'\) P\.open\(`\$\{base\}\/time`\)/)
  })

  it('без компании пункт ничего не открывает', () => {
    expect(panel).toMatch(/if \(!base\) return\n\s*if \(go === 'hours'\)/)
  })

  it('пункт меню не мешает таскать окно', () => {
    // Тащат за шапку; меню аккаунта — поверх списка, вне области перетаскивания.
    expect(panel).toMatch(/\.tr-head button \{ -webkit-app-region: no-drag; \}/)
  })

  it('подпись приходит переводом, а не зашита', () => {
    expect(strings).toMatch(/hours: tv\('tray\.hours'\)/)
    expect(panel).toMatch(/T\('hours'/)
  })
})

describe('пункт часов срабатывает, а не притворяется', () => {
  it('ссылка считается в момент клика, а не при отрисовке', () => {
    const at = panel.indexOf("const go = e.target.closest('[data-go]')?.dataset.go")
    expect(at).toBeGreaterThan(-1)
    expect(panel.slice(at, at + 400)).toMatch(/const base = coSel/)
  })
})
