import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * База знаний на главной компании.
 *
 * До этого попасть в неё можно было только изнутри проекта — то есть выбрав
 * проект, чтобы прочитать знание, которое проекту не принадлежит. Ассистент
 * базой уже пользовался, а человек нет.
 */

const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8')
const start = readFileSync(join(import.meta.dirname, '../../../app/src/screens/StartScreen.tsx'), 'utf8')
const tab = readFileSync(join(import.meta.dirname, '../../../app/src/components/company/KnowledgeTab.tsx'), 'utf8')
const notes = read('notes.ts')

describe('вкладка доступна всем в компании', () => {
  it('она есть у рядового участника, а не только у руководства', () => {
    // Саботаж: убрать 'knowledge' из последней ветки — и база станет видна
    // только админам, ровно вопреки тому, ради чего заводилась.
    const at = start.indexOf('const tabs = isAdmin')
    const block = start.slice(at, at + 700)
    const lines = block.split('\n').filter((l) => l.includes('as const)'))
    expect(lines.length, 'веток набора вкладок не три').toBe(3)
    for (const [i, line] of lines.entries()) {
      expect(line, `в ветке ${i + 1} нет вкладки знаний`).toContain("'knowledge'")
    }
  })

  it('адрес /start/<id>/knowledge открывается напрямую', () => {
    // Иначе ссылкой на базу не поделиться: она откроет «Обзор».
    const at = start.indexOf('const tab = (')
    expect(start.slice(at, at + 400)).toContain("'knowledge'")
  })
})

describe('серверные ручки — по сессии, а не по проекту', () => {
  it('маршрут компании смонтирован', () => {
    const app = read('../app.ts')
    expect(app).toMatch(/app\.route\('\/api\/v1\/company', companyNotesRoute\)/)
  })

  it('доступ — членство в компании, на каждой ручке', () => {
    const at = notes.indexOf('export const companyNotesRoute')
    const block = notes.slice(at)
    // Пять ручек: список, создание, правка, удаление, теги.
    const guards = block.split('kbAccess(').length - 1
    expect(guards, 'не на всех ручках стоит проверка доступа').toBeGreaterThanOrEqual(6)
  })

  it('чужой проект не подсунуть в запись', () => {
    // Иначе запись уехала бы к другой компании, и найти её было бы негде.
    const at = notes.indexOf("companyNotesRoute.post('/:companyId/notes'")
    expect(notes.slice(at, at + 1400)).toMatch(/p\.companyId !== access\.companyId/)
  })

  it('новая запись сразу идёт в индекс поиска', () => {
    const at = notes.indexOf("companyNotesRoute.post('/:companyId/notes'")
    expect(notes.slice(at, at + 2000)).toMatch(/void enqueue\('note'/)
  })
})

describe('экран не ищет на каждую букву', () => {
  it('запрос уходит по Enter, а не на ввод', () => {
    // Поиск по смыслу стоит денег и времени модели: дёргать его на каждый
    // символ значит платить за то, чего человек не просил.
    expect(tab).toMatch(/if \(e\.key === 'Enter'\) setApplied\(q\.trim\(\)\)/)
    expect(tab).toMatch(/queryKey: \['company-notes', companyId, applied/)
  })

  it('найденное по смыслу помечено', () => {
    // Общих слов с запросом может не быть вовсе — без пометки такой ответ
    // выглядит случайным.
    expect(tab).toMatch(/n\.matchedByMeaning &&/)
  })
})

describe('типы одни и те же на клиенте и на сервере', () => {
  it('списки совпадают', () => {
    // Разъедутся — интерфейс предложит тип, который сервер отвергнет.
    const server = notes.match(/export const NOTE_TYPES = \[([^\]]+)\]/)
    const client = readFileSync(
      join(import.meta.dirname, '../../../app/src/components/tabs/NotesTab.tsx'),
      'utf8',
    ).match(/export const NOTE_TYPES = \[([^\]]+)\]/)
    expect(server, 'на сервере нет списка типов').toBeTruthy()
    expect(client, 'на клиенте нет списка типов').toBeTruthy()
    const parse = (m: RegExpMatchArray) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()
    expect(parse(client!)).toEqual(parse(server!))
  })
})
