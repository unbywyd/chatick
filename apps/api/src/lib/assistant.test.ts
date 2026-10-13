import { describe, expect, it } from 'vitest'
import { companyTools, EXCLUDED_TOOLS, linkMentions, pickProject, projectTools, type Ctx } from './assistant.js'
import { memoryTools } from './memory.js'

const projects = [
  { id: 'p1', name: 'Atlas', color: '#000', logoUrl: null, companyId: 'c' },
  { id: 'p2', name: 'Start Plan', color: '#000', logoUrl: null, companyId: 'c' },
]
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ companyId: 'c', userId: 'u', screen: {}, projects, used: [], ...over })

describe('ассистент компании ничего не удаляет', () => {
  // Единственное исключение — заметки: базу знаний ведёт в основном сам ИИ, и
  // владелец решил (13.10.2026), что удалять их он может. Удаление мягкое.
  const ALLOWED = new Set(['delete_note'])
  it('каждый delete_* инструмент ИИ проекта исключён, кроме заметок', () => {
    // Сторож: новый удаляющий инструмент в memory.ts не должен молча стать
    // доступен ассистенту компании.
    const deleting = memoryTools('', 'u').tools.map((t) => t.name).filter((n) => /^delete_|_delete$|remove/.test(n))
    expect(deleting.length).toBeGreaterThan(0)
    for (const n of deleting) if (!ALLOWED.has(n)) expect(EXCLUDED_TOOLS.has(n), n).toBe(true)
  })
  it('в наборе ассистента их нет, кроме удаления заметки', () => {
    const names = [...projectTools(ctx()).tools, ...companyTools(ctx()).tools].map((t) => t.name)
    expect(names.filter((n) => n.startsWith('delete_') && !ALLOWED.has(n))).toEqual([])
    expect(names).toContain('delete_note')
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

describe('open_on_screen — ассистент открывает экраны', () => {
  it('есть у ассистента компании', () => {
    expect(companyTools(ctx()).tools.map((t) => t.name)).toContain('open_on_screen')
  })
  it('раздел — только из списка: адрес не собирается из слов модели', async () => {
    const h = companyTools(ctx()).handlers.open_on_screen!
    expect(await h({ what: 'section', section: '../../logout' })).toMatch(/^Unknown section/)
    expect(await h({ what: 'whatever', id: 'x' })).toMatch(/^Unknown target/)
    expect(await h({ what: 'task' })).toMatch(/Pass the task id/)
  })
  it('незнакомый проект для раздела — переспросить, а не открыть', async () => {
    const h = companyTools(ctx()).handlers.open_on_screen!
    expect(await h({ what: 'section', section: 'docs', project: 'Нет такого' })).toMatch(/No project/)
  })
})

describe('open_on_screen new_task — черновик, а не создание', () => {
  it('названный, но незнакомый проект — переспросить', async () => {
    const h = companyTools(ctx()).handlers.open_on_screen!
    expect(await h({ what: 'new_task', title: 'x', project: 'Нет такого' })).toMatch(/No project/)
  })
  it('без открытого приложения — ничего не создаётся, предлагает создать напрямую', async () => {
    const h = companyTools(ctx()).handlers.open_on_screen!
    expect(await h({ what: 'new_task', title: 'Проверить сборку' })).toMatch(/nothing was opened/)
  })
})

describe('linkMentions — «@Имя» ассистента становится упоминанием', () => {
  const team = [
    { id: 'u1', name: 'Hadeel Massarwa' },
    { id: 'u2', name: 'Daniel Regev' },
    { id: 'u3', name: 'Daniel Cohen' },
    { id: 'u4', name: 'Артём Горловецкий' },
  ]
  it('однозначное имя и полное имя', () => {
    expect(linkMentions('@Hadeel глянь', team)).toBe('@[Hadeel Massarwa](u1) глянь')
    expect(linkMentions('cc @Daniel Regev, пожалуйста', team)).toBe('cc @[Daniel Regev](u2), пожалуйста')
    expect(linkMentions('@артём проверь', team)).toBe('@[Артём Горловецкий](u4) проверь')
  })
  it('неоднозначное и чужое — остаётся текстом', () => {
    expect(linkMentions('@Daniel привет', team)).toBe('@Daniel привет')
    expect(linkMentions('@Someone', team)).toBe('@Someone')
  })
  it('почта и готовые упоминания не трогаются', () => {
    expect(linkMentions('пиши на hadeel@mail.com', team)).toBe('пиши на hadeel@mail.com')
    expect(linkMentions('@[Hadeel Massarwa](u1) ок', team)).toBe('@[Hadeel Massarwa](u1) ок')
  })
  it('у ассистента есть список команды с id', () => {
    expect(companyTools(ctx()).tools.map((t) => t.name)).toContain('project_team')
  })
})
