import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { keepHigherCompanyRole, keepHigherProjectRole } from './role-rank.js'

describe('внешняя система повышает, но не понижает', () => {
  it('не отбирает роль, выданную у нас', () => {
    // Ровно тот случай, из-за которого правило появилось: человека сделали
    // админом в Chatick, Atlas подключает проект и шлёт «участник».
    expect(keepHigherCompanyRole('admin', 'member')).toBe('admin')
    expect(keepHigherCompanyRole('manager', 'member')).toBe('manager')
    expect(keepHigherProjectRole('owner', 'member')).toBe('owner')
    expect(keepHigherProjectRole('admin', 'member')).toBe('admin')
  })

  it('повышение из внешней системы проходит', () => {
    // Обратное направление осмысленно: там человека действительно повысили.
    expect(keepHigherCompanyRole('member', 'admin')).toBe('admin')
    expect(keepHigherCompanyRole('member', 'manager')).toBe('manager')
    expect(keepHigherProjectRole('member', 'admin')).toBe('admin')
    expect(keepHigherProjectRole('admin', 'owner')).toBe('owner')
  })

  it('нового человека заводит с присланной ролью', () => {
    expect(keepHigherCompanyRole(null, 'member')).toBe('member')
    expect(keepHigherCompanyRole(null, 'admin')).toBe('admin')
    expect(keepHigherProjectRole(null, 'admin')).toBe('admin')
  })

  it('неизвестная роль не становится лазейкой для понижения', () => {
    // Мусор из внешней системы не должен снимать админа.
    expect(keepHigherCompanyRole('admin', 'нечто')).toBe('admin')
  })
})

describe('внешний API нигде не перезаписывает роль напрямую', () => {
  const src = readFileSync(new URL('../routes/ext.ts', import.meta.url), 'utf8')

  it('роль в компании проходит через правило', () => {
    // Сторож класса ошибок, а не одной строки: если кто-то добавит новый путь
    // с прямой записью роли, понижение вернётся тихо и незаметно.
    expect(src).toContain('keepHigherCompanyRole')
    expect(src).not.toMatch(/set:\s*\{\s*role:\s*u\.companyRole\s*\}/)
  })

  it('роли в проектах проходят через правило', () => {
    const uses = src.match(/keepHigherProjectRole/g) ?? []
    expect(uses.length).toBeGreaterThanOrEqual(2)
    // Прямая установка присланной роли существующему участнику.
    expect(src).not.toMatch(/\.set\(\{\s*role:\s*[pw]\.role\s*\}\)/)
  })
})
