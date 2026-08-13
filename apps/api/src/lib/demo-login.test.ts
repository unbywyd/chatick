import { describe, it, expect, vi, beforeEach } from 'vitest'

// Демо-аккаунт для рецензентов магазинов: постоянный код, письмо не уходит.
//
// Это второй механизм в системе, который по замыслу пускает без владения
// почтой, и живёт он на публичной ручке входа. Код при этом не меняется
// месяцами, так что проверяем не «работает ли», а то, что им нельзя открыть
// ничего, кроме одного заранее заведённого аккаунта.

const env: { DEMO_LOGIN_EMAIL?: string; DEMO_LOGIN_CODE?: string } = {}
vi.mock('../env.js', () => ({ env, isProd: false }))
vi.mock('./mail.js', () => ({ sendMail: vi.fn() }))

const { isDemoLogin, verifyDemoCode } = await import('./otp.js')

beforeEach(() => {
  env.DEMO_LOGIN_EMAIL = 'review@example.test'
  env.DEMO_LOGIN_CODE = '314159'
})

describe('isDemoLogin', () => {
  it('демо-адрес узнаётся', () => {
    expect(isDemoLogin('review@example.test')).toBe(true)
  })

  it('регистр и пробелы не мешают', () => {
    expect(isDemoLogin('  Review@Example.test ')).toBe(true)
  })

  // Главное свойство: механизм привязан к одному адресу. Иначе постоянный код
  // открывал бы любой аккаунт в системе.
  it('любой другой адрес — обычный вход', () => {
    for (const other of ['tal@atlas.com', 'dana@atlas.com', 'review@evil.test']) {
      expect(isDemoLogin(other)).toBe(false)
    }
  })

  it('похожие адреса не считаются демо', () => {
    for (const near of [
      'review@example.test.evil.com',
      'xreview@example.test',
      'review@example.tes',
      'review+1@example.test',
    ]) {
      expect(isDemoLogin(near)).toBe(false)
    }
  })

  // Без любой из двух переменных механизма нет вовсе: код лежит в открытом
  // репозитории только как имя переменной, и полувключённое состояние —
  // это адрес без кода или код без адреса — не должно пускать никого.
  it('без DEMO_LOGIN_CODE не работает', () => {
    env.DEMO_LOGIN_CODE = undefined
    expect(isDemoLogin('review@example.test')).toBe(false)
  })

  it('без DEMO_LOGIN_EMAIL не работает', () => {
    env.DEMO_LOGIN_EMAIL = undefined
    expect(isDemoLogin('review@example.test')).toBe(false)
  })

  it('пустые значения — то же, что отсутствующие', () => {
    env.DEMO_LOGIN_EMAIL = ''
    env.DEMO_LOGIN_CODE = ''
    expect(isDemoLogin('review@example.test')).toBe(false)
    expect(isDemoLogin('')).toBe(false)
  })
})

describe('verifyDemoCode', () => {
  it('верный код для демо-аккаунта пускает', () => {
    expect(verifyDemoCode('review@example.test', '314159')).toBe(true)
  })

  it('пробелы вокруг кода не мешают', () => {
    expect(verifyDemoCode('review@example.test', ' 314159 ')).toBe(true)
  })

  it('неверный код не пускает', () => {
    for (const wrong of ['314158', '31415', '3141590', '', 'abcdef']) {
      expect(verifyDemoCode('review@example.test', wrong)).toBe(false)
    }
  })

  // Даже с верным кодом чужой адрес не открывается: код и адрес проверяются
  // вместе, а не по отдельности.
  it('верный код к чужому адресу не подходит', () => {
    expect(verifyDemoCode('tal@atlas.com', '314159')).toBe(false)
  })

  it('выключённый механизм не пускает даже с верным кодом', () => {
    env.DEMO_LOGIN_CODE = undefined
    expect(verifyDemoCode('review@example.test', '314159')).toBe(false)
  })
})

describe('демо-вход не задевает обычный', () => {
  // Демо-аккаунт не должен ломать одноразовые коды остальным: у обычного
  // человека код по-прежнему живёт в памяти и сгорает после входа.
  it('обычному адресу письмо уходит как раньше', async () => {
    const { sendMail } = await import('./mail.js')
    const { sendLoginCode, verifyLoginCode } = await import('./otp.js')
    const mock = vi.mocked(sendMail)

    mock.mockClear()
    await sendLoginCode('tal@atlas.com', 'en', false)
    expect(mock.mock.calls[0]![0].to).toBe('tal@atlas.com')

    // Код из письма подходит один раз, второй — уже нет.
    const sent = String(mock.mock.calls[0]![0].subject).match(/(\d{6})/)![1]!
    expect(verifyLoginCode('tal@atlas.com', sent)).toBe('ok')
    expect(verifyLoginCode('tal@atlas.com', sent)).toBe('expired')
  })

  // Постоянный код демо-аккаунта не должен подходить к обычному входу через
  // общий verifyLoginCode — там его попросту нет.
  it('демо-код не подходит к обычной проверке', async () => {
    const { verifyLoginCode } = await import('./otp.js')
    expect(verifyLoginCode('review@example.test', '314159')).not.toBe('ok')
  })
})
