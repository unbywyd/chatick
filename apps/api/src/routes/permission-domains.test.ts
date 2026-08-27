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
    expect(src).toMatch(/z\s*\.object\(\s*Object\.fromEntries\(PERMISSION_DOMAINS/)
  })

  it('у каждой роли уровень задан для КАЖДОГО домена', () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      const perms = defaultDomainPermissions(role)
      for (const d of PERMISSION_DOMAINS) {
        expect(perms[d], `${role}: домен ${d} без уровня`).toBeTruthy()
      }
    }
  })

  it('участник ПИШЕТ во всех областях, а удаляет только начальство', () => {
    // Ресурсы и версии стояли на чтении — «секреты заводит начальство»,
    // «выкатка — ответственность». Упиралось это в того же человека, который
    // и делает работу: добавил интеграцию и идёт просить админа записать ключ.
    // Просьба не защищает, а откладывает.
    //
    // Настоящая граница — удаление: стереть чужой секрет или релиз
    // необратимо, а создать нет. Она и осталась за админами.
    const member = defaultDomainPermissions('member')
    for (const d of PERMISSION_DOMAINS) {
      expect(member[d], `участник не пишет в ${d}`).toBe('write')
    }
    const admin = defaultDomainPermissions('admin')
    for (const d of PERMISSION_DOMAINS) {
      expect(admin[d], `админ не полный в ${d}`).toBe('crud')
    }
  })
  /**
   * Четвёртое место с тем же списком — MCP-сервер. Он отдельный пакет и
   * импортировать PERMISSION_DOMAINS не может, поэтому список там продублирован.
   *
   * Дубль без сторожа — это та же история с releases, только через границу
   * пакета: домен добавят на сервере, в инструменте забудут, и ассистент
   * просто не сможет выставить по нему уровень. Молча, без единой ошибки.
   */
  it('MCP-инструмент знает ТЕ ЖЕ домены, что и сервер', () => {
    const mcp = readFileSync(join(import.meta.dirname, '../../../mcp/src/index.ts'), 'utf8')
    const list = mcp.match(/const PERMISSION_DOMAINS = \[([^\]]+)\] as const/)
    expect(list, 'в MCP не нашёлся список доменов').toBeTruthy()
    const inMcp = [...(list as RegExpMatchArray)[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])
    expect(inMcp.slice().sort()).toEqual([...PERMISSION_DOMAINS].sort())
  })

  it('MCP-инструмент строит схему из списка, а не перечисляет домены руками', () => {
    const mcp = readFileSync(join(import.meta.dirname, '../../../mcp/src/index.ts'), 'utf8')
    expect(mcp).toMatch(/z\s*\.object\(\s*Object\.fromEntries\(PERMISSION_DOMAINS/)
  })

  it('MCP умеет менять не только роль', () => {
    // Ручка принимает уровни, должность и зону ответственности, а инструмент
    // долго слал одну role: ассистент ЧИТАЛ права полностью и не мог поменять.
    const mcp = readFileSync(join(import.meta.dirname, '../../../mcp/src/index.ts'), 'utf8')
    const tool = mcp.slice(
      mcp.indexOf("'chatick_member_role'"),
      mcp.indexOf("'chatick_member_remove'"),
    )
    for (const field of ['permissions', 'jobTitle', 'responsibility']) {
      expect(tool, `chatick_member_role не пробрасывает ${field}`).toContain(field)
    }
  })
  /**
   * Пятое место — гайд моста, по которому ассистент работает без MCP.
   *
   * Тут расхождение уже жило: releases в списке гайда не было, и ассистент
   * со скилом просто не знал, что таким уровнем можно управлять. Гайд —
   * не комментарий, а рабочая инструкция; устаревший, он врёт человеку.
   */
  it('гайд моста перечисляет ВСЕ домены', () => {
    const docs = readFileSync(join(import.meta.dirname, '../lib/bridge-docs.ts'), 'utf8')
    const line = docs.match(/Permission levels per domain \(([^)]+)\)/)
    expect(line, 'в гайде не нашлась строка про уровни по доменам').toBeTruthy()
    const listed = (line as RegExpMatchArray)[1].split(',').map((d) => d.trim())
    expect(listed.slice().sort()).toEqual([...PERMISSION_DOMAINS].sort())
  })
})
