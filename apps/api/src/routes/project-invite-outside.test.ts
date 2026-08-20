import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Приглашение в проект человека, которого нет в компании.
//
// Раньше на это уходило четыре шага с ожиданием посередине: пригласить в
// компанию → ждать, пока примет → вернуться в проект → добавить. Между вторым
// и третьим стояло ожидание, которым руководитель не управляет.

const route = readFileSync(join(import.meta.dirname, 'projects.ts'), 'utf8')
const companies = readFileSync(join(import.meta.dirname, 'companies.ts'), 'utf8')
const tab = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/tabs/ProjectTeamTab.tsx'),
  'utf8',
)

describe('приглашение несёт с собой проект', () => {
  it('форма проекта передаёт projectId', () => {
    // Без него человек попадёт в компанию и застрянет там: в проект его
    // придётся добавлять вторым заходом — ровно то, что убираем.
    const at = tab.indexOf('const invite = useMutation(')
    expect(at, 'мутация приглашения не найдена').toBeGreaterThan(-1)
    expect(tab.slice(at, at + 600)).toMatch(/projectId/)
  })

  it('сервер исполняет намерение при приёме', () => {
    // Механизм был и раньше — до него просто нельзя было дотянуться из
    // проекта. Проверяем, что он на месте.
    expect(companies).toMatch(/if \(invite\.projectId\)/)
  })

  it('проект принимается только из своей компании', () => {
    // Иначе приглашение стало бы способом раздать доступ куда угодно.
    expect(companies).toMatch(/p\?\.companyId === companyId/)
  })
})

describe('приглашённого видно сразу', () => {
  it('есть ручка приглашённых в проект', () => {
    // Без неё приглашение выглядит как «ничего не произошло»: нажал, а
    // команда осталась прежней.
    expect(route).toMatch(/projectsRoute\.get\('\/:projectId\/invites'/)
  })

  it('отдаём только ждущие и только этого проекта', () => {
    const at = route.indexOf("projectsRoute.get('/:projectId/invites'")
    const body = route.slice(at, at + 1200)
    expect(body).toMatch(/eq\(companyInvites\.projectId, projectId\)/)
    expect(body).toMatch(/eq\(companyInvites\.status, 'pending'\)/)
  })

  it('список закрыт для посторонних', () => {
    // Адреса почты — не публичные данные проекта.
    //
    // Ищем САМУ проверку членства, а не слово «Forbidden» в широком окне:
    // оно встречается и в соседних ручках, и проверка проходила даже с
    // вырезанным условием — то есть не ловила то, ради чего написана.
    const at = route.indexOf("projectsRoute.get('/:projectId/invites'")
    const body = route.slice(at, route.indexOf('return c.json(rows)', at))
    expect(body).toMatch(/if \(!membership && !canCreateProjects/)
    expect(body).toMatch(/Forbidden/)
  })

  it('приглашённые показаны отдельно от участников', () => {
    // Вперемешку они обещали бы доступ, которого пока нет.
    expect(tab).toMatch(/projTeam\.pendingTitle/)
    expect(tab).toMatch(/invites\.data/)
  })

  it('после приглашения список обновляется', () => {
    const at = tab.indexOf('const refresh = ()')
    expect(tab.slice(at, at + 300)).toMatch(/project-invites/)
  })
})

describe('одно поле на два действия', () => {
  it('«пригласить» появляется только на похожем на адрес', () => {
    // Иначе кнопка висела бы под каждым неудачным поиском по имени.
    expect(tab).toMatch(/const isEmail =/)
    expect(tab).toMatch(/isEmail && !inCompany/)
  })

  it('своего из компании зовём не приглашением, а кнопкой', () => {
    // Он уже принят — приглашать его второй раз бессмысленно.
    expect(tab).toMatch(/const inCompany =/)
  })

  it('роль одна на компанию и проект', () => {
    // Два вопроса там, где человек решает один.
    const at = tab.indexOf('const invite = useMutation(')
    expect(tab.slice(at, at + 600)).toMatch(/role/)
  })
})
