import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Объявление компании.
 *
 * «Завтра отдыхаем», «изменили политику» — то, что не выросло ни из задачи,
 * ни из проекта. Такое писали в мессенджер, а через неделю никто не помнил,
 * кому написали и дошло ли.
 *
 * Две опасности. Первая: право рассылать НЕОТКЛЮЧАЕМОЕ сообщение всей
 * компании — это право, а не удобство; ослабив проверку, мы отдадим его
 * каждому. Вторая: объявление, прошедшее через обычный notify, было бы
 * отфильтровано по членству в проекте и отпискам — то есть дошло бы не до
 * всех, и молча.
 */

const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8')
const lib = read('announce.ts')
const bridge = read('../routes/bridge.ts')
const memory = read('memory.ts')

describe('рассылать может только админ компании', () => {
  it('мост проверяет роль', () => {
    const at = bridge.indexOf("bridgeRoute.post('/announce'")
    expect(at, 'ручки нет').toBeGreaterThan(-1)
    const fn = bridge.slice(at, at + 2000)
    expect(fn).toMatch(/companyRoleOf\(companyId, id\.userId\)\) !== 'admin'/)
  })

  it('внутренний ассистент — тоже', () => {
    const at = memory.indexOf('announce: async (args)')
    expect(at, 'инструмента нет').toBeGreaterThan(-1)
    expect(memory.slice(at, at + 1500)).toMatch(/companyRoleOf\(project\.companyId, actorUserId\)\) !== 'admin'/)
  })

  it('отказ объясняет ПОЧЕМУ, а не просто отказывает', () => {
    // «Forbidden» без причины толкает ассистента пробовать снова другим
    // способом; сказанная причина закрывает вопрос.
    const at = bridge.indexOf("bridgeRoute.post('/announce'")
    expect(bridge.slice(at, at + 2000)).toMatch(/cannot be turned off/)
  })
})

describe('объявление доходит до всех', () => {
  it('идёт мимо notify — там членство в проекте и отписки', () => {
    // notify() фильтрует по участию В ПРОЕКТЕ и уважает отписки. Человек без
    // проектов объявление обязан получить, а отписаться от «завтра отдыхаем»
    // нельзя — иначе это перестаёт быть объявлением.
    expect(lib).not.toMatch(/from '\.\/notify\.js'/)
    expect(lib).toMatch(/await db\.insert\(notifications\)\.values\(rows\)/)
  })

  it('получатели берутся из КОМПАНИИ, а не из проектов', () => {
    const at = lib.indexOf('export async function resolveRecipients')
    const fn = lib.slice(at, at + 1500)
    expect(fn).toMatch(/\.from\(companyMembers\)/)
    expect(fn).toMatch(/eq\(companyMembers\.companyId, companyId\)/)
  })

  it('поимённо — только своих', () => {
    // Чужой id в списке отправил бы объявление компании человеку со стороны.
    const at = lib.indexOf('export async function resolveRecipients')
    const fn = lib.slice(at, at + 1800)
    expect(fn).toMatch(/inArray\(companyMembers\.userId, target\.userIds\)/)
  })

  it('автору себе не шлём', () => {
    const at = lib.indexOf('export async function resolveRecipients')
    expect(lib.slice(at, at + 1800)).toMatch(/filter\(\(id\) => id !== actorId\)/)
  })
})

describe('три способа адресации', () => {
  it('компания, проект, поимённо', () => {
    for (const kind of ["'company'", "'project'", "'users'"]) {
      expect(lib, `нет способа ${kind}`).toContain(kind)
    }
  })

  it('проверяется, что проект той же компании', () => {
    // Иначе объявление ушло бы команде чужой компании.
    const at = bridge.indexOf("bridgeRoute.post('/announce'")
    expect(bridge.slice(at, at + 2500)).toMatch(/p\.companyId !== companyId/)
  })
})

describe('письмо — по флагу, а не всегда', () => {
  it('по умолчанию не шлём', () => {
    // «Завтра отдыхаем» стоит письма, «в пятницу пицца» — вряд ли. Решает
    // тот, кто пишет: только он знает срочность.
    expect(lib).toMatch(/if \(input\.email\) \{/)
  })

  it('сбой письма не теряет объявление', () => {
    // Оно уже в приложении — сорванная отправка не повод терять его целиком.
    const at = lib.indexOf('if (input.email)')
    expect(lib.slice(at, at + 1200)).toMatch(/catch \(err\) \{/)
  })

  it('в письме сказано, что отписаться нельзя', () => {
    // Иначе человек будет искать настройку, которой нет.
    expect(lib).toMatch(/не отключаются/)
  })
})

describe('объявление видно в сводке инбокса', () => {
  it('ветка есть и стоит первой', () => {
    // «Завтра отдыхаем» важнее комментария — в сводке оно не должно тонуть.
    const at = bridge.indexOf('const INBOX_BRANCHES')
    const block = bridge.slice(at, at + 1200)
    expect(block).toMatch(/kind: 'announcements'/)
    expect(block.indexOf("'announcements'")).toBeLessThan(block.indexOf("'mentions'"))
  })
})

describe('уведомление живёт без проекта', () => {
  it('в схеме projectId необязателен, companyId есть', () => {
    const schema = read('../db/schema.ts')
    const at = schema.indexOf('export const notifications = pgTable')
    const block = schema.slice(at, at + 1600)
    expect(block).toMatch(/projectId: text\('project_id'\)\.references/)
    expect(block).not.toMatch(/projectId: text\('project_id'\)\.notNull\(\)/)
    expect(block).toMatch(/companyId: text\('company_id'\)\.references/)
  })

  it('счётчики по проектам не спотыкаются о пустой проект', () => {
    // Объявления в разбивку по проектам не идут — им там не место.
    const projects = read('../routes/projects.ts')
    expect(projects).toMatch(/if \(r\.projectId\) unread\.set/)
  })
})
