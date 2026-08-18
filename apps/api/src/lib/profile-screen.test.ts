import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Свой профиль — отдельной страницей.
//
// Раньше имя и фото правились только из выпадающего меню, где поле ввода
// соседствует с «Выйти»: промах стоил выхода из аккаунта. И у меню нет
// адреса — значит некуда вести из трея, где аватар видно постоянно.

const here = import.meta.dirname
const app = (p: string) => readFileSync(join(here, '../../../app/src', p), 'utf8')
const panel = readFileSync(join(here, '../../../desktop/panel.html'), 'utf8')

describe('страница профиля', () => {
  it('маршрут объявлен', () => {
    expect(app('main.tsx')).toMatch(/path="\/settings\/profile"/)
  })

  it('правит имя и фото теми же ручками, что и меню', () => {
    // Ручки давно есть; новая страница их переиспользует, а не заводит свои.
    const s = app('screens/ProfileScreen.tsx')
    expect(s).toMatch(/\/api\/v1\/auth\/me'/)
    expect(s).toMatch(/\/api\/v1\/auth\/me\/avatar/)
  })

  it('аватар грузится сессионным токеном', () => {
    // Профиль — не проектная сущность, и на этом экране проект не выбран.
    expect(app('screens/ProfileScreen.tsx')).toMatch(/getSessionToken\(\)/)
  })

  it('почта показана, но не правится', () => {
    // Она — способ войти: менять надо с подтверждением на оба адреса, иначе
    // опечатка отрезает человека от аккаунта.
    const s = app('screens/ProfileScreen.tsx')
    expect(s).toMatch(/profile\.email/)
    expect(s).not.toMatch(/email:.*input|setEmail/)
  })

  it('в меню профиля есть вход на страницу', () => {
    expect(app('components/ProfileMenu.tsx')).toMatch(/navigate\('\/settings\/profile'\)/)
  })
})

describe('аватар в трее ведёт в профиль', () => {
  it('это кнопка, а не надпись', () => {
    // span не нажимается: аватар было видно, но не кликнуть.
    expect(panel).toMatch(/<button class="avatar me-avatar" id="meAvatar"/)
  })

  it('клик открывает страницу профиля', () => {
    expect(panel).toMatch(/closest\('#meAvatar'\)/)
    expect(panel).toMatch(/openProject\('\/settings\/profile', null\)/)
  })

  it('не мешает таскать окно', () => {
    // Полоса таймера — ручка перетаскивания.
    const css = panel.slice(panel.indexOf('.me-avatar {'))
    expect(css.slice(0, css.indexOf('}'))).toMatch(/-webkit-app-region:\s*no-drag/)
  })

  it('адрес личный — без компании', () => {
    // В отличие от часов проекта: профиль не привязан ни к какой компании,
    // и подставлять её значило бы вести человека не туда.
    const at = panel.indexOf("closest('#meAvatar')")
    expect(panel.slice(at, at + 200)).not.toMatch(/companyId/)
  })
})
