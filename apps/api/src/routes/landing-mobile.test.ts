import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Шапка лендинга не должна распирать страницу на телефоне.
 *
 * Замер старой шапки: при экране 390px ей требовалось 470px, и вбок уезжала
 * ВСЯ страница. Виноваты были названия языков: «English / Русский / עברית»
 * занимали 204px из 308. Новая шапка (2026-10, лендинг v2) замерена в
 * браузере на 320/360/390 на всех трёх языках: ширина страницы равна экрану.
 */

const landing = readFileSync(
  join(import.meta.dirname, '../../../landing/src/components/Landing.astro'),
  'utf8',
).replace(/\r\n/g, '\n')

const media = (q: string, len = 900) => {
  const at = landing.indexOf(`@media (${q})`)
  expect(at, `нет правил ${q}`).toBeGreaterThan(-1)
  return landing.slice(at, at + len)
}

describe('шапка помещается на телефоне', () => {
  it('у языков коды, а не названия', () => {
    // Язык выбирают глазами, а не читают: «RU» узнаётся не хуже «Русский».
    //
    // Саботаж: вернуть l.label в шапку — тест падает.
    const nav = landing.slice(landing.indexOf('<nav class="langs"'), landing.indexOf('</nav>', landing.indexOf('<nav class="langs"')))
    expect(nav, 'короткого кода языка нет').toContain('{l.code.toUpperCase()}')
    expect(nav, 'в шапке полные названия языков').not.toContain('l.label')
  })

  it('пункты меню уходят раньше, чем шапке становится тесно', () => {
    // Саботаж: убрать правило — тест падает.
    expect(media('max-width: 1080px', 200), 'меню не прячется').toMatch(/\.links \{\s*display: none;/)
  })

  it('на телефоне уходит GitHub, а кнопка входа остаётся', () => {
    // Кнопка входа — главное действие шапки: убирать её нельзя, только ужимать.
    //
    // Саботаж: спрятать .btn — тест падает.
    const block = media('max-width: 560px')
    expect(block, 'GitHub занимает место').toMatch(/\.ghb \{\s*display: none;/)
    expect(block, 'кнопка входа скрыта').not.toMatch(/\.btn[^{]*\{[^}]*display: none/)
  })

  it('на самых узких экранах шапка ужимается, а не распирает страницу', () => {
    // На 320px три кода языка и «Войти» помещаются только с ужатыми промежутками.
    //
    // Саботаж: убрать правило — тест падает.
    const block = media('max-width: 380px', 400)
    expect(block, 'промежутки не ужимаются').toMatch(/\.nav \{\s*gap: 6px;/)
    expect(block, 'кнопка входа скрыта').not.toMatch(/display: none/)
  })
})
