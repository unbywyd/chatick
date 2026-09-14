import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Шапка лендинга не должна распирать страницу на телефоне.
 *
 * Замер до правки: при экране 390px шапке требовалось 470px, и вбок уезжала
 * ВСЯ страница — внизу появлялась горизонтальная прокрутка. Так на всех
 * мобильных ширинах: 320 → 465, 360 → 468, 430 → 472.
 *
 * Виноваты были не кнопки копирования (по 35px), а названия языков: «English
 * / Русский / עברית» занимали 204px из 308, отведённых всей правой части.
 */

const landing = readFileSync(
  join(import.meta.dirname, '../../../landing/src/components/Landing.astro'),
  'utf8',
).replace(/\r\n/g, '\n')

describe('шапка помещается на телефоне', () => {
  it('на телефоне у языков коды, а не названия', () => {
    // Язык выбирают глазами, а не читают: «RU» узнаётся не хуже «Русский».
    //
    // Саботаж: убрать lang-short — тест падает.
    expect(landing, 'короткого кода языка нет').toContain('<span class="lang-short">{l.code.toUpperCase()}</span>')
    expect(landing, 'полное название не прячется').toMatch(/\.lang-full \{\s*display: none;/)
  })

  it('кнопки копирования инструкций скрыты на телефоне', () => {
    // Их вставляют ассистенту в редакторе — то есть за компьютером. Сами
    // инструкции никуда не делись, они в тексте страницы.
    //
    // Саботаж: убрать правило — тест падает.
    const at = landing.indexOf('@media (max-width: 620px)')
    expect(at, 'нет правил для телефона').toBeGreaterThan(-1)
    expect(landing.slice(at, at + 400), 'кнопки копирования занимают место').toMatch(
      /\.doc-copy \{\s*display: none;/,
    )
  })

  it('на узких экранах шапка ужимается, но кнопка «Начать» остаётся', () => {
    // Кнопка — главное действие страницы: убирать её нельзя ни при каких
    // условиях, только ужимать.
    //
    // Саботаж: спрятать .btn-sm — тест падает.
    const at = landing.indexOf('@media (max-width: 400px)')
    expect(at, 'нет правил для узких экранов').toBeGreaterThan(-1)
    const block = landing.slice(at, at + 700)
    expect(block, 'кнопка «Начать» скрыта').not.toMatch(/\.btn-sm \{[^}]*display: none/)
    expect(block, 'кнопка не ужимается').toMatch(/\.nav-actions \.btn-sm \{[\s\S]{0,80}font-size: 13px/)
  })

  it('на 320px остаётся только текущий язык', () => {
    // Со всеми тремя страница распиралась до 351px при экране 320. Убрать
    // языки ЦЕЛИКОМ не помогало — 351 оставался, место занимал контейнер.
    //
    // Саботаж: убрать правило — тест падает.
    const at = landing.indexOf('@media (max-width: 360px)')
    expect(at, 'нет правил для 320px').toBeGreaterThan(-1)
    expect(landing.slice(at, at + 200), 'показаны все языки').toMatch(/\.lang:not\(\.active\) \{\s*display: none;/)
  })
})
