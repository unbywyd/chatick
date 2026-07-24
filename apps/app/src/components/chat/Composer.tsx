import { useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent, ReactRenderer } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Mention from '@tiptap/extension-mention'
import tippy, { type Instance } from 'tippy.js'
import { Bold, CheckSquare, ChevronUp, ClipboardPaste, Code, FileText, Image as ImageIcon, Italic, List, Loader2, Paperclip, SendHorizontal, ShieldOff, Strikethrough, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useQuery } from '@tanstack/react-query'
import { api, API_URL, getProjectToken } from '@/lib/api'
import { cn } from '@/lib/utils'
import { filesFromClipboard } from '@/lib/clipboard'
import { MentionList, type MentionItem, type MentionListRef } from './MentionList'

export const AI_MENTION_ID = 'ai'

export type PendingAttachment = { id: string; name: string; mime: string; size: number }

// Композер чата: tiptap + markdown-база, bubble-меню инструментов по выделению,
// mentions (@участники + @AI первым), Enter=отправить / Shift+Enter=перенос
export function Composer({
  disabled,
  placeholder,
  mentions,
  onSend,
}: {
  disabled?: boolean
  placeholder: string
  mentions: MentionItem[]
  onSend: (payload: { markdown: string; mentionIds: string[]; attachmentIds: string[]; taskRefs: string[]; raw?: boolean }) => void
}) {
  const { t } = useTranslation()
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [taskPins, setTaskPins] = useState<{ id: string; number: string; title: string }[]>([])
  const [uploading, setUploading] = useState(0)
  const [sendMenu, setSendMenu] = useState(false)
  const [dropActive, setDropActive] = useState(false) // подсветка зоны при наведении файла/задачи
  // «отправить оригинал» — как в WhatsApp: без сжатия картинок
  const [keepOriginal, setKeepOriginal] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // превью-URL для картинок-вложений (в чипах)
  const previews = useQuery({
    queryKey: ['composer-previews', attachments.map((a) => a.id).join(',')],
    enabled: attachments.some((a) => a.mime.startsWith('image/')),
    staleTime: 50 * 60 * 1000,
    queryFn: async () => {
      const imgs = attachments.filter((a) => a.mime.startsWith('image/'))
      const entries = await Promise.all(
        imgs.map(async (a) => [a.id, (await api<{ url: string }>(`/api/v1/files/${a.id}/view-url`, {}, 'project')).url] as const),
      )
      return Object.fromEntries(entries) as Record<string, string>
    },
  })

  // вложения грузятся сразу (files API), к сообщению привяжутся при отправке (SPEC §5.5.4)
  async function uploadFiles(list: FileList | File[]) {
    for (const file of Array.from(list)) {
      setUploading((n) => n + 1)
      try {
        const fd = new FormData()
        fd.append('file', file)
        if (keepOriginal) fd.append('keepOriginal', '1')
        fd.append('pending', '1') // временный до отправки сообщения (SPEC §8.17)
        const res = await fetch(`${API_URL}/api/v1/files`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${getProjectToken()}` },
          body: fd,
        })
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText)
        const created = (await res.json()) as PendingAttachment
        setAttachments((prev) => [...prev, created])
      } catch (e) {
        toast.error(`${file.name}: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  const editor = useEditor({
    editable: !disabled,
    extensions: [
      StarterKit.configure({ heading: false, blockquote: false, horizontalRule: false }),
      Placeholder.configure({ placeholder }),
      Mention.configure({
        HTMLAttributes: { class: 'mention' },
        suggestion: {
          items: ({ query }) => {
            const q = query.toLowerCase()
            const ai: MentionItem = { id: AI_MENTION_ID, label: 'AI', isAi: true }
            const people = mentions.filter((m) => m.label.toLowerCase().includes(q))
            // @AI всегда первым — прямое обращение к диспетчеру
            return [ai, ...people].filter((m) => m.label.toLowerCase().includes(q) || m.isAi).slice(0, 8)
          },
          render: () => {
            let component: ReactRenderer<MentionListRef> | null = null
            let popup: Instance[] = []
            return {
              onStart: (props) => {
                component = new ReactRenderer(MentionList, { props, editor: props.editor })
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
              onUpdate: (props) => {
                component?.updateProps(props)
                popup[0]?.setProps({ getReferenceClientRect: props.clientRect as () => DOMRect })
              },
              onKeyDown: (props) => {
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
        },
      }),
    ],
    editorProps: {
      attributes: {
        class: 'tiptap-editor max-h-40 min-h-9 overflow-y-auto px-3 py-2 text-sm outline-none',
      },
      handleKeyDown: (_view, event) => {
        // Ctrl/Cmd+Enter = отправить; Enter = перенос строки
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault()
          submit()
          return true
        }
        return false
      },
      // вставка из буфера: картинки/файлы → загрузка как вложения (SPEC §8.16); текст — как обычно
      handlePaste: (_view, event) => {
        const files = filesFromClipboard(event.clipboardData)
        if (files.length) {
          event.preventDefault()
          void uploadFiles(files)
          return true
        }
        return false
      },
    },
  })

  useEffect(() => {
    editor?.setEditable(!disabled)
  }, [editor, disabled])

  // Ручная вставка из буфера (SPEC §8.16): картинка → вложение, текст → в редактор.
  async function pasteFromClipboard() {
    try {
      if (navigator.clipboard && 'read' in navigator.clipboard) {
        const items = await navigator.clipboard.read()
        const files: File[] = []
        for (const item of items) {
          const imgType = item.types.find((ty) => ty.startsWith('image/'))
          if (imgType) {
            const blob = await item.getType(imgType)
            files.push(new File([blob], `pasted-image.${imgType.split('/')[1] || 'png'}`, { type: imgType }))
          }
        }
        if (files.length) {
          await uploadFiles(files)
          return
        }
      }
      // текст → вставить в редактор
      const text = await navigator.clipboard.readText().catch(() => '')
      if (text && editor) editor.chain().focus().insertContent(text).run()
      else if (!text) toast.info(t('composer.clipboardEmpty'))
    } catch {
      toast.error(t('composer.clipboardDenied'))
    }
  }

  const submit = (raw = false) => {
    if (!editor) return
    const markdown = editor.isEmpty ? '' : serializeToMarkdown(editor.getJSON())
    if (!markdown.trim() && attachments.length === 0 && taskPins.length === 0) return
    const mentionIds = collectMentions(editor.getJSON())
    onSend({
      markdown: markdown || '📎',
      mentionIds,
      attachmentIds: attachments.map((a) => a.id),
      taskRefs: taskPins.map((p) => p.id),
      raw,
    })
    editor.commands.clearContent()
    setAttachments([])
    setTaskPins([])
    setSendMenu(false)
  }

  if (!editor) return null

  const hasPins = attachments.length > 0 || taskPins.length > 0 || uploading > 0

  return (
    <div
      className={cn(
        'rounded-md border transition-all focus-within:ring-2 focus-within:ring-ring',
        disabled && 'opacity-50',
        dropActive && 'border-brand ring-2 ring-brand/50',
      )}
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled) setDropActive(true)
      }}
      onDragLeave={(e) => {
        // не мигать при переходе между дочерними
        const related = e.relatedTarget
        if (!(related instanceof globalThis.Node) || !e.currentTarget.contains(related)) setDropActive(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDropActive(false)
        if (disabled) return
        // D&D задачи → пин (не текст)
        const taskData = e.dataTransfer.getData('application/x-chatick-task')
        if (taskData) {
          try {
            const task = JSON.parse(taskData) as { id: string; number: string; title: string }
            setTaskPins((prev) => (prev.some((x) => x.id === task.id) ? prev : [...prev, { id: task.id, number: task.number, title: task.title }]))
            return
          } catch { /* fallthrough */ }
        }
        // D&D ресурса → ссылка-ярлык в текст
        const resData = e.dataTransfer.getData('application/x-chatick-resource')
        if (resData && editor) {
          try {
            const r = JSON.parse(resData) as { id: string; name: string }
            const pid = window.location.hash.split('/')[2]
            editor.chain().focus().insertContent(`[🔗 ${r.name}](#/p/${pid}/resources) `).run()
            return
          } catch { /* fallthrough */ }
        }
        // D&D файла из менеджера
        const fileData = e.dataTransfer.getData('application/x-chatick-file')
        if (fileData) {
          try {
            const f = JSON.parse(fileData) as PendingAttachment
            setAttachments((prev) => (prev.some((x) => x.id === f.id) ? prev : [...prev, f]))
            return
          } catch { /* fallthrough */ }
        }
        if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files)
      }}
    >
      {/* Подсказка при наведении */}
      {dropActive && (
        <div className="pointer-events-none border-b bg-accent/50 px-3 py-2 text-center text-xs font-medium text-brand">
          {t('composer.dropHere')}
        </div>
      )}

      {/* Чипы вложений и task-пинов — одним рядом */}
      {hasPins && (
        <div className="flex flex-wrap gap-1.5 border-b px-2.5 py-2">
          {taskPins.map((p) => (
            <span key={p.id} className="inline-flex max-w-52 items-center gap-1.5 rounded-full border border-brand/40 bg-accent px-2 py-1 text-xs">
              <CheckSquare className="size-3 shrink-0 text-brand" />
              <span className="truncate">
                <span className="font-medium">{p.number}</span> {p.title}
              </span>
              <button type="button" onClick={() => setTaskPins((prev) => prev.filter((x) => x.id !== p.id))} className="text-muted-foreground hover:text-destructive">
                <X className="size-3" />
              </button>
            </span>
          ))}
          {attachments.map((a) => (
            <span key={a.id} className="inline-flex max-w-48 items-center gap-1.5 rounded-full border bg-secondary py-1 pe-2 ps-1 text-xs">
              {a.mime.startsWith('image/') && previews.data?.[a.id] ? (
                <img src={previews.data[a.id]} alt="" className="size-5 shrink-0 rounded-full object-cover" />
              ) : a.mime.startsWith('image/') ? (
                <ImageIcon className="size-4 shrink-0 ps-0.5" />
              ) : (
                <FileText className="size-4 shrink-0 ps-0.5" />
              )}
              <span className="truncate">{a.name}</span>
              <button type="button" onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))} className="text-muted-foreground hover:text-destructive">
                <X className="size-3" />
              </button>
            </span>
          ))}
          {uploading > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin text-brand" />
            </span>
          )}
        </div>
      )}
      {/* Контекстное меню форматирования по выделению */}
      <BubbleMenu editor={editor}>
        <div className="flex rounded-md border bg-popover p-0.5 shadow-md">
          <ToolBtn active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold">
            <Bold className="size-3.5" />
          </ToolBtn>
          <ToolBtn active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic">
            <Italic className="size-3.5" />
          </ToolBtn>
          <ToolBtn active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} title="Strike">
            <Strikethrough className="size-3.5" />
          </ToolBtn>
          <ToolBtn active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()} title="Code">
            <Code className="size-3.5" />
          </ToolBtn>
          <ToolBtn active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} title="List">
            <List className="size-3.5" />
          </ToolBtn>
        </div>
      </BubbleMenu>

      <div className="flex items-center gap-1 pe-1.5">
        <div className="min-w-0 flex-1">
          <EditorContent editor={editor} />
        </div>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={disabled}
          title={t('chat.attach')}
          className="rounded-md p-2 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          <Paperclip className="size-4" />
        </button>
        <button
          type="button"
          onClick={pasteFromClipboard}
          disabled={disabled}
          title={t('composer.pasteFromClipboard')}
          className="rounded-md p-2 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          <ClipboardPaste className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => setKeepOriginal((v) => !v)}
          disabled={disabled}
          title={t('chat.keepOriginal')}
          className={cn(
            'rounded-md p-2 transition-colors disabled:opacity-40',
            keepOriginal ? 'text-brand' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <ImageIcon className="size-4" />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) uploadFiles(e.target.files)
            e.target.value = ''
          }}
        />

        {/* Split-кнопка: основная = отправить через ИИ; стрелка = меню опций отправки */}
        <div className="relative flex">
          <button
            type="button"
            onClick={() => submit(false)}
            disabled={disabled}
            aria-label={t('chat.send')}
            title={t('chat.sendHint')}
            className="rounded-s-md bg-brand p-2 text-brand-foreground transition-opacity disabled:opacity-40"
          >
            <SendHorizontal className="size-4 rtl:-scale-x-100" />
          </button>
          <button
            type="button"
            onClick={() => setSendMenu((v) => !v)}
            disabled={disabled}
            className="rounded-e-md border-s border-brand-foreground/20 bg-brand px-1 text-brand-foreground transition-opacity disabled:opacity-40"
          >
            <ChevronUp className={cn('size-3.5 transition-transform', sendMenu && 'rotate-180')} />
          </button>

          {sendMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setSendMenu(false)} />
              <div className="absolute bottom-full end-0 z-50 mb-1 min-w-52 overflow-hidden rounded-md border bg-popover p-1 shadow-md">
                <button
                  type="button"
                  onClick={() => submit(true)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm hover:bg-accent"
                >
                  <ShieldOff className="size-3.5 text-orange-400" />
                  <span>
                    <span className="block">{t('chat.rawSend')}</span>
                    <span className="block text-xs text-muted-foreground">{t('chat.rawSendHint')}</span>
                  </span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function ToolBtn({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn('rounded p-1.5 transition-colors', active ? 'bg-brand text-brand-foreground' : 'text-muted-foreground hover:text-foreground')}
    >
      {children}
    </button>
  )
}

// --- tiptap JSON → markdown (базовый сабсет) --------------------------------

type Node = {
  type?: string
  text?: string
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  attrs?: Record<string, unknown>
  content?: Node[]
}

function textOf(node: Node): string {
  let s = node.text ?? ''
  for (const mark of node.marks ?? []) {
    if (mark.type === 'bold') s = `**${s}**`
    if (mark.type === 'italic') s = `*${s}*`
    if (mark.type === 'strike') s = `~~${s}~~`
    if (mark.type === 'code') s = `\`${s}\``
  }
  return s
}

function inline(nodes: Node[] = []): string {
  return nodes
    .map((n) => {
      if (n.type === 'text') return textOf(n)
      if (n.type === 'mention') return `@[${n.attrs?.label}](${n.attrs?.id})`
      if (n.type === 'hardBreak') return '\n'
      return ''
    })
    .join('')
}

export function serializeToMarkdown(doc: Node): string {
  const blocks: string[] = []
  for (const node of doc.content ?? []) {
    if (node.type === 'paragraph') blocks.push(inline(node.content))
    else if (node.type === 'codeBlock') blocks.push('```\n' + inline(node.content) + '\n```')
    else if (node.type === 'bulletList')
      blocks.push((node.content ?? []).map((li) => '- ' + inline(li.content?.[0]?.content)).join('\n'))
    else if (node.type === 'orderedList')
      blocks.push((node.content ?? []).map((li, i) => `${i + 1}. ` + inline(li.content?.[0]?.content)).join('\n'))
  }
  return blocks.join('\n\n').trim()
}

function collectMentions(doc: Node): string[] {
  const ids: string[] = []
  const walk = (n: Node) => {
    if (n.type === 'mention' && typeof n.attrs?.id === 'string') ids.push(n.attrs.id)
    n.content?.forEach(walk)
  }
  walk(doc)
  return [...new Set(ids)]
}
