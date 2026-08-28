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

describe('поиск по умолчанию смотрит на всю компанию', () => {
  // Умолчание «только этот проект» осталось от времён, когда заметки были
  // журналом проекта. Оно прятало ровно то, ради чего база заводилась:
  // решение, найденное в соседнем проекте.
  it('мост ищет по компании, если не сказано иначе', () => {
    const at = bridge.indexOf("bridgeRoute.get('/notes'")
    const fn = bridge.slice(at, at + 2500)
    // Два места, и оба должны смотреть на компанию: прямой отбор без запроса
    // и гибридный поиск с запросом. Первая версия этой проверки смотрела
    // только на первое — и саботаж, вернувший старое умолчание в гибридный
    // поиск, прошёл мимо.
    expect(fn, 'прямой отбор не по компании').toMatch(/conds\.push\(eq\(notes\.companyId, kbCompany\)\)/)
    expect(fn, 'сужение до проекта не по scope=project').toMatch(/scope'\) === 'project'/)
    expect(fn, 'гибридный поиск сузили до проекта по умолчанию').toMatch(/companyWide: c\.req\.query\('scope'\) !== 'project'/)
  })

  it('внутренний ассистент — так же', () => {
    const memory = read('../lib/memory.ts')
    const at = memory.indexOf('const hybrid = await searchNoteIds({')
    expect(memory.slice(at, at + 500)).toMatch(/!== 'project'/)
  })

  it('условия по notes.scope нигде не осталось', () => {
    // Поле осталось от прежнего устройства и больше ничего не значит. Пока
    // оно стояло в отборе, запись, созданная из проекта (scope='project'), не
    // находилась НИКОГДА — даже с ?scope=company.
    const lib = read('../lib/embeddings.ts')
    for (const [src, who] of [[bridge, 'мост'], [lib, 'помощник поиска']] as const) {
      expect(src, `${who} всё ещё отбирает по notes.scope`).not.toMatch(/eq\(notes\.scope, 'company'\)/)
    }
  })

  it('ассистентам сказано про новое умолчание', () => {
    const memory = read('../lib/memory.ts')
    const mcp = readFileSync(join(import.meta.dirname, '../../../mcp/src/index.ts'), 'utf8')
    for (const [src, who] of [[memory, 'ассистент'], [mcp, 'MCP']] as const) {
      expect(src, `${who} не объясняет умолчание`).toMatch(/WHOLE COMPANY by default/)
    }
  })
})

describe('переключателя прав на заметки нет нигде', () => {
  // Он остался бы враньём: человек ставит «Нет», думая, что закрыл доступ, а
  // записи всё равно видны — их даёт членство в компании. Хуже отсутствия
  // настройки только настройка, которая ничего не делает.
  it('домена notes нет в правах проекта', () => {
    const projects = read('projects.ts')
    const at = projects.indexOf('export const PERMISSION_DOMAINS')
    const line = projects.slice(at, projects.indexOf('\n', at))
    expect(line, 'домен notes вернулся в права проекта').not.toContain("'notes'")
  })

  it('и в интерфейсе команды проекта', () => {
    const tab = readFileSync(
      join(import.meta.dirname, '../../../app/src/components/tabs/ProjectTeamTab.tsx'),
      'utf8',
    )
    const at = tab.indexOf('const DOMAINS')
    const line = tab.slice(at, tab.indexOf('\n', at))
    expect(line, 'переключатель заметок вернулся в интерфейс').not.toContain("'notes'")
  })

  it('и действий notes.* не осталось', () => {
    const projects = read('projects.ts')
    for (const perm of ['notes.read', 'notes.write', 'notes.delete']) {
      expect(projects, `право ${perm} вернулось`).not.toContain(`'${perm}'`)
    }
  })
})
