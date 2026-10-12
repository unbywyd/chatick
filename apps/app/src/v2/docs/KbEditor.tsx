import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Mention from '@tiptap/extension-mention'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Highlight from '@tiptap/extension-highlight'
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { API_URL, docImageUrl, projectHeaders, stripDocImageAuth, stripInlineImageAuth, withInlineImageAuth } from '@/lib/api'
import { CollabProvider, userColor } from '@/lib/yjs-provider'
import { mentionSuggestion, type RichMention } from '@/components/ui/rich-editor'
import { TextDirection } from '@/components/ui/text-direction'
import { ResizableImage } from '@/components/documents/ResizableImage'

/**
 * Редактор базы знаний в стиле макета.
 *
 * Старый DocEditor не годится как есть: картинки он грузит в проект «из
 * адреса окна» (#/c/…/p/…), а в v2 проекта в адресе нет. Здесь проект
 * передаётся явно, а панель инструментов — классами макета. Совместная
 * правка — тот же CollabProvider и тот же порядок первого наполнения, что и
 * в старом редакторе: формат Y.Doc у обоих клиентов обязан совпадать.
 */

function extensions(placeholder: string, mentions: RichMention[] | null, collab: boolean) {
  return [
    // С совместной правкой отмену ведёт Yjs — своя история StarterKit мешала бы.
    StarterKit.configure({ link: { openOnClick: false }, ...(collab ? { undoRedo: false as const } : {}) }),
    Placeholder.configure({ placeholder }),
    Highlight.configure({ multicolor: false }),
    ResizableImage.configure({ inline: false, allowBase64: false, HTMLAttributes: { class: 'doc-image' } }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
    TextDirection,
    ...(mentions ? [Mention.configure({ HTMLAttributes: { class: 'mention' }, suggestion: mentionSuggestion(() => mentions) as never })] : []),
  ]
}

/** Только чтение: HTML-снимок документа или тело заметки. Разметку чистит схема редактора. */
export function KbView({ html }: { html: string }) {
  const editor = useEditor(
    {
      editable: false,
      extensions: extensions('', null, false),
      content: withInlineImageAuth(html),
      editorProps: { attributes: { class: 'doc-editor body' } },
    },
    [html],
  )
  return <EditorContent editor={editor} />
}

/** Простая правка (заметки): значение снаружи, сохранение — по «Готово». */
export function PlainEditor({ value, onChange, placeholder }: { value: string; onChange: (html: string) => void; placeholder: string }) {
  const editor = useEditor({
    extensions: extensions(placeholder, null, false),
    content: withInlineImageAuth(value),
    autofocus: 'end',
    editorProps: { attributes: { class: 'doc-editor body kb-ed' } },
    onUpdate: ({ editor: e }) => onChange(stripInlineImageAuth(e.getHTML())),
  })
  if (!editor) return null
  return (
    <div className="kb-edw">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  )
}

/**
 * Совместная правка документа. seed — HTML-снимок: заливаем его в пустой
 * Y.Doc ровно один раз (флаг в самом Y.Doc), иначе контент задвоится у
 * каждого, кто откроет документ одновременно.
 */
/**
 * Подключение к документу на всё время, пока он открыт (и в просмотре, и в
 * правке): по нему идут совместная правка и «кто сейчас здесь». Раньше
 * присутствие давал сокет проекта; в v2 сокет личный, а сведения о людях в
 * документе и так ходят по комнате Yjs — берём их оттуда.
 */
export type Peer = { key: number; id: string; name: string; color: string; editing: boolean }

export function useDocRoom(documentId: string, me: { id: string; name: string } | null, editing: boolean) {
  const [provider, setProvider] = useState<CollabProvider | null>(null)
  const [synced, setSynced] = useState(false)
  const [peers, setPeers] = useState<Peer[]>([])
  useEffect(() => {
    const p = new CollabProvider(documentId)
    setProvider(p)
    setSynced(false)
    const off = p.onStatus((_c, s) => setSynced(s))
    const read = () => {
      const seen = new Set<string>()
      const list: Peer[] = []
      p.awareness.getStates().forEach((st, key) => {
        if (key === p.doc.clientID) return
        const u = (st as { user?: { id?: string; name?: string; color?: string; editing?: boolean } }).user
        if (!u?.id || seen.has(u.id)) return
        seen.add(u.id)
        list.push({ key, id: u.id, name: u.name ?? '…', color: u.color ?? '#71717A', editing: Boolean(u.editing) })
      })
      setPeers(list)
    }
    p.awareness.on('change', read)
    return () => {
      p.awareness.off('change', read)
      off()
      p.destroy()
      setProvider(null)
      setPeers([])
    }
  }, [documentId])
  // Себя — в общее состояние: имя, цвет курсора и «правит или смотрит».
  useEffect(() => {
    if (provider && me) provider.awareness.setLocalStateField('user', { id: me.id, name: me.name || '…', color: userColor(me.id), editing })
  }, [provider, me, editing])
  return { provider, synced, peers }
}

export function CollabEditor({
  documentId,
  projectId,
  seed,
  onChange,
  onSynced,
  mentions,
  me,
  placeholder,
  provider,
  synced,
}: {
  documentId: string
  projectId: string
  seed: string
  onChange: (html: string) => void
  onSynced: (synced: boolean) => void
  mentions: RichMention[]
  me: { id: string; name: string } | null
  placeholder: string
  provider: CollabProvider | null
  synced: boolean
}) {
  useEffect(() => onSynced(synced), [synced, onSynced])

  const fileRef = useRef<HTMLInputElement>(null)
  const editor = useEditor(
    {
      extensions: [
        ...extensions(placeholder, mentions, true),
        ...(provider
          ? [
              Collaboration.configure({ document: provider.doc }),
              CollaborationCaret.configure({ provider, user: { name: me?.name || '…', color: userColor(me?.id ?? '') } }),
            ]
          : []),
      ],
      editable: false,
      editorProps: {
        attributes: { class: 'doc-editor body kb-ed' },
        handlePaste: (_v, event) => {
          const file = Array.from(event.clipboardData?.items ?? []).find((i) => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile()
          if (!file) return false
          event.preventDefault()
          void upload(file)
          return true
        },
        handleDrop: (_v, event) => {
          const file = Array.from((event as DragEvent).dataTransfer?.files ?? []).find((f) => f.type.startsWith('image/'))
          if (!file) return false
          event.preventDefault()
          void upload(file)
          return true
        },
      },
      onUpdate: ({ editor: e }) => onChange(stripDocImageAuth(e.getHTML())),
    },
    [provider, documentId],
  )

  // Пока не пришло состояние с сервера — только чтение: иначе первая буква
  // ляжет в пустой документ раньше настоящего текста.
  useEffect(() => {
    editor?.setEditable(synced)
    if (synced) editor?.commands.focus('end')
  }, [editor, synced])

  useEffect(() => {
    if (provider && me) provider.awareness.setLocalStateField('user', { id: me.id, name: me.name || '…', color: userColor(me.id), editing: true })
  }, [provider, me])

  useEffect(() => {
    if (!editor || !provider || !synced) return
    const meta = provider.doc.getMap<boolean>('meta')
    if (meta.get('seeded')) return
    if (provider.doc.getXmlFragment('default').length > 0) {
      meta.set('seeded', true)
      return
    }
    if (seed.trim()) {
      meta.set('seeded', true)
      editor.commands.setContent(seed)
    }
    // seed берём на момент синка: дальше правда — в Y.Doc
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, provider, synced, documentId])

  // Картинка документа — постоянный файл проекта (manager=1); в текст идёт
  // ссылка без токена, токен подставляется только при показе.
  async function upload(file: File) {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('manager', '1')
    const res = await fetch(`${API_URL}/api/v1/files`, { method: 'POST', headers: projectHeaders(projectId), body: fd }).catch(() => null)
    if (!res?.ok) return
    const created = (await res.json()) as { id: string }
    editor?.chain().focus().setImage({ src: docImageUrl(documentId, created.id) }).run()
  }

  if (!editor) return null
  return (
    <div className="kb-edw">
      <Toolbar editor={editor} onImage={() => fileRef.current?.click()} />
      <EditorContent editor={editor} />
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) void upload(e.target.files[0])
          e.target.value = ''
        }}
      />
    </div>
  )
}

const P: Record<string, React.ReactNode> = {
  h2: <path d="M5 5v14M13 5v14M5 12h8M17 19h4c0-2-4-2.5-4-5a2 2 0 014 0" />,
  h3: <path d="M5 5v14M13 5v14M5 12h8M17 10.5a2 2 0 114 .5c0 1-1 1.5-2 1.5 1 0 2 .5 2 1.8a2 2 0 01-4 .2" />,
  bold: <path d="M7 5h6a3.5 3.5 0 010 7H7zM7 12h7a3.5 3.5 0 010 7H7z" />,
  italic: <path d="M10 5h8M6 19h8M14 5l-4 14" />,
  strike: <path d="M5 12h14M16 7a4 3 0 00-4-2c-2.5 0-4 1.2-4 3M8 17a4 3 0 004 2c2.5 0 4-1.2 4-3" />,
  code: <path d="M9 8l-4 4 4 4M15 8l4 4-4 4" />,
  bullet: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  ordered: <path d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1V9M4 14h3l-3 4h3" />,
  check: <path d="M4 5h5v5H4zM4 14h5v5H4zM12 7.5h8M12 16.5h8M5.5 16.5l1 1 2-2" />,
  quote: <path d="M5 7h5v5H7l-2 4M14 7h5v5h-3l-2 4" />,
  link: <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />,
  image: <path d="M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5h.01" />,
  table: <path d="M4 5h16v14H4zM4 10h16M4 15h16M10 5v14" />,
  undo: <path d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3" />,
  redo: <path d="M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3" />,
}

function Toolbar({ editor, onImage }: { editor: Editor; onImage?: () => void }) {
  const { t } = useTranslation('v2')
  // Подсветка активных кнопок зависит от каретки — перерисовываемся на её движение.
  const [, bump] = useState(0)
  useEffect(() => {
    const on = () => bump((x) => x + 1)
    editor.on('transaction', on)
    return () => {
      editor.off('transaction', on)
    }
  }, [editor])
  const c = () => editor.chain().focus()
  const b = (k: string, run: () => void, on = false) => (
    <button key={k} type="button" className={on ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={run} title={t(`docs.tb.${k}`)} aria-label={t(`docs.tb.${k}`)} aria-pressed={on}>
      <svg className="ic sm" viewBox="0 0 24 24" aria-hidden="true">
        {P[k]}
      </svg>
    </button>
  )
  const link = () => {
    const url = window.prompt(t('docs.tb.linkAsk'), (editor.getAttributes('link').href as string | undefined) ?? 'https://')
    if (url === null) return
    if (url.trim() && url.trim() !== 'https://') c().extendMarkRange('link').setLink({ href: url.trim() }).run()
    else c().extendMarkRange('link').unsetLink().run()
  }
  return (
    <div className="kb-tb" role="toolbar" aria-label={t('docs.tb.toolbar')}>
      {b('h2', () => c().toggleHeading({ level: 2 }).run(), editor.isActive('heading', { level: 2 }))}
      {b('h3', () => c().toggleHeading({ level: 3 }).run(), editor.isActive('heading', { level: 3 }))}
      <i />
      {b('bold', () => c().toggleBold().run(), editor.isActive('bold'))}
      {b('italic', () => c().toggleItalic().run(), editor.isActive('italic'))}
      {b('strike', () => c().toggleStrike().run(), editor.isActive('strike'))}
      {b('code', () => c().toggleCode().run(), editor.isActive('code'))}
      <i />
      {b('bullet', () => c().toggleBulletList().run(), editor.isActive('bulletList'))}
      {b('ordered', () => c().toggleOrderedList().run(), editor.isActive('orderedList'))}
      {b('check', () => c().toggleTaskList().run(), editor.isActive('taskList'))}
      {b('quote', () => c().toggleBlockquote().run(), editor.isActive('blockquote'))}
      <i />
      {b('link', link, editor.isActive('link'))}
      {onImage && b('image', onImage)}
      {b('table', () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
      <span className="sp" />
      {b('undo', () => c().undo().run())}
      {b('redo', () => c().redo().run())}
    </div>
  )
}
