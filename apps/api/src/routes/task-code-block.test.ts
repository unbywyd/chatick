import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Блоки кода в описаниях задач, комментариях и заметках.
//
// Ассистент оформляет примеры оградой ```js. Редактор ждёт HTML, и для него
// ограда — обычные символы: в карточке она виднелась текстом, при правке блок
// не собирался, а язык терялся при сохранении.
//
// Конвертер markdown→HTML в файле БЫЛ, но его забыли вызвать: объявлен и не
// используется. Отсюда и симптом.

const editor = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/ui/rich-editor.tsx'),
  'utf8',
)

describe('markdown доезжает до редактора', () => {
  it('конвертер вызывается во всех трёх местах', () => {
    // Их именно три: начальное содержимое при создании редактора и два
    // setContent — для чтения и для правки. Пропуск любого means: в одном
    // режиме блок есть, в другом кавычки. Так и было — правка отставала от
    // просмотра, потому что content при создании остался без разбора.
    const calls = editor.match(/markdownToHtml\(withInlineImageAuth\(value\)\)/g) ?? []
    expect(calls.length, 'ожидались 3 вызова конвертера').toBe(3)
  })

  it('конвертер не остаётся мёртвым кодом', () => {
    // Саботаж: убрать вызовы — функция снова объявлена и не используется,
    // ровно как было до правки.
    const declared = editor.includes('function markdownToHtml')
    const used = /markdownToHtml\(/.test(editor.replace('function markdownToHtml', ''))
    expect(declared && used, 'markdownToHtml объявлена, но не вызывается').toBe(true)
  })
})

describe('ограда превращается в блок кода', () => {
  it('язык переносится в class="language-*"', () => {
    // Так его понимает и tiptap, и подсветка. Без класса блок получался бы
    // серым, а язык терялся при первом сохранении.
    expect(editor).toMatch(/class="language-/)
  })

  it('код вынимается до остальной разметки', () => {
    // Внутри кода звёздочки и подчёркивания значат код, а не курсив. Без
    // изъятия блоков inline-замены калечили содержимое примеров.
    const at = editor.indexOf('const codeBlocks')
    expect(at, 'изъятие блоков не найдено').toBeGreaterThan(-1)
    const inlineAt = editor.indexOf('<strong>$1</strong>')
    expect(at, 'блоки вынимаются после inline-замен').toBeLessThan(inlineAt)
  })

  it('заглушка снимается вместе с обёрткой абзаца', () => {
    // Иначе <pre> оказался бы внутри <p> — недопустимая разметка, и браузер
    // разрывает её сам, ломая блок.
    const at = editor.indexOf('const restore')
    expect(at).toBeGreaterThan(-1)
    expect(editor.slice(at, at + 400)).toMatch(/<p>/)
  })
})

describe('подсветка и язык при сохранении', () => {
  it('редактор подсвечивает код', () => {
    expect(editor).toMatch(/CodeBlockLowlight/)
    // Общий набор, а не полный: полный тянет сотни килобайт ради языков,
    // которых в задачах не бывает.
    expect(editor).toMatch(/createLowlight\(common\)/)
  })

  it('стандартный блок выключен в обоих пресетах', () => {
    // Два узла codeBlock — и tiptap не собирает редактор вовсе.
    const cfg = editor.slice(editor.indexOf('StarterKit.configure('), editor.indexOf('Placeholder.configure'))
    const offs = cfg.match(/codeBlock: false/g) ?? []
    expect(offs.length, 'codeBlock выключен не во всех пресетах').toBe(2)
  })

  it('язык возвращается в ограду при сериализации', () => {
    // Иначе правка описания незаметно стирала бы язык.
    const at = editor.indexOf("node.type === 'codeBlock'")
    expect(at).toBeGreaterThan(-1)
    expect(editor.slice(at, at + 500)).toMatch(/node\.attrs\?\.language/)
  })
})
