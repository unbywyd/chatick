import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useEditor, EditorContent, ReactRenderer } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { PluginKey } from '@tiptap/pm/state'
import Placeholder from '@tiptap/extension-placeholder'
import Mention from '@tiptap/extension-mention'
import type { SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion'
import tippy, { type Instance } from 'tippy.js'
import { TextDirection } from '@/components/ui/text-direction'
import { useLivePlaceholder, useRepaintPlaceholder } from '../livePlaceholder'
import { letterOf, personColor, projectColor, shortProject } from '../util'

export type Pick = { id: string; label: string; color?: string | null; logoUrl?: string | null; kind: 'person' | 'project' }
export type QuickInputHandle = {
  clear: () => void
  focus: () => void
  /** Поставить метку проекта или человека (null — снять): выбор из чипа над строкой. */
  setPick: (kind: 'person' | 'project', pick: { id: string; label: string } | null) => void
}

type Doc = { type?: string; text?: string; attrs?: { id?: string; label?: string }; content?: Doc[] }

/**
 * Строка в формате сервера: люди и проекты из списка уходят в кавычках —
 * `@"Имя Фамилия"`, `#"Проект"`, — тогда пробелы в именах не ломают разбор.
 */
function serialize(doc: Doc): string {
  const walk = (n: Doc): string => {
    if (n.type === 'text') return n.text ?? ''
    if (n.type === 'person') return `@"${n.attrs?.label ?? ''}"`
    if (n.type === 'project') return `#"${n.attrs?.label ?? ''}"`
    return (n.content ?? []).map(walk).join(n.type === 'doc' ? ' ' : '')
  }
  return walk(doc).replace(/\s+/g, ' ').trim()
}

type ListProps = { items: Pick[]; command: (p: { id: string; label: string }) => void; empty: string }
type ListRef = { onKeyDown: (p: SuggestionKeyDownProps) => boolean }

/** Выпадающий список подсказок — в стиле выбора проекта таймера. */
const SuggestList = forwardRef<ListRef, ListProps>(function SuggestList({ items, command, empty }, ref) {
  const [i, setI] = useState(0)
  useEffect(() => setI(0), [items])
  const pick = (k: number) => {
    const it = items[k]
    if (it) command({ id: it.id, label: it.label })
  }
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (!items.length) return false
      if (event.key === 'ArrowDown') {
        setI((x) => (x + 1) % items.length)
        return true
      }
      if (event.key === 'ArrowUp') {
        setI((x) => (x + items.length - 1) % items.length)
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        pick(i)
        return true
      }
      return false
    },
  }))
  return (
    <div className="qsug" role="listbox">
      {items.map((it, k) => (
        <button key={it.id} className={'gp' + (k === i ? ' sel' : '')} role="option" aria-selected={k === i} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(k)}>
          {it.kind === 'project' ? (
            it.logoUrl ? (
              <span className="logo sm" style={{ overflow: 'hidden', padding: 0 }}>
                <img src={it.logoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </span>
            ) : (
              <span className="logo sm" style={{ background: projectColor({ id: it.id, color: it.color ?? null }) }}>
                {letterOf(it.label)}
              </span>
            )
          ) : (
            <span className="av" style={{ background: personColor(it.id) }}>
              {letterOf(it.label)}
            </span>
          )}
          <span className="nm">{it.kind === 'project' ? shortProject(it.label) : it.label}</span>
        </button>
      ))}
      {!items.length && <div className="cbx-none">{empty}</div>}
    </div>
  )
})

/** Подсказка по символу: @ — люди, # — проекты. */
function suggest(name: 'person' | 'project', char: string, source: () => Pick[], empty: () => string, open: React.MutableRefObject<number>) {
  return Mention.extend({ name }).configure({
    HTMLAttributes: { class: `qchip q-${name}` },
    renderText: ({ node }) => `${char}${node.attrs.label}`,
    renderHTML: ({ node, options }) => ['span', options.HTMLAttributes, `${char}${node.attrs.label}`],
    suggestion: {
      // Свой ключ на каждый символ: с общим ключом второй список (#) глушится первым (@).
      pluginKey: new PluginKey(`suggest-${name}`),
      char,
      allowSpaces: false,
      items: ({ query }) => {
        const q = query.toLowerCase()
        return source()
          .filter((p) => !q || p.label.toLowerCase().includes(q))
          .slice(0, 8)
      },
      render: () => {
        let comp: ReactRenderer<ListRef, ListProps> | null = null
        let pop: Instance[] = []
        return {
          onStart: (props: SuggestionProps<Pick>) => {
            open.current++
            comp = new ReactRenderer(SuggestList, { props: { ...props, empty: empty() }, editor: props.editor })
            pop = tippy('body', {
              getReferenceClientRect: props.clientRect as () => DOMRect,
              appendTo: () => document.querySelector('.app') ?? document.body,
              content: comp.element,
              showOnCreate: true,
              interactive: true,
              trigger: 'manual',
              placement: 'bottom-start',
            })
          },
          onUpdate: (props: SuggestionProps<Pick>) => {
            comp?.updateProps({ ...props, empty: empty() })
            pop[0]?.setProps({ getReferenceClientRect: props.clientRect as () => DOMRect })
          },
          onKeyDown: (props: SuggestionKeyDownProps) => {
            if (props.event.key === 'Escape') {
              pop[0]?.hide()
              return true
            }
            return comp?.ref?.onKeyDown(props) ?? false
          },
          onExit: () => {
            open.current = Math.max(0, open.current - 1)
            pop[0]?.destroy()
            comp?.destroy()
          },
        }
      },
    },
  })
}

/**
 * Быстрая строка: «что сделать @кому #проект». Однострочный tiptap — ради
 * подсказок: по @ выпадают люди компании, по # — проекты, выбранное
 * становится плашкой. Enter создаёт (когда список подсказок закрыт).
 */
export const QuickInput = forwardRef<
  QuickInputHandle,
  { placeholder: string; people: Pick[]; projects: Pick[]; emptyPeople: string; emptyProjects: string; onChange: (text: string) => void; onSubmit: () => void; onEscape: () => void }
>(function QuickInput(p, ref) {
  const peopleRef = useRef(p.people)
  const projectsRef = useRef(p.projects)
  const textsRef = useRef({ people: p.emptyPeople, projects: p.emptyProjects })
  const handlers = useRef(p)
  peopleRef.current = p.people
  projectsRef.current = p.projects
  textsRef.current = { people: p.emptyPeople, projects: p.emptyProjects }
  handlers.current = p
  const open = useRef(0)
  const ph = useLivePlaceholder(p.placeholder)

  const editor = useEditor({
    extensions: [
      // Одна строка текста: всё оформление выключено, остаются документ, абзац и текст.
      StarterKit.configure({
        bold: false,
        italic: false,
        strike: false,
        code: false,
        codeBlock: false,
        heading: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        horizontalRule: false,
        hardBreak: false,
        link: false,
        underline: false,
        trailingNode: false,
      }),
      TextDirection,
      Placeholder.configure({ placeholder: ph }),
      suggest('person', '@', () => peopleRef.current, () => textsRef.current.people, open),
      suggest('project', '#', () => projectsRef.current, () => textsRef.current.projects, open),
    ],
    editorProps: {
      attributes: { class: 'qed', 'aria-label': p.placeholder },
      handleKeyDown: (_v, e) => {
        // Пока открыт список подсказок, Enter выбирает в нём, а не создаёт задачу.
        if (open.current > 0) return false
        if (e.key === 'Enter') {
          e.preventDefault()
          handlers.current.onSubmit()
          return true
        }
        if (e.key === 'Escape') {
          handlers.current.onEscape()
          return true
        }
        return false
      },
    },
    onUpdate: ({ editor: ed }) => handlers.current.onChange(serialize(ed.getJSON() as Doc)),
  })
  useRepaintPlaceholder(editor, p.placeholder, true)

  useImperativeHandle(ref, () => ({
    clear: () => {
      editor?.commands.clearContent(true)
    },
    focus: () => {
      editor?.commands.focus('end')
    },
    // Источник правды — текст: прежняя метка того же вида (плашкой или набранная
    // руками — @имя, #"Проект") снимается, новая встаёт плашкой в конец строки,
    // и сервер разбирает строку как обычно.
    setPick: (kind, pick) => {
      if (!editor) return
      const { state } = editor
      const tr = state.tr
      const re = kind === 'person' ? /(^|\s)@("[^"]*"|\S+)/g : /(^|\s)#("[^"]*"|\S+)/g
      const cut: [number, number][] = []
      state.doc.descendants((n, pos) => {
        if (n.type.name === kind) cut.push([pos, pos + n.nodeSize])
        else if (n.isText)
          for (const m of (n.text ?? '').matchAll(re)) {
            const from = pos + (m.index ?? 0) + m[1]!.length
            cut.push([from, from + m[0].length - m[1]!.length])
          }
      })
      for (const [a, b] of cut.sort((x, y) => y[0] - x[0])) tr.delete(a, b)
      if (pick) {
        const end = tr.doc.content.size - 1
        const prev = end > 1 ? tr.doc.textBetween(end - 1, end, '', '￼') : ''
        const node = state.schema.nodes[kind]!.create({ id: pick.id, label: pick.label })
        tr.insert(end, [...(prev && prev !== ' ' ? [state.schema.text(' ')] : []), node, state.schema.text(' ')])
      }
      editor.view.dispatch(tr)
      editor.commands.focus('end')
    },
  }))

  return <EditorContent editor={editor} className="qwrap" />
})
