import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { pkceOk, redirectUriOk, redirectWith } from './oauth.js'

describe('PKCE S256', () => {
  const verifier = 'a'.repeat(43)
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  it('верный verifier проходит, чужой — нет', () => {
    expect(pkceOk(verifier, challenge)).toBe(true)
    expect(pkceOk('b'.repeat(43), challenge)).toBe(false)
  })
  it('короткий или с запрещёнными символами — нет', () => {
    expect(pkceOk('short', createHash('sha256').update('short').digest('base64url'))).toBe(false)
    const bad = 'a'.repeat(42) + '!'
    expect(pkceOk(bad, createHash('sha256').update(bad).digest('base64url'))).toBe(false)
  })
})

describe('адрес возврата', () => {
  it('https и localhost — можно', () => {
    expect(redirectUriOk('https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(redirectUriOk('http://localhost:33418/callback')).toBe(true)
    expect(redirectUriOk('http://127.0.0.1:5000/cb')).toBe(true)
  })
  it('http на чужой хост, с фрагментом, мусор — нельзя', () => {
    expect(redirectUriOk('http://evil.com/cb')).toBe(false)
    expect(redirectUriOk('https://claude.ai/cb#x')).toBe(false)
    expect(redirectUriOk('javascript:alert(1)')).toBe(false)
    expect(redirectUriOk('not a url')).toBe(false)
  })
  it('параметры добавляются к существующим', () => {
    expect(redirectWith('https://x.y/cb?a=1', { code: 'c', state: null })).toBe('https://x.y/cb?a=1&code=c')
  })
})
