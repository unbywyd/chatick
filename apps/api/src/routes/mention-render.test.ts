import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Упоминание должно становиться живым узлом и в HTML, и в markdown.
 *
 * Формат @[Имя](id) хранится в базе одинаково для всех текстов. Всё, что
 * пишет ИИ, приходит уже размеченным HTML — и такой текст выходил из
 * markdownToHtml строкой «return md» ДО замены упоминаний. В результате
 * человек видел в комментарии сырое «@[Hadeel Massarwa](-3j8w…)», а при
 * нажатии «редактировать» — ту же разметку буквально.
 *
 * Само уведомление при этом уходило: механизм упоминаний работал, ломалось
 * только отображение.
 */

const editor = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/ui/rich-editor.tsx'),
  'utf8',
).replace(/\r\n/g, '\n')

describe('упоминания превращаются в узлы', () => {
  it('замена вынесена в одну функцию', () => {
    // Правило, выписанное дважды, однажды разойдётся: в markdown упоминание
    // станет узлом, а в HTML останется текстом — ровно это и было.
    //
    // Саботаж: вернуть вторую копию replace — тест падает.
    expect(editor, 'общей функции нет').toContain('function restoreMentions(html: string): string')
    const copies = (editor.match(/data-type="mention" data-id="\$2"/g) ?? []).length
    expect(copies, 'замена продублирована').toBe(1)
  })

  it('готовый HTML тоже проходит через неё', () => {
    // Ветка «это уже HTML» выходила раньше замены — из-за неё всё и ломалось.
    //
    // Саботаж: вернуть `return md` — тест падает.
    expect(editor, 'HTML возвращается без восстановления упоминаний').toContain(
      'if (looksLikeHtml(md)) return restoreMentions(md)',
    )
    expect(editor, 'осталась ветка без обработки').not.toMatch(/if \(looksLikeHtml\(md\)\) return md$/m)
  })

  it('markdown-ветка использует ту же функцию', () => {
    // Саботаж: вернуть inline-replace — тест падает (см. проверку на копии).
    expect(editor, 'markdown-ветка не использует общую функцию').toContain('b = restoreMentions(b)')
  })

  it('id упоминания сохраняется', () => {
    // Без id узел становится просто текстом: человек не подхватится, и
    // уведомление при следующей правке не уйдёт.
    const at = editor.indexOf('function restoreMentions')
    expect(editor.slice(at, at + 400), 'id не переносится в узел').toContain('data-id="$2"')
    expect(editor.slice(at, at + 400), 'подпись не переносится').toContain('data-label="$1"')
  })
})
