import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PERMISSION_DOMAINS, defaultDomainPermissions } from './projects.js'

// Домены прав должны совпадать в трёх местах: список, схема разбора тела и
// права по умолчанию. Разъезжаются они молча.
//
// Так и вышло с releases: домен добавили в список и в умолчания, а в zod-схему
// забыли. Незнакомое поле zod выбрасывает без ошибки, ручка отвечала ok:true,
// уровень не менялся. Интерфейс показывал успех, база оставалась прежней.

const src = readFileSync(join(import.meta.dirname, 'projects.ts'), 'utf8')

describe('домены прав', () => {
  it('схема тела запроса собирается из списка, а не повторяет его руками', () => {
    // Именно повторение руками и разъехалось. Проверяем не текст схемы, а то,
    // что она выводится из PERMISSION_DOMAINS.
    expect(src).toMatch(/z\.object\(\s*Object\.fromEntries\(PERMISSION_DOMAINS/)
  })

  it('у каждой роли уровень задан для КАЖДОГО домена', () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      const perms = defaultDomainPermissions(role)
      for (const d of PERMISSION_DOMAINS) {
        expect(perms[d], `${role}: домен ${d} без уровня`).toBeTruthy()
      }
    }
  })

  it('участник видит версии, но не правит их', () => {
    // Смотреть идут все — за этим вкладка и нужна; заводить и двигать стадии
    // должно начальство проекта.
    expect(defaultDomainPermissions('member').releases).toBe('read')
    expect(defaultDomainPermissions('admin').releases).toBe('crud')
  })
})
