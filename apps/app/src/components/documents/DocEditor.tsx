import { useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Mention from '@tiptap/extension-mention'
import Link from '@tiptap/extension-link'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Underline from '@tiptap/extension-underline'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  ImageIcon,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Strikethrough,
  Table as TableIcon,
  Underline as UnderlineIcon,
  Undo2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { API_URL, docImageUrl, getProjectToken, stripDocImageAuth, withDocImageAuth } from '@/lib/api'
import { CollabProvider, userColor } from '@/lib/yjs-provider'
import { mentionSuggestion, type RichMention } from '@/components/ui/rich-editor'
import { ImagePicker } from './ImagePicker'
import { ResizableImage } from './ResizableImage'

// Богатый редактор документов (SPEC §8.25): «как в Google Docs».
// Хранение — HTML (документы, в отличие от задач/комментариев, богаче markdown).

export function DocEditor({
  value,
  onChange,
  mentions,
  projectId,
  documentId,
  me,
  placeholder,
  editable = true,
}: {
  value: string
  onChange: (html: string) => void
  mentions: RichMention[]
  projectId: string
  documentId: string
  me?: { id: string; name: string } | null
  placeholder?: string
  editable?: boolean
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const uploadRef = useRef<HTMLInputElement>(null)

  // Совместное редактирование (SPEC §8.25 шаг 2): один провайдер на документ.
  const [provider, setProvider] = useState<CollabProvider | null>(null)
  const [synced, setSynced] = useState(false)
  useEffect(() => {
    const p = new CollabProvider(documentId)
    setProvider(p)
    setSynced(false)
    const off = p.onStatus((_c, s) => setSynced(s))
    return () => {
      off()
      p.destroy()
      setProvider(null)
    }
  }, [documentId])

  const editor = useEditor(
    {
      editable: editable && synced, // до первой синхронизации не даём печатать
      extensions: [
        // history выключаем: с Collaboration за отмену отвечает Yjs (общая история)
        StarterKit.configure({ horizontalRule: { HTMLAttributes: { class: 'doc-hr' } }, undoRedo: false }),
        Placeholder.configure({ placeholder: placeholder ?? '' }),
        Link.configure({ openOnClick: false, HTMLAttributes: { class: 'text-brand underline' } }),
        Underline,
        Highlight.configure({ multicolor: false }),
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        ResizableImage.configure({ inline: false, allowBase64: false, HTMLAttributes: { class: 'doc-image' } }),
        Table.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
        TaskList,
        TaskItem.configure({ nested: true }),
        Mention.configure({ HTMLAttributes: { class: 'mention' }, suggestion: mentionSuggestion(() => mentions) as never }),
        ...(provider
          ? [
              Collaboration.configure({ document: provider.doc }),
              CollaborationCaret.configure({
                provider,
                user: { name: me?.name || '…', color: userColor(me?.id ?? '') },
              }),
            ]
          : []),
      ],
      // content НЕ задаём: при Collaboration источник правды — Y.Doc,
      // иначе контент задвоится у каждого подключившегося
      editorProps: {
        attributes: { class: 'doc-editor min-h-[50vh] px-4 py-3 outline-none' },
        // вставка изображения из буфера → загрузка в файлы проекта → вставка по ссылке
        handlePaste: (_view, event) => {
          const items = Array.from(event.clipboardData?.items ?? [])
          const img = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'))
          if (!img) return false
          const file = img.getAsFile()
          if (!file) return false
          event.preventDefault()
          void uploadAndInsert(file)
          return true
        },
        handleDrop: (_view, event) => {
          const files = Array.from((event as DragEvent).dataTransfer?.files ?? [])
          const image = files.find((f) => f.type.startsWith('image/'))
          if (!image) return false
          event.preventDefault()
          void uploadAndInsert(image)
          return true
        },
      },
      // токен из URL картинок снимаем — в сохранённый контент он попасть не должен
      onUpdate: ({ editor }) => onChange(stripDocImageAuth(editor.getHTML())),
    },
    [provider, documentId], // пересоздаём редактор при смене документа/провайдера
  )

  // Первое наполнение: документ создан до co-editing (или пустая комната) —
  // заливаем HTML-снимок в Y.Doc ОДИН раз. Флаг живёт в самом Y.Doc, поэтому
  // при одновременном открытии двумя клиентами контент не задвоится.
  const seededRef = useRef<string | null>(null)
  useEffect(() => {
    if (!editor || !provider || !synced || seededRef.current === documentId) return
    seededRef.current = documentId
    const meta = provider.doc.getMap<boolean>('meta')
    const empty = provider.doc.getXmlFragment('default').length === 0
    if (empty && !meta.get('seeded') && value.trim()) {
      meta.set('seeded', true)
      editor.commands.setContent(withDocImageAuth(value))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, provider, synced, documentId])

  async function uploadAndInsert(file: File) {
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('manager', '1') // документ — постоянный файл, не временный (SPEC §8.17)
      const res = await fetch(`${API_URL}/api/v1/files`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getProjectToken()}` },
        body: fd,
      })
      if (!res.ok) throw new Error('upload failed')
      const created = (await res.json()) as { id: string }
      insertImageById(created.id)
    } catch {
      /* тихо: пользователь увидит, что картинка не вставилась */
    }
  }

  // Стабильная ссылка: авторизуется документом, не короткоживущим file-токеном,
  // поэтому картинка не отваливается через час и видна по публичной ссылке.
  function insertImageById(fileId: string) {
    editor?.chain().focus().setImage({ src: docImageUrl(documentId, fileId) }).run()
  }

  if (!editor) return null

  const Tool = ({
    active,
    onClick,
    title,
    children,
  }: {
    active?: boolean
    onClick: () => void
    title: string
    children: React.ReactNode
  }) => (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        'grid size-7 place-items-center rounded transition-colors',
        active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
  const Sep = () => <span className="mx-1 h-5 w-px bg-border" />

  return (
    <div className="rounded-md border">
      {/* Панель инструментов */}
      {editable && (
        <div className="sticky top-0 z-[5] flex flex-wrap items-center gap-0.5 border-b bg-background p-1.5">
          <Tool title="H1" active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
            <Heading1 className="size-4" />
          </Tool>
          <Tool title="H2" active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
            <Heading2 className="size-4" />
          </Tool>
          <Tool title="H3" active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
            <Heading3 className="size-4" />
          </Tool>
          <Sep />
          <Tool title="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
            <Bold className="size-4" />
          </Tool>
          <Tool title="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
            <Italic className="size-4" />
          </Tool>
          <Tool title="Underline" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}>
            <UnderlineIcon className="size-4" />
          </Tool>
          <Tool title="Strike" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>
            <Strikethrough className="size-4" />
          </Tool>
          <Tool title="Highlight" active={editor.isActive('highlight')} onClick={() => editor.chain().focus().toggleHighlight().run()}>
            <Highlighter className="size-4" />
          </Tool>
          <Tool title="Code" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}>
            <Code className="size-4" />
          </Tool>
          <Sep />
          <Tool title="Bullet list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
            <List className="size-4" />
          </Tool>
          <Tool title="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
            <ListOrdered className="size-4" />
          </Tool>
          <Tool title="Checklist" active={editor.isActive('taskList')} onClick={() => editor.chain().focus().toggleTaskList().run()}>
            <ListChecks className="size-4" />
          </Tool>
          <Tool title="Quote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
            <Quote className="size-4" />
          </Tool>
          <Sep />
          <Tool title="Align left" active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()}>
            <AlignLeft className="size-4" />
          </Tool>
          <Tool title="Align center" active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()}>
            <AlignCenter className="size-4" />
          </Tool>
          <Tool title="Align right" active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()}>
            <AlignRight className="size-4" />
          </Tool>
          <Sep />
          <Tool
            title="Link"
            active={editor.isActive('link')}
            onClick={() => {
              const url = window.prompt('URL')
              if (url) editor.chain().focus().setLink({ href: url }).run()
              else editor.chain().focus().unsetLink().run()
            }}
          >
            <Link2 className="size-4" />
          </Tool>
          <Tool title="Image" onClick={() => setPickerOpen(true)}>
            <ImageIcon className="size-4" />
          </Tool>
          <Tool title="Table" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
            <TableIcon className="size-4" />
          </Tool>
          <Tool title="Divider" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
            <Minus className="size-4" />
          </Tool>
          <Sep />
          <Tool title="Undo" onClick={() => editor.chain().focus().undo().run()}>
            <Undo2 className="size-4" />
          </Tool>
          <Tool title="Redo" onClick={() => editor.chain().focus().redo().run()}>
            <Redo2 className="size-4" />
          </Tool>

          <input
            ref={uploadRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              if (e.target.files?.[0]) void uploadAndInsert(e.target.files[0])
              e.target.value = ''
            }}
          />
        </div>
      )}

      {/* Плавающее меню по выделению */}
      <BubbleMenu editor={editor} className="tiptap-bubble">
        <div className="flex rounded-md border bg-popover p-0.5 shadow-lg">
          <Tool title="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
            <Bold className="size-3.5" />
          </Tool>
          <Tool title="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
            <Italic className="size-3.5" />
          </Tool>
          <Tool title="Highlight" active={editor.isActive('highlight')} onClick={() => editor.chain().focus().toggleHighlight().run()}>
            <Highlighter className="size-3.5" />
          </Tool>
          <Tool
            title="Link"
            active={editor.isActive('link')}
            onClick={() => {
              const url = window.prompt('URL')
              if (url) editor.chain().focus().setLink({ href: url }).run()
            }}
          >
            <Link2 className="size-3.5" />
          </Tool>
        </div>
      </BubbleMenu>

      <EditorContent editor={editor} />

      {/* Галерея изображений проекта */}
      {pickerOpen && (
        <ImagePicker
          projectId={projectId}
          onClose={() => setPickerOpen(false)}
          onPick={(fileId) => {
            setPickerOpen(false)
            void insertImageById(fileId)
          }}
          onUploadClick={() => {
            setPickerOpen(false)
            uploadRef.current?.click()
          }}
        />
      )}
    </div>
  )
}
