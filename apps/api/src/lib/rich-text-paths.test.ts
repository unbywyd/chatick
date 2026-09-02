import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Разметка приходит markdown-ом — значит её обязан разобрать КАЖДЫЙ путь записи.
 *
 * Инструменты и гайд просят markdown: рукописный HTML — единственное, что
 * однажды приехало экранированным и легло в базу видимыми тегами, а в markdown
 * экранировать нечего.
 *
 * Но просьба ничего не стоит, если путь записи её не исполняет. Проверено на
 * живых данных: у ассистента в чате три ручки документов писали содержимое в
 * базу СЫРЫМ, без разбора вообще, а заметки и журнал звали sanitizeHtml —
 * тот markdown не понимает и оставил бы «## Заголовок» решёткой.
 *
 * Поэтому сторож смотрит не на текст инструкции, а на код.
 */

// Переносы приводим к \n: файлы в репозитории лежат с CRLF, и срез по
// '\n    },\n' на них не находил бы ничего — сторож молча проходил бы всегда.
const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8').replace(/\r\n/g, '\n')

describe('ассистент в чате разбирает markdown на каждой записи', () => {
  const memory = read('./memory.ts')

  /** Тело ручки: от её имени до начала следующей. */
  function tool(name: string): string {
    const at = memory.indexOf(`    ${name}: async (args) => {`)
    expect(at, `ручка ${name} не найдена`).toBeGreaterThan(-1)
    const next = memory.indexOf('\n    },\n', at)
    expect(next, `конец ручки ${name} не найден`).toBeGreaterThan(at)
    return memory.slice(at, next)
  }

  it.each([
    ['create_document', 'content'],
    ['update_document', 'content'],
    ['append_to_document', 'content'],
    ['update_note', 'body'],
  ])('%s разбирает %s через richText', (name, field) => {
    // Саботаж: вернуть сырую строку (или sanitizeHtml) — markdown ляжет в базу
    // решётками и звёздочками, как и было до правки.
    const body = tool(name)
    expect(body, `${name}: ${field} не проходит richText`).toMatch(/richText\(/)
    expect(body, `${name}: sanitizeHtml не разбирает markdown`).not.toMatch(/sanitizeHtml\(/)
  })

  it('журнал работы тоже разбирается, в обеих ветках', () => {
    // Веток две: дописать открытый черновик и завести новый. Разойдясь, они
    // дали бы человеку журнал, где половина записей — решётки.
    const at = memory.indexOf('write_work_log: async (args) => {')
    expect(at, 'ручка журнала не найдена').toBeGreaterThan(-1)
    const body = memory.slice(at, memory.indexOf('\n    },\n', at))
    const calls = body.match(/richText\(body\)/g) ?? []
    expect(calls.length, 'разобрана не каждая ветка записи').toBe(2)
  })

  it('sanitizeHtml из ассистента убран совсем', () => {
    // Пока он импортирован, следующая ручка снова возьмёт его «по образцу
    // соседней» — так и появились три ручки документов без разбора вовсе.
    expect(memory, 'sanitizeHtml снова в ассистенте').not.toMatch(/\bsanitizeHtml\b/)
  })
})

describe('инструкция просит markdown, а не HTML', () => {
  it('в описаниях инструментов не осталось «content is HTML»', () => {
    // Описание — это и есть команда модели. Пока оно требует HTML, модель
    // пишет теги руками, а рукописные теги она однажды экранирует.
    const mcp = read('../../../mcp/src/index.ts')
    expect(mcp, 'инструмент MCP снова просит HTML').not.toMatch(/is HTML|HTML, like|not markdown/)

    const memory = read('./memory.ts')
    expect(memory, 'ассистент в чате снова просит HTML').not.toMatch(/is HTML|HTML like|Do NOT send markdown/)
  })

  it('гайд моста говорит «пиши markdown»', () => {
    const docs = read('./bridge-docs.ts')
    expect(docs).toMatch(/WRITE MARKDOWN/)
    expect(docs, 'гайд снова предлагает слать HTML').not.toMatch(/content is HTML/)
  })
})
