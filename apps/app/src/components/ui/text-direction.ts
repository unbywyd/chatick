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

const NODES = ['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock'] as const

// Списки — отдельно. Выравнивание текста внутри пункта делает CSS, а вот
// маркеры («1.», точки) слушаются только direction самого списка: без него
// ивритский список выходил текстом справа и нумерацией слева. Текст, пришедший
// через мост, приезжает с проставленным dir, а набранный человеком здесь — нет,
// поэтому спискам по умолчанию ставим dir="auto": браузер возьмёт направление
// у первого сильного символа списка сам.
const LIST_NODES = ['bulletList', 'orderedList', 'taskList'] as const

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
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (!NODES.includes(node.type.name as (typeof NODES)[number])) return
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
