import { describe, it, expect, vi, beforeEach } from 'vitest'

// Разбор адреса «почта:dev» — вход под чужим аккаунтом.
//
// Это единственный механизм в системе, который по замыслу открывает чужие
// данные, и живёт он на форме входа, до всякой проверки личности. Поэтому
// проверяем не то, что он работает, а то, что его нельзя вывернуть:
// подставить получателя, включить на сервере без настройки, проскочить мимо
// журнала.

const env: { SUPPORT_LOGIN_EMAIL?: string } = {}
vi.mock('../env.js', () => ({ env, isProd: false }))
vi.mock('./mail.js', () => ({ sendMail: vi.fn() }))

const { parseSupportLogin } = await import('./otp.js')

beforeEach(() => {
  env.SUPPORT_LOGIN_EMAIL = 'unbywyd@gmail.com'
})

describe('parseSupportLogin', () => {
  it('обычный адрес остаётся обычным', () => {
    expect(parseSupportLogin('tal@atlas.com')).toEqual({ email: 'tal@atlas.com', support: false })
  })

  it('суффикс отрезается, адрес — владельца ящика', () => {
    expect(parseSupportLogin('tal@atlas.com:dev')).toEqual({ email: 'tal@atlas.com', support: true })
  })

  it('регистр не помеха: адрес и суффикс приводятся к нижнему', () => {
    expect(parseSupportLogin('  Tal@Atlas.com:DEV ')).toEqual({ email: 'tal@atlas.com', support: true })
  })

  // Главная защита: без адреса в env механизма нет вовсе. Формат суффикса
  // попадёт в открытый репозиторий, и «забыли выключить» станет чужим входом.
  it('без SUPPORT_LOGIN_EMAIL суффикс не работает', () => {
    env.SUPPORT_LOGIN_EMAIL = undefined
    const r = parseSupportLogin('tal@atlas.com:dev')
    expect(r.support).toBe(false)
    // И адрес НЕ распадается на настоящий: иначе выключенный механизм всё
    // равно пускал бы письмо владельцу и подсказывал, что аккаунт существует.
    expect(r.email).toBe('tal@atlas.com:dev')
  })

  it('пустой env — то же самое, что отсутствующий', () => {
    env.SUPPORT_LOGIN_EMAIL = ''
    expect(parseSupportLogin('tal@atlas.com:dev').support).toBe(false)
  })

  // Получателя нельзя задать из запроса — он всегда из env. Иначе форма входа
  // раздавала бы коды от любого аккаунта на любой указанный адрес.
  it('получателя нельзя подставить через адрес', () => {
    for (const attempt of [
      'tal@atlas.com:dev@evil.com',
      'tal@atlas.com:dev evil@evil.com',
      'tal@atlas.com:dev,evil@evil.com',
    ]) {
      expect(parseSupportLogin(attempt).support).toBe(false)
    }
  })

  it('похожие хвосты не считаются суффиксом', () => {
    for (const near of ['tal@atlas.com:developer', 'tal@atlas.com:de', 'tal@atlas.com dev', 'tal@atlas.comdev']) {
      expect(parseSupportLogin(near).support).toBe(false)
    }
  })

  it('двоеточие внутри адреса не превращает его в служебный вход', () => {
    expect(parseSupportLogin('od:dev@atlas.com').support).toBe(false)
  })
})

describe('sendLoginCode — куда уходит письмо', () => {
  it('обычный вход — владельцу ящика, служебный — на адрес из env', async () => {
    const { sendMail } = await import('./mail.js')
    const { sendLoginCode } = await import('./otp.js')
    const mock = vi.mocked(sendMail)

    mock.mockClear()
    await sendLoginCode('tal@atlas.com', 'en', false)
    expect(mock.mock.calls[0]![0].to).toBe('tal@atlas.com')

    mock.mockClear()
    // Другой ящик: код на тот же адрес ушёл бы минуту спустя (антифлуд).
    await sendLoginCode('dana@atlas.com', 'en', true)
    expect(mock.mock.calls[0]![0].to).toBe('unbywyd@gmail.com')
    // В письме видно, чей аккаунт открывается — иначе легко войти не туда.
    expect(String(mock.mock.calls[0]![0].text)).toContain('dana@atlas.com')
  })
})
