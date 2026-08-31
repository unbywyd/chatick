import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Логотип на странице компании ведёт к выбору компании.
 *
 * Ожидание клиента: клик по логотипу возвращает туда, где выбирают компанию.
 * Разумно — так работает почти везде.
 *
 * С оговоркой: единственную компанию /start открывает сразу (выбирать не из
 * чего), и клик мгновенно вернул бы человека обратно. Выглядело бы как
 * сломанная кнопка, поэтому при одной компании логотип остаётся логотипом.
 */

const screen = readFileSync(join(import.meta.dirname, '../../../app/src/screens/StartScreen.tsx'), 'utf8')

describe('логотип на странице компании', () => {
  it('уводит к выбору компании', () => {
    expect(screen).toMatch(/onClick=\{\(\) => navigate\('\/start'\)\}/)
  })

  it('кликабелен только когда компаний больше одной', () => {
    // Иначе автопереход на единственную компанию вернёт человека обратно,
    // и клик прочитается как поломка.
    expect(screen).toMatch(/company && \(companiesQ\.data\?\.companies\.length \?\? 0\) > 1 \?/)
  })

  it('иначе остаётся обычным логотипом', () => {
    // Ветка else обязана рисовать логотип, а не пустоту.
    //
    // Проверяем НАЛИЧИЕ логотипа в ветке, а не точную разметку: прежний
    // шаблон требовал буквально «<Logo />» и упал, когда логотип обернули в
    // span, чтобы прятать его на телефоне. Правило при этом не менялось.
    const at = screen.indexOf('> 1 ?')
    expect(at, 'ветка выбора компании не найдена').toBeGreaterThan(-1)
    const branch = screen.slice(at, at + 700)
    const elseAt = branch.indexOf(') : (')
    expect(elseAt, 'нет ветки else').toBeGreaterThan(-1)
    expect(branch.slice(elseAt, elseAt + 200), 'в ветке else нет логотипа').toMatch(/<Logo \/>/)
    // И он не кликабельный: переход отсюда вернул бы человека обратно.
    expect(branch.slice(elseAt, elseAt + 200), 'логотип в ветке else кликается').not.toMatch(/onClick/)
  })
})
