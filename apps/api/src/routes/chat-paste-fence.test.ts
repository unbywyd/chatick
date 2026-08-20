import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Вставка готового markdown-блока в композер: ```js … ```
//
// Расширение tiptap это само не разбирает: его input-правило срабатывает на
// НАБОР кавычек, а обработчик вставки — только на копию из VS Code. Обычный
// markdown (из переписки, из README, из ответа ассистента) оставался текстом,
// и кавычки было видно внутри блока.

const composer = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/chat/Composer.tsx'),
  'utf8',
)

/** Само выражение из кода — проверяем то, что работает, а не его копию. */
function fenceRe(): RegExp {
  const m = composer.match(/const fence = text\?\.trim\(\)\.match\((\/.+\/)\)/)
  expect(m, 'разбор ограды в handlePaste не найден').toBeTruthy()
  // eslint-disable-next-line no-eval
  return eval(m![1]) as RegExp
}

describe('ограда снимается при вставке', () => {
  const re = fenceRe()
  const grab = (s: string) => s.trim().match(re)

  it('язык берётся из ограды', () => {
    const m = grab('```js\nconst x = 1\n```')
    expect(m?.[1]).toBe('js')
    expect(m?.[2]).toBe('const x = 1')
  })

  it('блок без языка тоже разбирается', () => {
    expect(grab('```\nconst x = 1\n```')?.[1]).toBe('')
  })

  it('отступы и пустые строки сохраняются', () => {
    // Ради этого всё и затевалось: вставленный код не должен «поплыть».
    expect(grab('```js\nif (x) {\n    deep()\n}\n```')?.[2]).toBe('if (x) {\n    deep()\n}')
    expect(grab('```js\na\n\nb\n```')?.[2]).toBe('a\n\nb')
  })

  it('язык с дефисом — это язык', () => {
    expect(grab('```objective-c\nint x;\n```')?.[1]).toBe('objective-c')
  })

  it('ограда внутри строки кода не мешает', () => {
    expect(grab('```js\nconst s = "a ``` b"\n```')?.[2]).toBe('const s = "a ``` b"')
  })
})

describe('чужое не трогаем', () => {
  const re = fenceRe()
  const grab = (s: string) => s.trim().match(re)

  it('два блока подряд не склеиваются', () => {
    // Иначе кавычки между ними становились строкой кода, а второй язык терялся.
    expect(grab('```js\na\n```\n```py\nb\n```')).toBeNull()
  })

  it('код вперемешку с текстом остаётся markdown-документом', () => {
    // Превратить это в один блок значило бы съесть текст вокруг.
    expect(grab('Смотри:\n```js\nconst x = 1\n```')).toBeNull()
    expect(grab('```js\nconst x = 1\n```\nвот так')).toBeNull()
  })

  it('обычный код без ограды вставляется как есть', () => {
    expect(grab('const x = 1\nfunction f() {}')).toBeNull()
  })
})

describe('вставку не теряем', () => {
  it('внутри блока кода ограда ничего не значит', () => {
    // Там это обычные символы, и перехват сломал бы вставку в сам блок.
    expect(composer).toMatch(/const inCode = .*'codeBlock'/)
    expect(composer).toMatch(/fence && !inCode/)
  })

  it('перехватываем только когда есть куда положить', () => {
    // preventDefault ДО проверки означал бы молча съеденную вставку.
    const at = composer.indexOf('const codeBlockType')
    const pd = composer.indexOf('event.preventDefault()', at)
    const cond = composer.indexOf('fence && !inCode', at)
    expect(cond, 'условие не найдено').toBeGreaterThan(-1)
    expect(cond, 'preventDefault раньше проверки').toBeLessThan(pd)
    expect(composer).toMatch(/fence && !inCode && codeBlockType/)
  })
})
