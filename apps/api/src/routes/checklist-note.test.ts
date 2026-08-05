import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { richText } from '../lib/markdown.js'

// Ответ под пунктом чек-листа.
//
// Пишут его двумя путями: человек в приложении (разметка редактора) и ассистент
// через мост (markdown). Пока разбор стоял только на одном, ответы хранились
// в двух разных видах, и один из них показывался звёздочками наружу.
//
// Читает мост его тоже — но моделью, поэтому наружу отдаём текст: теги в ответе
// она примет за часть ответа.

const tasks = readFileSync(join(import.meta.dirname, 'tasks.ts'), 'utf8')
const bridge = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')

describe('оба пути записи приводят ответ к одному виду', () => {
  it('приложение: и создание, и правка через richText', () => {
    expect(tasks).toMatch(/note: note \? richText\(note\) : ''/)
    expect(tasks).toMatch(/patch\.note = richText\(b\.note\)/)
  })

  it('мост: и создание, и правка через richText', () => {
    expect(bridge).toMatch(/note: typeof x\.note === 'string' \? richText\(/)
    expect(bridge).toMatch(/patch\.note = richText\(b\.note\.slice/)
  })

  it('мост отдаёт ответ текстом, а не разметкой', () => {
    expect(bridge).toMatch(/note: \(r\.item\.note && htmlToText\(r\.item\.note\)\) \|\| undefined/)
  })
})

describe('что получается из типичного ответа ассистента', () => {
  it('markdown становится разметкой, а не остаётся звёздочками', () => {
    const html = richText('**Да**, ключом из App Store Connect')
    expect(html).toContain('<strong>Да</strong>')
    expect(html).not.toContain('**')
  })

  it('ивритский ответ разворачивается вправо', () => {
    expect(richText('כן, צריך מפתח p8')).toContain('dir="rtl"')
  })

  it('пустой ответ остаётся пустым, а не превращается в пустой абзац', () => {
    // Иначе «стёр и ушёл» оставлял бы заметку, которая выглядит пустой, но
    // занимает место в списке и не даёт кнопке «ответить» вернуться под пункт.
    expect(richText('')).toBe('')
    expect(richText('   ')).toBe('')
  })
})

// Кто что может в чек-листе.
//
// Спрашивает один, а знает ответ обычно другой: требовать от него права
// править задачу — значит закрыть единственный путь, ради которого пункт и
// заведён. Но состав списка — другое дело: с одним доступом на чтение
// переписывать содержание задачи нельзя.
describe('права', () => {
  const patchItem = tasks.slice(tasks.indexOf("  '/:taskId/checklist/:itemId',"), tasks.indexOf("tasksRoute.delete('/:taskId/checklist/:itemId'"))
  const order = tasks.slice(tasks.indexOf("  '/:taskId/checklist/order',"), tasks.indexOf("  '/:taskId/checklist/:itemId',"))

  it('видеть задачу достаточно, чтобы дойти до пункта', () => {
    expect(tasks).toMatch(/hasPermission\(projectId, userId, 'tasks\.read'\)/)
  })

  it('отметить и ответить — без tasks.edit', () => {
    // Права проверяются только для text/sortOrder; общей проверки на весь
    // обработчик быть не должно.
    expect(patchItem).toMatch(/b\.text !== undefined \|\| b\.sortOrder !== undefined/)
    expect((patchItem.match(/tasks\.edit/g) ?? []).length).toBe(1)
  })

  it('переписать формулировку — только с tasks.edit', () => {
    expect(patchItem).toMatch(/b\.sortOrder !== undefined\) && !\(await hasPermission\(projectId, sub, 'tasks\.edit'\)\)/)
  })

  it('порядок меняет тот, кто правит задачу', () => {
    expect(order).toMatch(/tasks\.edit/)
  })

  it('перестановка не уносит чужие пункты', () => {
    // Без проверки принадлежности чужой id в списке получил бы номер и уехал
    // в чей-то другой чек-лист.
    expect(order).toMatch(/mine\.has\(itemId\)/)
  })

  it('удалить пункт — только с tasks.edit', () => {
    const del = tasks.slice(tasks.indexOf("tasksRoute.delete('/:taskId/checklist/:itemId'"))
    expect(del.slice(0, 900)).toMatch(/tasks\.edit/)
  })

  it('ручка порядка объявлена ДО ручки пункта — иначе «order» примут за id', () => {
    expect(tasks.indexOf("'/:taskId/checklist/order'")).toBeLessThan(tasks.indexOf("'/:taskId/checklist/:itemId'"))
  })
})
