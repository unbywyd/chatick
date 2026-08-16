import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { searchInText, searchInDocument } from './doc-search.js'

// Поиск внутри документа (SPEC §8.30).
//
// Смещение отвечает на «дай кусок номер N», поиск — на «где здесь про
// авторизацию». Спецификация в 32 тысячи символов иначе читается восемью
// вызовами ради одного абзаца.

const here = import.meta.dirname
const read = (p: string) => readFileSync(join(here, p), 'utf8')

describe('поиск по тексту', () => {
  it('находит без учёта регистра и отдаёт смещение', () => {
    const text = 'a'.repeat(1000) + 'Авторизация по коду' + 'b'.repeat(1000)
    const { matches } = searchInText(text, 'авторизац', 50)
    expect(matches).toHaveLength(1)
    expect(matches[0]!.text).toContain('Авторизация')
    // Смещение — начало ОКРЕСТНОСТИ, с ним же читают дальше.
    expect(matches[0]!.offset).toBe(950)
  })

  it('пустой запрос — не «найти всё»', () => {
    expect(searchInText('что угодно', '   ').matches).toHaveLength(0)
  })

  it('соседние совпадения сливаются в один кусок', () => {
    // Три упоминания в одном абзаце — это один абзац, а не три почти
    // одинаковых куска, за которые платят трижды.
    const text = 'ключ ключ ключ' + 'x'.repeat(500)
    const { matches } = searchInText(text, 'ключ', 100)
    expect(matches).toHaveLength(1)
  })

  it('далёкие совпадения остаются разными', () => {
    const text = 'ключ' + 'x'.repeat(5000) + 'ключ'
    expect(searchInText(text, 'ключ', 100).matches).toHaveLength(2)
  })

  it('самоперекрытие не зацикливает', () => {
    // «аа» внутри «ааааа»: без сдвига на длину слова поиск шёл бы вечно.
    const { matches } = searchInText('а'.repeat(50), 'аа', 40)
    expect(matches.length).toBeGreaterThan(0)
  })

  it('говорит, когда показал не всё', () => {
    // Молча показанные двадцать из сорока читаются как «больше нигде».
    const text = Array.from({ length: 40 }, (_, i) => 'ключ' + 'x'.repeat(500 + i)).join('')
    expect(searchInText(text, 'ключ', 50).truncated).toBe(true)
    expect(searchInText('ключ один раз', 'ключ', 50).truncated).toBe(false)
  })

  it('многоточие только там, где текст правда обрезан', () => {
    const { matches } = searchInText('ключ в самом начале', 'ключ', 40)
    expect(matches[0]!.text.startsWith('…')).toBe(false)
  })
})

describe('поиск в документе', () => {
  it('ищет по тексту, а не по разметке', () => {
    // Иначе совпадение попадает внутрь тега, а окрестность выходит из HTML.
    const html = '<p>Мы выбрали <strong>OTP</strong> вместо Google</p>'
    const { matches } = searchInDocument(html, 'otp', 40)
    expect(matches).toHaveLength(1)
    expect(matches[0]!.text).not.toContain('<strong>')
  })

  it('искать можно то, что разорвано тегом', () => {
    // «авторизация» в вёрстке может быть разбита на два элемента; по HTML
    // такое не находится вовсе.
    const html = '<p>автори<em>зация</em> по коду</p>'
    expect(searchInDocument(html, 'авторизация', 40).matches).toHaveLength(1)
  })

  it('total — длина текста, а не HTML', () => {
    // С ней сверяется offset, который мы отдаём, и по ней дочитывают.
    const html = '<p>' + 'a'.repeat(100) + '</p>'
    expect(searchInDocument(html, 'a', 10).total).toBe(100)
  })
})

describe('поиск доведён до всех трёх мест', () => {
  it('ручка ищет и внутри документа, и по всем сразу', () => {
    const src = read('../routes/bridge.ts')
    expect(src).toMatch(/searchInDocument\(d\.content, q/)
    // Список ищет и по содержимому: угадать заголовок по памяти выходит редко.
    expect(src).toMatch(/ilike\(documents\.content, `%\$\{q\}%`\)/)
  })

  it('поиск идёт ДО чтения кусками', () => {
    // Иначе он никогда не сработает: обычное чтение вернёт ответ раньше.
    const src = read('../routes/bridge.ts')
    const from = src.indexOf("bridgeRoute.get('/documents/:id'")
    const block = src.slice(from, src.indexOf('bridgeRoute.', from + 20))
    const search = block.indexOf('searchInDocument')
    const chunk = block.indexOf("query('format')")
    expect(search, 'поиск на месте').toBeGreaterThan(-1)
    expect(chunk, 'чтение кусками на месте').toBeGreaterThan(-1)
    expect(search).toBeLessThan(chunk)
  })

  it('ассистент в UI умеет то же самое', () => {
    const src = read('./memory.ts')
    expect(src).toMatch(/searchInDocument\(d\.content, q/)
    // И знает об этом: без описания в схеме параметр не будет использован.
    expect(src).toMatch(/find this text inside the document/)
  })

  it('права проверяются и при поиске', () => {
    // Поиск — то же чтение: обойти им documents.read нельзя.
    const src = read('./memory.ts')
    const from = src.indexOf('read_document: async')
    const block = src.slice(from, src.indexOf('start_timer:', from))
    const perm = block.indexOf("'documents.read'")
    const search = block.indexOf('searchInDocument')
    // Оба ДОЛЖНЫ быть на месте: indexOf возвращает -1, когда проверки нет, а
    // -1 меньше любого числа — сравнение прошло бы и без неё.
    expect(perm, 'проверка прав на месте').toBeGreaterThan(-1)
    expect(search, 'поиск на месте').toBeGreaterThan(-1)
    expect(perm).toBeLessThan(search)
  })
})

describe('оглавление в контексте', () => {
  const src = read('./memory.ts')

  it('документы и журнал попадают в контекст', () => {
    // Про историю чата оглавление было, про документы — ничего: ассистент не
    // знал, что они есть, и отвечал по чату, не открыв документ с ответом.
    expect(src).toMatch(/DOCUMENTS in this project/)
    expect(src).toMatch(/PROJECT JOURNAL/)
    // Существования функции мало — она должна быть ВЫЗВАНА из сборки
    // контекста и попасть в parts. Иначе оглавление есть в коде и нет в ответе.
    const fn = src.slice(src.indexOf('export async function buildMemoryContext'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toMatch(/await buildIndexContext\(projectId\)/)
    expect(body).toMatch(/parts\.push\(''\s*,\s*index\)/)
  })

  it('в контекст идут заголовки, а не содержимое', () => {
    // 32 тысячи символов в каждом запросе — дорого и бесполезно. Длину берём
    // из SQL, чтобы не возить содержимое ради length.
    const fn = src.slice(src.indexOf('async function buildIndexContext'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toMatch(/length\(\$\{documents\.content\}\)/)
    expect(body).not.toMatch(/content: documents\.content/)
  })

  it('оглавление ограничено по количеству', () => {
    // В проекте на сто документов оглавление само стало бы стеной текста.
    expect(src).toMatch(/INDEX_LIMIT/)
    const fn = src.slice(src.indexOf('async function buildIndexContext'))
    // И говорит, что показал не всё, — иначе двенадцать из тридцати читаются
    // как «это всё, что есть».
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toMatch(/and older ones/)
  })

  it('удалённое в оглавление не попадает', () => {
    const fn = src.slice(src.indexOf('async function buildIndexContext'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toMatch(/isNull\(documents\.deletedAt\)/)
    expect(body).toMatch(/isNull\(notes\.deletedAt\)/)
  })
})
