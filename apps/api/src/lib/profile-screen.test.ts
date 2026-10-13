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

describe('профиль из трея', () => {
  // В v2 аватар открывает меню аккаунта, профиль — его пункт.
  it('аватар — кнопка, а не надпись', () => {
    expect(panel).toMatch(/<button class="tr-ib" id="meBtn" type="button"/)
  })

  it('пункт меню открывает страницу профиля', () => {
    expect(panel).toMatch(/else if \(go === 'profile'\) P\.open\(`\$\{base\}\/settings\/profile`\)/)
  })

  it('не мешает таскать окно', () => {
    expect(panel).toMatch(/\.tr-head button \{ -webkit-app-region: no-drag; \}/)
  })
})
