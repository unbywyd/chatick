import { describe, it, expect } from 'vitest'
import { extractMentions } from './notify.js'

// Разбор упоминаний.
//
// Здесь была тихая ошибка, дорого стоившая: распознавался только формат
// `@[Имя](id)`, которым пишут ассистенты, а редактор в вебе сохраняет
// упоминание span'ом с data-id. Полгода ни одно упоминание, поставленное
// человеком из интерфейса, никого не уведомляло. Ошибки при этом не возникало
// нигде — список получателей просто выходил пустым, и люди ждали ответа на
// вопрос, о котором адресат не узнавал.
//
// Поэтому оба формата проверяются на реальной разметке, а не на выдуманной.

describe('extractMentions', () => {
  it('понимает разметку редактора (веб)', () => {
    // Скопировано из базы: комментарий, из-за которого всё и вскрылось.
    const html =
      '<p><span class="mention" data-type="mention" data-id="KgoAzmnH2QL5oS_S6P76H"' +
      ' data-label="Artyom" data-mention-suggestion-char="@">@Artyom</span> מה המסוף שלהם?</p>'
    expect(extractMentions(html)).toEqual(['KgoAzmnH2QL5oS_S6P76H'])
  })

  it('понимает разметку ассистентов (мост)', () => {
    expect(extractMentions('глянь, @[Elisha Cohen](abc123)')).toEqual(['abc123'])
  })

  it('видит оба формата в одном тексте', () => {
    const both = '<span data-type="mention" data-id="X">@A</span> и @[B](Y)'
    expect(extractMentions(both).sort()).toEqual(['X', 'Y'])
  })

  it('не зависит от порядка атрибутов', () => {
    // У разных редакторов порядок свой; жёсткая строка сломалась бы молча.
    expect(extractMentions('<span data-id="Z" data-type="mention">@Z</span>')).toEqual(['Z'])
  })

  it('берёт несколько упоминаний и не дублирует', () => {
    const html =
      '<span data-type="mention" data-id="A">@A</span>' +
      '<span data-type="mention" data-id="B">@B</span>' +
      '<span data-type="mention" data-id="A">@A</span>'
    expect(extractMentions(html).sort()).toEqual(['A', 'B'])
  })

  it('@ai — это диспетчер, а не человек', () => {
    expect(extractMentions('@[AI](ai) <span data-type="mention" data-id="ai">@ai</span>')).toEqual([])
  })

  it('почта в тексте упоминанием не считается', () => {
    // Реальный случай: адрес внутри блока кода принимали бы за адресата.
    expect(extractMentions('<pre><code>unbywyd@gmail.com | he</code></pre>')).toEqual([])
  })

  it('обычный текстовый @Имя никого не упоминает', () => {
    // Так и задумано: без id непонятно, кто именно имеется в виду. Но это
    // ровно та ловушка, из-за которой ассистентам объясняют формат отдельно.
    expect(extractMentions('привет @Artyom, глянь')).toEqual([])
  })

  it('чужой span за упоминание не принимается', () => {
    expect(extractMentions('<span class="mention" data-id="X">@X</span>')).toEqual([])
  })
})
