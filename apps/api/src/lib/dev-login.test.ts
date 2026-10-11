import { describe, expect, it } from 'vitest'
import { devLoginAllowed } from './dev-login.js'

const ok = { flag: '1', nodeEnv: 'development', databaseUrl: 'postgres://u:p@127.0.0.1:55432/chatick_next_dev?sslmode=disable', host: 'localhost:3299' }

describe('devLoginAllowed — нужны все четыре условия', () => {
  it('всё сошлось — можно', () => {
    expect(devLoginAllowed(ok)).toBe(true)
    expect(devLoginAllowed({ ...ok, databaseUrl: 'postgres://u:p@h/chatick_next_staging' })).toBe(true)
    expect(devLoginAllowed({ ...ok, databaseUrl: 'postgres://u:p@h/chatick_check_a1' })).toBe(true)
    expect(devLoginAllowed({ ...ok, host: '127.0.0.1:3299' })).toBe(true)
  })
  it('без флага — нет', () => {
    expect(devLoginAllowed({ ...ok, flag: undefined })).toBe(false)
    expect(devLoginAllowed({ ...ok, flag: 'true' })).toBe(false)
  })
  it('production — нет', () => {
    expect(devLoginAllowed({ ...ok, nodeEnv: 'production' })).toBe(false)
  })
  it('боевая база — нет, как бы её ни прятали', () => {
    expect(devLoginAllowed({ ...ok, databaseUrl: 'postgres://u:p@127.0.0.1:55432/chatick_next' })).toBe(false)
    expect(devLoginAllowed({ ...ok, databaseUrl: 'postgres://u:p@127.0.0.1:55432/chatick_next?x=_dev' })).toBe(false)
    expect(devLoginAllowed({ ...ok, databaseUrl: 'postgres://chatick_dev:p@127.0.0.1:55432/chatick_next' })).toBe(false)
  })
  it('не с этой машины — нет', () => {
    expect(devLoginAllowed({ ...ok, host: 'api.chatick.com' })).toBe(false)
    expect(devLoginAllowed({ ...ok, host: 'localhost.evil.com' })).toBe(false)
    expect(devLoginAllowed({ ...ok, host: null })).toBe(false)
  })
})
