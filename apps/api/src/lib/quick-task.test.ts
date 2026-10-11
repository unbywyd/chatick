import { describe, expect, it } from 'vitest'
import { matchPerson, matchProject, parseQuick } from './quick-task.js'

describe('parseQuick', () => {
  it('название, @кто и #проект в любом месте строки', () => {
    expect(parseQuick('сверстать шапку @Элиша #Atlas')).toEqual({ title: 'сверстать шапку', people: ['Элиша'], projects: ['Atlas'] })
    expect(parseQuick('@Алекс #StartPlan поправить отступы')).toEqual({ title: 'поправить отступы', people: ['Алекс'], projects: ['StartPlan'] })
  })
  it('кавычки — для имён с пробелом; знаки препинания на конце токена отрезаются', () => {
    expect(parseQuick('проверить @"Артём Ч" #"Start Plan", срочно')).toEqual({ title: 'проверить, срочно', people: ['Артём Ч'], projects: ['Start Plan'] })
    expect(parseQuick('отдать @Хадиль.')).toEqual({ title: 'отдать', people: ['Хадиль'], projects: [] })
  })
  it('почта и номер не считаются токенами', () => {
    expect(parseQuick('написать на a@b.com про баг #12')).toEqual({ title: 'написать на a@b.com про баг #12', people: [], projects: [] })
  })
  it('одинокий @ или # не попадает в название', () => {
    expect(parseQuick('@я #').title).toBe('')
  })
  it('без токенов — всё название', () => {
    expect(parseQuick('  просто   задача ')).toEqual({ title: 'просто задача', people: [], projects: [] })
  })
})

const people = [
  { id: 'a', name: 'Алекс Петров', email: 'alex@x.com' },
  { id: 'b', name: 'Александра Ким', email: 'sasha@x.com' },
  { id: 'c', name: 'Элиша', email: 'elisha@x.com' },
  { id: 'me', name: 'Artyom', email: 'unbywyd@x.com' },
]

describe('matchPerson', () => {
  const pick = (t: string) => {
    const r = matchPerson(t, people, 'me')
    return r.ok ? r.value.id : `${r.reason}:${r.candidates.map((x) => x.id).join(',')}`
  }
  it('точное имя побеждает префикс', () => {
    expect(pick('Алекс')).toBe('a')
    expect(pick('алекспетров')).toBe('a')
  })
  it('неоднозначный префикс — спросить', () => {
    expect(pick('Ал')).toBe('ambiguous:a,b')
  })
  it('по почте, по фамилии, ё = е, себе', () => {
    expect(pick('sasha')).toBe('b')
    expect(pick('Ким')).toBe('b')
    expect(pick('я')).toBe('me')
    expect(pick('me')).toBe('me')
    expect(pick('Эли')).toBe('c')
  })
  it('кириллица находит латинские имена', () => {
    const latin = [
      { id: 'e', name: 'Elisha Cohen', email: 'e@x.com' },
      { id: 'a', name: 'Alex', email: 'a@x.com' },
      { id: 't', name: 'Artyom', email: 't@x.com' },
      { id: 'h', name: 'Hadil', email: 'h@x.com' },
    ]
    const r = (t: string) => {
      const m = matchPerson(t, latin, 'none')
      return m.ok ? m.value.id : m.reason
    }
    expect(r('Элиша')).toBe('e')
    expect(r('Алекс')).toBe('a')
    expect(r('Артём')).toBe('t')
    expect(r('Хадиль')).toBe('h')
  })
  it('нет такого — none', () => {
    expect(pick('Боб')).toBe('none:')
  })
})

describe('matchProject', () => {
  const projects = [
    { id: '1', name: 'Atlas' },
    { id: '2', name: 'Start Plan' },
    { id: '3', name: 'Start Plan Mobile' },
  ]
  const pick = (t: string) => {
    const r = matchProject(t, projects)
    return r.ok ? r.value.id : r.reason
  }
  it('точное, без пробелов, префикс, ambiguous', () => {
    expect(pick('atlas')).toBe('1')
    expect(pick('StartPlan')).toBe('2')
    expect(pick('Mobile')).toBe('3')
    expect(pick('Start')).toBe('ambiguous')
    expect(pick('nope')).toBe('none')
  })
})
