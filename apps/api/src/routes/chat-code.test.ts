import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Код в чате: блок, язык, подсветка.
//
// Ошибка здесь не роняет ничего — она просто тихо съедает язык, и человек
// решает, что «формат не поддерживается», хотя всё почти работает.

const composer = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/chat/Composer.tsx'),
  'utf8',
)
const codeBlock = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/chat/CodeBlock.tsx'),
  'utf8',
)
const chat = readFileSync(join(import.meta.dirname, '../../../app/src/components/chat/ChatPanel.tsx'), 'utf8')
const css = readFileSync(join(import.meta.dirname, '../../../app/src/index.css'), 'utf8')

describe('язык доезжает до получателя', () => {
  it('сериализация берёт язык из атрибута узла', () => {
    // Саботаж: вернуть голые кавычки — и ```js снова превратится в ```,
    // отправитель укажет язык, а получатель увидит серый текст.
    const at = composer.indexOf("node.type === 'codeBlock'")
    expect(at, 'ветка codeBlock не найдена').toBeGreaterThan(-1)
    const body = composer.slice(at, at + 700)
    expect(body).toMatch(/node\.attrs\?\.language/)
    expect(body).toMatch(/\+ lang \+/)
  })

  it('блок без языка по-прежнему отправляется', () => {
    // Пустая строка вместо языка, а не undefined: иначе в сообщение уехало бы
    // ```undefined и подсветка сломалась бы на ровном месте.
    const at = composer.indexOf("node.type === 'codeBlock'")
    expect(composer.slice(at, at + 700)).toMatch(/: ''/)
  })
})

describe('подсветка в наборе', () => {
  it('стандартный блок заменён на подсвечивающий', () => {
    expect(composer).toMatch(/CodeBlockLowlight/)
    // Без выключения в StarterKit было бы два узла codeBlock, и tiptap
    // ругается на дубль — редактор просто не собрался бы.
    expect(composer).toMatch(/codeBlock: false/)
  })

  it('грамматики — общий набор, а не все подряд', () => {
    // Полный набор тянет в сборку сотни килобайт ради языков, которые в чат
    // никто не пришлёт.
    expect(composer).toMatch(/createLowlight\(common\)/)
    expect(composer).not.toMatch(/createLowlight\(all\)/)
  })

  it('экземпляр создаётся один раз на модуль', () => {
    // Внутри компонента он пересобирал бы грамматики на каждое нажатие клавиши.
    const at = composer.indexOf('createLowlight(common)')
    const before = composer.slice(0, at)
    expect(before).toMatch(/^const lowlight = $|const lowlight = $/m)
  })
})

describe('подсветка у получателя', () => {
  it('лента сообщений рисует код своим компонентом', () => {
    // Подсветка при наборе без подсветки в ленте читается как поломка.
    expect(chat).toMatch(/components=\{\{ code: CodeBlock \}\}/)
  })

  it('строчный код не уезжает в блок', () => {
    // ReactMarkdown зовёт тот же компонент и для `x = 1` внутри предложения:
    // без разделения фраза рвалась бы пополам блоком на всю ширину.
    expect(codeBlock).toMatch(/const isInline/)
    expect(codeBlock).toMatch(/!code\.includes\('\\n'\)/)
  })

  it('незнакомый язык не ломает вывод', () => {
    // ```кракозябра должен показаться как текст, а не уронить сообщение.
    expect(codeBlock).toMatch(/lowlight\.registered\(lang\)/)
    expect(codeBlock).toMatch(/catch/)
  })

  it('код всегда слева направо', () => {
    // Внутри ивритского сообщения направление наследуется от абзаца, и код
    // без явного dir читался бы задом наперёд.
    expect(codeBlock).toMatch(/dir="ltr"/)
  })

  it('содержимое не превращается в разметку', () => {
    // Своим обходом узлов, без dangerouslySetInnerHTML: сообщение пишет
    // человек, и оно не должно становиться HTML.
    // Ищем ВЫЗОВ, а не упоминание: в комментарии рядом объясняется, почему
    // его тут нет, и проверка на голое слово ловила бы собственный текст.
    expect(codeBlock).not.toMatch(/dangerouslySetInnerHTML=\{/)
  })

  it('классы подсветки покрашены', () => {
    // lowlight расставляет hljs-*, но без правил они не красят ничего —
    // и подсветка выглядит отсутствующей, хотя разметка на месте.
    expect(css).toMatch(/\.hljs-comment/)
    expect(css).toMatch(/\.hljs-keyword/)
    expect(css).toMatch(/\.dark \.hljs-string/)
  })
})

describe('кнопка, которую видно', () => {
  it('блок кода вызывается из панели', () => {
    // Раньше он был доступен только тем, кто знает про три обратные кавычки.
    expect(composer).toMatch(/toggleCodeBlock\(\)/)
  })

  it('строчный код остался отдельной кнопкой', () => {
    // Две разные вещи: `x` внутри фразы и блок на несколько строк.
    expect(composer).toMatch(/toggleCode\(\)/)
  })
})
