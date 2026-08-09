import { Extension } from '@tiptap/core'

// Направление текста в блоке.
//
// Автоматики (unicode-bidi: plaintext в index.css) хватает почти всегда: абзац
// берёт направление у своего первого сильного символа. Не хватает её ровно
// там, где сильного символа нет или он не тот: строка из одних цифр, пункт
// списка, начинающийся с латинского названия, заголовок «API» посреди
// ивритского текста. Такое прыгает влево, и поправить это можно только руками.
//
// Поэтому направление — обычный атрибут блока, который человек переключает
// кнопкой. Хранится в HTML как dir="rtl|ltr", то есть переживает сохранение и
// одинаково понимается редактором, режимом чтения и публичной страницей.

const NODES = ['paragraph', 'heading', 'blockquote', 'codeBlock'] as const

// Списки и их пункты — отдельно. Выравнивание текста делает CSS, а вот маркеры
// («1.», точки) слушаются только direction: без него ивритский список выходил
// текстом справа и нумерацией слева. Текст, пришедший через мост, приезжает с
// проставленным dir, а набранный человеком здесь — нет, поэтому по умолчанию
// ставим dir="auto": браузер возьмёт направление у первого сильного символа.
//
// listItem здесь, а не в NODES, именно ради dir="auto" по умолчанию. Список
// со СМЕШАННЫМИ пунктами — четыре ивритских и пятый «heroku ps:scale web=1» —
// иначе разъезжается: список берёт RTL по первому пункту, а unicode-bidi:
// plaintext разворачивает латинский пункт в LTR. Текст уезжает к правому краю,
// маркер остаётся у левого, и между ними пустота во всю ширину — какой номер
// к какой строке, уже не понять. С dir="auto" на пункте маркер едет вместе со
// своим текстом.
const LIST_NODES = ['bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem'] as const

export type TextDir = 'ltr' | 'rtl'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    textDirection: {
      /** Задать направление выделенным блокам; null — вернуть автоматическое */
      setTextDirection: (dir: TextDir | null) => ReturnType
    }
  }
}

export const TextDirection = Extension.create({
  name: 'textDirection',

  addGlobalAttributes() {
    const parse = (el: HTMLElement) => {
      const v = el.getAttribute('dir')
      return v === 'rtl' || v === 'ltr' ? v : null
    }
    return [
      {
        types: [...NODES],
        attributes: {
          dir: {
            default: null,
            parseHTML: parse,
            // null не пишем: пустой атрибут в разметке — мусор, а для
            // автоматического режима он и не нужен.
            renderHTML: (attrs: Record<string, unknown>) => (attrs.dir ? { dir: attrs.dir } : {}),
          },
        },
      },
      {
        types: [...LIST_NODES],
        attributes: {
          dir: {
            default: null,
            parseHTML: parse,
            renderHTML: (attrs: Record<string, unknown>) => ({ dir: attrs.dir ?? 'auto' }),
          },
        },
      },
    ]
  },

  addCommands() {
    return {
      setTextDirection:
        (dir) =>
        ({ state, tr, dispatch }) => {
          const { from, to } = state.selection
          let touched = false
          // Пункт списка правится кнопкой наравне с абзацем: его нет в NODES
          // только потому, что по умолчанию ему нужен dir="auto", а не пустота.
          const editable = [...NODES, 'listItem', 'taskItem'] as readonly string[]
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (!editable.includes(node.type.name)) return
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, dir })
            touched = true
          })
          if (touched && dispatch) dispatch(tr)
          return touched
        },
    }
  },
})

/** Направление блока под курсором: 'ltr' | 'rtl' | null (автоматически). */
export function currentDirection(editor: { state: { selection: { $from: { depth: number; node: (d: number) => { attrs: Record<string, unknown> } } } } }): TextDir | null {
  const $from = editor.state.selection.$from
  for (let d = $from.depth; d > 0; d--) {
    const dir = $from.node(d).attrs?.dir
    if (dir === 'rtl' || dir === 'ltr') return dir
  }
  return null
}
