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
