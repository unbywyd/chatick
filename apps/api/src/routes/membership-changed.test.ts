import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Человек узнаёт о смене своих прав сразу, а не при следующем входе в проект.
 *
 * Роль и права клиент держит в кэше карточки проекта. Сервер менял их молча:
 * человека сделали админом, а кнопок «Подключить Expo» и «Новая версия» у него
 * нет — и беготня по вкладкам не помогает, кэш никто не просил обновиться.
 * Помогало только выйти из проекта и зайти снова.
 *
 * Правило: каждое место, меняющее project_members или company_members ДРУГОГО
 * человека, зовёт membershipChanged (ws.ts). Мест таких много — экран команды,
 * мост ассистента, внешняя система, — поэтому проверяется обходом, а не списком.
 */

const ROUTES = join(import.meta.dirname)
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const ws = read(join(ROUTES, '../ws.ts'))
const app = (p: string) => read(join(ROUTES, '../../../app/src', p))

const routeFiles = readdirSync(ROUTES)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => ({ name: f, src: read(join(ROUTES, f)) }))

/** Все вхождения записи в таблицы состава: [файл, позиция, следующие 700 знаков]. */
function writes(pattern: RegExp): { file: string; at: number; after: string; stmt: string }[] {
  const out = []
  for (const f of routeFiles) {
    for (const m of f.src.matchAll(pattern)) {
      const at = m.index!
      out.push({ file: f.name, at, after: f.src.slice(at, at + 700), stmt: f.src.slice(at, at + 320) })
    }
  }
  return out
}

/**
 * Запись про себя самого оповещения не требует: человек сам нажал «выйти» или
 * сам завёл проект, его окно и так знает. Узнаём по тому, чей id в запросе.
 */
const aboutSelf = (stmt: string) => /\bsub\b|id\.userId/.test(stmt)

describe('сервер оповещает о смене прав', () => {
  it('membershipChanged шлёт событие человеку и закрывает сокеты исключённого', () => {
    expect(ws).toContain('export function membershipChanged(')
    expect(ws).toContain("sendToUserAnywhere(userId, 'membership_changed', { projectId: scope.projectId, companyId: scope.companyId })")
    // Исключённый иначе продолжал получать чат проекта по открытому соединению.
    expect(ws).toMatch(/if \(!scope\.removed\) return[\s\S]{0,400}c\.ws\.close\(4003, 'forbidden'\)/)
    // Сессионный сокет не трогаем: уведомления человеку по-прежнему положены.
    expect(ws).toContain('if (!c.projectId) continue')
  })

  it('добавление и исключение из проекта или компании — с оповещением', () => {
    const found = writes(/\.(?:insert|delete)\((?:projectMembers|companyMembers)\)/g)
    // Пустой обход дал бы ложный зелёный.
    expect(found.length, 'записи в таблицы состава не найдены').toBeGreaterThan(8)
    const silent = found.filter((w) => !aboutSelf(w.stmt) && !w.after.includes('membershipChanged('))
    // Саботаж: убрать вызов после любого delete — тест называет файл и место.
    expect(silent.map((w) => `${w.file}: ${w.stmt.split('\n')[0]!.trim()}`)).toEqual([])
  })

  it('смена роли — с оповещением', () => {
    const found = writes(/\.set\(\{ role[,:]/g)
    expect(found.length, 'смены роли не найдены').toBeGreaterThanOrEqual(3)
    const silent = found.filter((w) => !w.after.includes('membershipChanged('))
    expect(silent.map((w) => `${w.file}: ${w.stmt.split('\n')[0]!.trim()}`)).toEqual([])
  })

  it('смена через общий patch (мост, компания) — с оповещением', () => {
    // Там роль едет в составе patch, и шаблон выше её не видит.
    const bridge = routeFiles.find((f) => f.name === 'bridge.ts')!.src
    expect(bridge).toContain('if (patch.role !== undefined) membershipChanged(userId, { companyId })')
    expect(bridge).toContain(
      'if (patch.role !== undefined || patch.permissions !== undefined) membershipChanged(userId, { projectId: scope.projectId })',
    )
    const companies = routeFiles.find((f) => f.name === 'companies.ts')!.src
    expect(companies).toContain('if (role !== undefined) membershipChanged(userId, { companyId })')
    // Права (не роль) в проекте — отдельная ручка.
    const projects = routeFiles.find((f) => f.name === 'projects.ts')!.src
    expect(projects).toMatch(/membershipChanged\(userId, \{ projectId \}\)\n\s*return c\.json\(\{ ok: true, domains: next/)
  })
})

describe('клиент слышит событие', () => {
  it('общий сокет перечитывает списки и зовёт хук открытого проекта', () => {
    const sys = app('hooks/useSystemNotifications.ts')
    expect(sys).toContain("if (event === 'membership_changed') {")
    expect(sys).toContain('window.dispatchEvent(new CustomEvent(MEMBERSHIP_EVENT, { detail: payload }))')
    // Шапка компании и список проектов тоже зависят от роли.
    for (const key of ['projects', 'sidebar-projects', 'companies']) expect(sys).toContain(`'${key}'`)
  })

  it('хук проекта перезапрашивает кэш проекта и перепроверяет доступ', () => {
    const hook = app('hooks/useProjectAccess.ts')
    expect(hook).toContain('window.addEventListener(MEMBERSHIP_EVENT, onMembership)')
    // Событие про другой проект не трогает открытый.
    expect(hook).toContain('if (scope?.projectId && scope.projectId !== projectId) return')
    // Роль — в кэше карточки проекта: без перезапроса кнопки не появятся.
    expect(hook).toMatch(/refetchProjectCache\(qc\)\n\s*void check\(projectId, true\)/)
  })
})
