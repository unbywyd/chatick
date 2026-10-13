import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseMoved } from './moved-companies.js'

describe('компании, которые переехали', () => {
  it('читает список и адрес из настройки площадки', () => {
    const m = parseMoved('{"c1":{"url":"https://tasks.startplan.net"},"c2":{}}')
    expect(m.get('c1')).toEqual({ url: 'https://tasks.startplan.net' })
    expect(m.get('c2')).toEqual({ url: null })
    expect(m.has('c3')).toBe(false)
  })

  it('кривое значение — никто не переехал, список компаний не падает', () => {
    expect(parseMoved('').size).toBe(0)
    expect(parseMoved('not json').size).toBe(0)
    expect(parseMoved('["c1"]').size).toBe(0)
  })

  it('в ссылку баннера идёт только http(s)', () => {
    expect(parseMoved('{"c1":{"url":"javascript:alert(1)"}}').get('c1')).toEqual({ url: null })
  })

  it('список компаний отдаёт признак moved', () => {
    const src = readFileSync(join(import.meta.dirname, '../routes/companies.ts'), 'utf8')
    const at = src.indexOf("companiesRoute.get('/'")
    expect(src.slice(at, at + 2600)).toMatch(/moved: moved\.get\(m\.company\.id\) \?\? null/)
  })
})
