import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Подключение ассистента без входа говорило неправду.
 *
 * Человек получал код от ассистента, открывал /connect, вставлял — и читал
 * «код не найден или истёк». Код был верный. Не хватало ВХОДА: ручка
 * /auth/bridge/code требует сессию и отвечает 401, а экран показывал на любую
 * ошибку одно и то же — «код плохой».
 *
 * Цена такой подмены высокая: человек идёт чинить не то. Просит новый код,
 * получает тот же ответ, решает что сломано у нас.
 *
 * Редирект на вход в useEffect от этого не спасал: он срабатывает ПОСЛЕ
 * первого рендера, а запрос уходит уже на нём.
 */

const screen = readFileSync(
  join(import.meta.dirname, '../../../app/src/screens/ConnectScreen.tsx'),
  'utf8',
)

describe('код не спрашивают, пока не вошли', () => {
  it('запрос включён только при наличии сессии', () => {
    // Саботаж: убрать проверку токена — запрос снова уйдёт без входа и
    // вернётся 401, который выглядит как «код неверный».
    expect(screen).toMatch(/enabled: code\.trim\(\)\.length >= 8 && Boolean\(getSessionToken\(\)\)/)
  })

  it('401 отличается от «плохого кода»', () => {
    expect(screen).toMatch(/needsLogin = pending\.error instanceof ApiError && pending\.error\.status === 401/)
    expect(screen).toMatch(/needsLogin \? t\('connect\.signInFirst'\) : t\('connect\.badCode'\)/)
  })

  it('адрес с кодом переживает вход', () => {
    // Без этого после входа человек попадает на общий экран, и код нужно
    // искать в переписке заново.
    expect(screen).toMatch(/setReturnTo\(`\/connect/)
  })
})

describe('переводы на месте во всех языках', () => {
  it('signInFirst есть в ru, en, he', () => {
    for (const loc of ['ru', 'en', 'he']) {
      const json = JSON.parse(
        readFileSync(join(import.meta.dirname, `../../../app/src/i18n/locales/${loc}.json`), 'utf8'),
      ) as { connect?: Record<string, string> }
      expect(json.connect?.signInFirst, `нет перевода connect.signInFirst для ${loc}`).toBeTruthy()
    }
  })
})

describe('сервер по-прежнему требует вход', () => {
  it('ручка проверки кода закрыта сессией', () => {
    // Экран стал вежливее, но защита — на сервере, и она обязана остаться.
    const auth = readFileSync(join(import.meta.dirname, 'auth.ts'), 'utf8')
    expect(auth).toMatch(/auth\.get\('\/bridge\/code\/:code', requireSession/)
    expect(auth).toMatch(/auth\.post\('\/bridge\/approve', requireSession/)
  })
})
