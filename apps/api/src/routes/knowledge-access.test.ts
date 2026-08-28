import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * База знаний принадлежит КОМПАНИИ.
 *
 * Заметки перестали быть журналом одного проекта: знание про Cardcom нужно
 * всем, кто с ним столкнётся, а не только тем, кого позвали в проект, где на
 * него наткнулись первыми.
 *
 * Права проекта отсюда убраны целиком, и это не упрощение ради упрощения: из
 * 104 участников домен notes не ограничил НИ ОДИН. Право существовало, им ни
 * разу не воспользовались, а два источника правды об одном доступе однажды
 * разошлись бы молча — в проекте «нет», в компании «есть», и поди пойми, что
 * сильнее.
 *
 * Опасность здесь тихая: проверка, оставшаяся на правах проекта, откажет в
 * доступе к записи, у которой проекта нет вовсе, — и человек получит
 * «Forbidden» на запись собственной компании.
 */

const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8')
const notes = read('notes.ts')
const bridge = read('bridge.ts')

describe('доступ решает членство в компании', () => {
  it('правило выписано ОДИН раз и переиспользуется', () => {
    // Два одинаковых правила в разных файлах разъедутся на первой правке.
    expect(notes).toMatch(/export async function canUseKnowledge/)
    expect(notes).toMatch(/export async function canEditKnowledge/)
    expect(bridge).toMatch(/canUseKnowledge, canEditKnowledge/)
  })

  it('членства в компании достаточно, чтобы читать и писать', () => {
    const at = notes.indexOf('export async function canUseKnowledge')
    expect(notes.slice(at, at + 300)).toMatch(/companyRoleOf\(companyId, userId\)/)
  })

  it('чужое правит только админ компании', () => {
    const at = notes.indexOf('export async function canEditKnowledge')
    const fn = notes.slice(at, at + 500)
    expect(fn, 'автор не может править своё').toMatch(/authorId === userId\) return true/)
    expect(fn, 'чужое доступно не только админу').toMatch(/=== 'admin'/)
  })
})

describe('прав проекта на заметках не осталось', () => {
  it('в вебе нет ни одной проверки notes.* через проект', () => {
    // Саботаж: вернуть hasPermission(projectId, sub, 'notes.read') — запись
    // без проекта станет недоступна её же автору.
    for (const perm of ['notes.read', 'notes.write', 'notes.delete']) {
      expect(notes, `в notes.ts осталась проверка ${perm}`).not.toContain(`'${perm}'`)
    }
  })

  it('в мосту тоже', () => {
    for (const perm of ['notes.read', 'notes.write', 'notes.delete']) {
      expect(bridge, `в bridge.ts осталась проверка ${perm}`).not.toContain(`'${perm}'`)
    }
  })
})

describe('запись без проекта находится', () => {
  // Прежние ручки искали заметку по projectId. У записи общего правила
  // проекта нет — такой запрос вернул бы «не найдено» на существующую.
  it('веб ищет по компании', () => {
    const patch = notes.slice(notes.indexOf("notesRoute.patch('/:id'"))
    expect(patch.slice(0, 900)).toMatch(/eq\(notes\.companyId, company\)/)
    const del = notes.slice(notes.indexOf("notesRoute.delete('/:id'"))
    expect(del.slice(0, 900)).toMatch(/eq\(notes\.companyId, company\)/)
  })

  it('мост ищет по компании', () => {
    const patch = bridge.slice(bridge.indexOf("bridgeRoute.patch('/notes/:id'"))
    expect(patch.slice(0, 1200)).toMatch(/eq\(notes\.companyId, kbCompany\)/)
    const del = bridge.slice(bridge.indexOf("bridgeRoute.delete('/notes/:id'"))
    expect(del.slice(0, 1200)).toMatch(/eq\(notes\.companyId, kbCompany\)/)
  })
})

describe('типы — про знание, а не про наблюдение', () => {
  it('старых четырёх нет', () => {
    // contradiction, mismatch, gap — свидетельства о разговоре, вне его
    // бессмысленные. reminder перестал быть типом: напомнить можно о чём
    // угодно, для этого есть remindAt.
    const at = notes.indexOf('export const NOTE_TYPES')
    const line = notes.slice(at, notes.indexOf('\n', at))
    for (const gone of ['contradiction', 'mismatch', 'gap', 'reminder']) {
      expect(line, `тип ${gone} остался`).not.toContain(`'${gone}'`)
    }
  })

  it('новые три на месте', () => {
    const at = notes.indexOf('export const NOTE_TYPES')
    const line = notes.slice(at, notes.indexOf('\n', at))
    for (const t of ['bug', 'requirement', 'attention', 'solution']) {
      expect(line, `тип ${t} не заведён`).toContain(`'${t}'`)
    }
  })
})

describe('знание переживает проект', () => {
  it('удаление проекта не уносит записи', () => {
    // Было CASCADE: закрыли проект — исчезло всё, что в нём поняли. Ровно
    // наоборот тому, ради чего база знаний заводится.
    const schema = read('../db/schema.ts')
    const at = schema.indexOf('export const notes = pgTable')
    const block = schema.slice(at, at + 1600)
    expect(block).toMatch(/projectId: text\('project_id'\)\.references\(\(\) => projects\.id, \{ onDelete: 'set null' \}\)/)
    expect(block).toMatch(/companyId: text\('company_id'\)\s*\.notNull\(\)/)
  })
})
