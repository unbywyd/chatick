import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Ассистент как собеседник, а не диктофон.
//
// Человек описывает решение, а не задачу: «добавь кнопку экспорта» вместо
// «людям нужны данные в Excel». Приняв формулировку как есть, ассистент заводит
// задачу, которую потом переделывают. Но и спорить нельзя — человек пришёл с
// делом, а не за обсуждением.

const disp = readFileSync(join(import.meta.dirname, '../lib/dispatcher.ts'), 'utf8')
const memory = readFileSync(join(import.meta.dirname, '../lib/memory.ts'), 'utf8')
const help = readFileSync(join(import.meta.dirname, '../lib/chatick-help.ts'), 'utf8')

describe('уточняет, но не допрашивает', () => {
  it('просьбу разбирает, а не записывает под диктовку', () => {
    expect(disp).toMatch(/REQUESTS TO BUILD SOMETHING/)
  })

  it('вопросов один-два, и только по существу', () => {
    // «Спроси всё» превращает разговор в анкету, и человек перестаёт просить.
    expect(disp).toMatch(/One or two questions/)
    expect(disp).toMatch(/not everything/)
  })

  it('на понятной просьбе не тормозит', () => {
    // Иначе каждое «поправь опечатку» встречает допросом.
    expect(disp).toMatch(/If the request is already clear, skip this/)
  })
})

describe('спорит ровно один раз', () => {
  it('альтернативу предлагает коротко', () => {
    // Модель склонна выкатывать шесть вариантов — это столь же бесполезно,
    // как соглашаться со всем.
    expect(disp).toMatch(/say so once, briefly/)
  })

  it('после подтверждения делает, что просят', () => {
    // Быть правым насчёт альтернативы стоит меньше, чем быть тем, с кем можно
    // работать.
    expect(disp).toMatch(/Do not argue twice/)
    expect(disp).toMatch(/do the full thing they asked for/)
  })

  it('не расширяет объём сам', () => {
    // «Заодно сделаю ещё вот это» — решение человека, а не ассистента.
    expect(disp).toMatch(/Never expand scope on your own/)
  })
})

describe('знает про сам Chatick', () => {
  it('справка отдаётся инструментом', () => {
    expect(memory).toMatch(/name: 'about_chatick'/)
    expect(memory).toMatch(/about_chatick: async \(\) => CHATICK_HELP/)
  })

  it('в системном промпте её нет', () => {
    // Промпт уходит с КАЖДЫМ сообщением: описание продукта там оплачивалось бы
    // в каждом разговоре о задачах, где оно ни разу не нужно.
    expect(disp).not.toMatch(/CHATICK_HELP/)
    // Упомянут только сам инструмент — одной строкой в перечне.
    expect(disp).toMatch(/about_chatick answers questions about the product/)
  })

  it('справка про то, что человек видит', () => {
    // Спрашивающему нужен ответ «где нажать», а не архитектура.
    for (const word of ['Tasks', 'Files', 'Documents', 'Resources', 'Time', 'Team']) {
      expect(help.includes('**' + word + '**'), word).toBe(true)
    }
  })

  it('объясняет два чата — самое частое непонимание', () => {
    expect(help).toMatch(/Assistant\*\* — private/)
  })
})
