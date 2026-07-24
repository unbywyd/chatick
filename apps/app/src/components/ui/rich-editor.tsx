import { useEffect } from 'react'
import { useEditor, EditorContent, ReactRenderer } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Mention from '@tiptap/extension-mention'
import Link from '@tiptap/extension-link'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import tippy, { type Instance } from 'tippy.js'
import { Bold, Code, Heading2, Italic, Link2, List, ListChecks, ListOrdered, Quote, Strikethrough } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MentionList, type MentionItem, type MentionListRef } from '@/components/chat/MentionList'

export type RichMention = { id: string; label: string; avatarUrl?: string | null }

// mention-suggestion фабрика — общая для чата, задач, комментариев
export function mentionSuggestion(getItems: () => RichMention[], includeAi = false) {
  return {
    items: ({ query }: { query: string }) => {
      const q = query.toLowerCase()
      const base = getItems()
      const list: MentionItem[] = includeAi ? [{ id: 'ai', label: 'AI', isAi: true }, ...base] : base
      return list.filter((m) => m.isAi || m.label.toLowerCase().includes(q)).slice(0, 8)
    },
    render: () => {
      let component: ReactRenderer<MentionListRef> | null = null
      let popup: Instance[] = []
      return {
        onStart: (props: Record<string, unknown>) => {
          component = new ReactRenderer(MentionList, { props, editor: (props as { editor: never }).editor })
          popup = tippy('body', {
            getReferenceClientRect: props.clientRect as () => DOMRect,
            appendTo: () => document.body,
            content: component.element,
            showOnCreate: true,
            interactive: true,
            trigger: 'manual',
            placement: 'top-start',
          })
        },
        onUpdate: (props: Record<string, unknown>) => {
          component?.updateProps(props)
          popup[0]?.setProps({ getReferenceClientRect: props.clientRect as () => DOMRect })
        },
        onKeyDown: (props: { event: KeyboardEvent }) => {
          if (props.event.key === 'Escape') {
            popup[0]?.hide()
            return true
          }
          return component?.ref?.onKeyDown(props) ?? false
        },
        onExit: () => {
          popup[0]?.destroy()
          component?.destroy()
        },
      }
    },
  }
}

// Универсальный rich-editor. preset: full (задачи) | minimal (комментарии)
export function RichEditor({
  value,
  onChange,
  onSubmit,
  placeholder,
  mentions,
  preset = 'full',
  className,
}: {
  value: string
  onChange: (markdown: string, mentionIds: string[]) => void
  onSubmit?: () => void
  placeholder?: string
  mentions: RichMention[]
  preset?: 'full' | 'minimal'
  className?: string
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure(
        preset === 'minimal'
          ? { heading: false, blockquote: false, horizontalRule: false, codeBlock: false }
          : { horizontalRule: false },
      ),
      Placeholder.configure({ placeholder: placeholder ?? '' }),
      Link.configure({ openOnClick: false, HTMLAttributes: { class: 'text-brand underline' } }),
      ...(preset === 'full' ? [TaskList, TaskItem.configure({ nested: true })] : []),
      Mention.configure({ HTMLAttributes: { class: 'mention' }, suggestion: mentionSuggestion(() => mentions) as never }),
    ],
    content: markdownToHtml(value),
    editorProps: {
      attributes: { class: cn('tiptap-editor max-h-[50vh] min-h-16 overflow-y-auto px-3 py-2 text-sm outline-none', className) },
      handleKeyDown: (_v, event) => {
        if (onSubmit && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault()
          onSubmit()
          return true
        }
        return false
      },
    },
    onUpdate: ({ editor }) => {
      const json = editor.getJSON() as MdNode
      onChange(serializeToMarkdown(json), collectMentions(json))
    },
  })

  // внешний ресет (после отправки value='')
  useEffect(() => {
    if (editor && value === '' && !editor.isEmpty) editor.commands.clearContent()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  if (!editor) return null

  return (
    <div className="rounded-md border transition-shadow focus-within:ring-2 focus-within:ring-ring">
      <BubbleMenu editor={editor}>
        <div className="flex rounded-md border bg-popover p-0.5 shadow-md">
          <Tool active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold className="size-3.5" /></Tool>
          <Tool active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic className="size-3.5" /></Tool>
          <Tool active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough className="size-3.5" /></Tool>
          <Tool active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}><Code className="size-3.5" /></Tool>
          <Tool
            active={editor.isActive('link')}
            onClick={() => {
              const url = window.prompt('URL')
              if (url) editor.chain().focus().setLink({ href: url }).run()
              else editor.chain().focus().unsetLink().run()
            }}
          >
            <Link2 className="size-3.5" />
          </Tool>
        </div>
      </BubbleMenu>

      {preset === 'full' && (
        <div className="flex flex-wrap gap-0.5 border-b p-1">
          <Tool active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 className="size-3.5" /></Tool>
          <Tool active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold className="size-3.5" /></Tool>
          <Tool active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic className="size-3.5" /></Tool>
          <Tool active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}><List className="size-3.5" /></Tool>
          <Tool active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered className="size-3.5" /></Tool>
          <Tool active={editor.isActive('taskList')} onClick={() => editor.chain().focus().toggleTaskList().run()}><ListChecks className="size-3.5" /></Tool>
          <Tool active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote className="size-3.5" /></Tool>
          <Tool active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}><Code className="size-3.5" /></Tool>
        </div>
      )}

      <EditorContent editor={editor} />
    </div>
  )
}

function Tool({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn('rounded p-1.5 transition-colors', active ? 'bg-brand text-brand-foreground' : 'text-muted-foreground hover:text-foreground')}
    >
      {children}
    </button>
  )
}

// --- markdown ⇄ tiptap (расширенный сабсет) --------------------------------

type MdMark = { type: string; attrs?: Record<string, unknown> }
type MdNode = { type?: string; text?: string; marks?: MdMark[]; attrs?: Record<string, unknown>; content?: MdNode[] }

function textOf(node: MdNode): string {
  let s = node.text ?? ''
  for (const mark of node.marks ?? []) {
    if (mark.type === 'bold') s = `**${s}**`
    if (mark.type === 'italic') s = `*${s}*`
    if (mark.type === 'strike') s = `~~${s}~~`
    if (mark.type === 'code') s = `\`${s}\``
    if (mark.type === 'link') s = `[${s}](${mark.attrs?.href})`
  }
  return s
}
function inline(nodes: MdNode[] = []): string {
  return nodes
    .map((n) => {
      if (n.type === 'text') return textOf(n)
      if (n.type === 'mention') return `@[${n.attrs?.label}](${n.attrs?.id})`
      if (n.type === 'hardBreak') return '\n'
      return ''
    })
    .join('')
}
export function serializeToMarkdown(doc: MdNode): string {
  const blocks: string[] = []
  for (const node of doc.content ?? []) {
    if (node.type === 'paragraph') blocks.push(inline(node.content))
    else if (node.type === 'heading') blocks.push('#'.repeat(Number(node.attrs?.level ?? 2)) + ' ' + inline(node.content))
    else if (node.type === 'blockquote') blocks.push('> ' + inline(node.content?.[0]?.content))
    else if (node.type === 'codeBlock') blocks.push('```\n' + inline(node.content) + '\n```')
    else if (node.type === 'bulletList') blocks.push((node.content ?? []).map((li) => '- ' + inline(li.content?.[0]?.content)).join('\n'))
    else if (node.type === 'orderedList') blocks.push((node.content ?? []).map((li, i) => `${i + 1}. ` + inline(li.content?.[0]?.content)).join('\n'))
    else if (node.type === 'taskList')
      blocks.push((node.content ?? []).map((li) => `- [${li.attrs?.checked ? 'x' : ' '}] ` + inline(li.content?.[0]?.content)).join('\n'))
  }
  return blocks.join('\n\n').trim()
}
function collectMentions(doc: MdNode): string[] {
  const ids: string[] = []
  const walk = (n: MdNode) => {
    if (n.type === 'mention' && typeof n.attrs?.id === 'string') ids.push(n.attrs.id)
    n.content?.forEach(walk)
  }
  walk(doc)
  return [...new Set(ids)]
}

// markdown → простой HTML для начального контента редактора (базовый)
function markdownToHtml(md: string): string {
  if (!md) return ''
  // экранируем, затем базовые инлайн-замены; блоки — по строкам как параграфы
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return md
    .split('\n\n')
    .map((block) => {
      let b = esc(block)
      b = b.replace(/@\[([^\]]+)\]\(([^)]+)\)/g, '<span data-type="mention" data-id="$2" data-label="$1">@$1</span>')
      b = b.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      b = b.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>')
      b = b.replace(/~~([^~]+)~~/g, '<s>$1</s>').replace(/`([^`]+)`/g, '<code>$1</code>')
      if (block.startsWith('# ')) return `<h2>${b.slice(2)}</h2>`
      return `<p>${b.replace(/\n/g, '<br>')}</p>`
    })
    .join('')
}
