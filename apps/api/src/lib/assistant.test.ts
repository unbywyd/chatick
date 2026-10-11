import { describe, expect, it } from 'vitest'
import { companyTools, EXCLUDED_TOOLS, pickProject, projectTools, type Ctx } from './assistant.js'
import { memoryTools } from './memory.js'

const projects = [
  { id: 'p1', name: 'Atlas', color: '#000', logoUrl: null, companyId: 'c' },
  { id: 'p2', name: 'Start Plan', color: '#000', logoUrl: null, companyId: 'c' },
]
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ companyId: 'c', userId: 'u', screen: {}, projects, used: [], ...over })

describe('ассистент компании ничего не удаляет', () => {
  it('каждый delete_* инструмент ИИ проекта исключён', () => {
    // Сторож: новый удаляющий инструмент в memory.ts не должен молча стать
    // доступен ассистенту компании.
    const deleting = memoryTools('', 'u').tools.map((t) => t.name).filter((n) => /^delete_|_delete$|remove/.test(n))
    expect(deleting.length).toBeGreaterThan(0)
    for (const n of deleting) expect(EXCLUDED_TOOLS.has(n), n).toBe(true)
  })
  it('в наборе ассистента их нет', () => {
    const names = [...projectTools(ctx()).tools, ...companyTools(ctx()).tools].map((t) => t.name)
    expect(names.filter((n) => n.startsWith('delete_'))).toEqual([])
  })
})

describe('проектные инструменты', () => {
  it('у каждого есть параметр project, остальная схема та же', () => {
    const base = new Map(memoryTools('', 'u').tools.map((t) => [t.name, t]))
    for (const t of projectTools(ctx()).tools) {
      const props = (t.parameters as { properties: Record<string, unknown> }).properties
      expect(props.project ?? props.target_project, t.name).toBeDefined()
      const orig = (base.get(t.name)!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
      for (const k of Object.keys(orig)) expect(props[k], `${t.name}.${k}`).toEqual(orig[k])
    }
  })
  it('имена не пересекаются с инструментами компании', () => {
    const p = new Set(projectTools(ctx()).tools.map((t) => t.name))
    for (const t of companyTools(ctx()).tools) expect(p.has(t.name), t.name).toBe(false)
  })
})

describe('pickProject', () => {
  const id = (r: ReturnType<typeof pickProject>) => (typeof r === 'string' ? `ERR` : r.id)
  it('по id и по имени', () => {
    expect(id(pickProject(ctx(), 'p2'))).toBe('p2')
    expect(id(pickProject(ctx(), 'atlas'))).toBe('p1')
    expect(id(pickProject(ctx(), 'StartPlan'))).toBe('p2')
  })
  it('без имени — открытый на экране', () => {
    expect(id(pickProject(ctx({ screen: { projectId: 'p2' } }), undefined))).toBe('p2')
  })
  it('чужой проект на экране не берётся', () => {
    expect(id(pickProject(ctx({ screen: { projectId: 'foreign' } }), undefined))).toBe('ERR')
  })
  it('не открыт и проектов несколько — переспросить со списком', () => {
    const r = pickProject(ctx(), undefined)
    expect(typeof r).toBe('string')
    expect(r as string).toMatch(/Which project/)
    expect(r as string).toContain('Atlas (p1)')
  })
  it('единственный проект — он', () => {
    expect(id(pickProject(ctx({ projects: [projects[0]!] }), undefined))).toBe('p1')
  })
  it('не из своих — отказ со списком', () => {
    expect(pickProject(ctx(), 'Nope') as string).toMatch(/No project "Nope"/)
  })
})
