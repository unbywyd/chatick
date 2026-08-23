import { useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent, ReactRenderer } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { createLowlight, common } from 'lowlight'
import Placeholder from '@tiptap/extension-placeholder'
import Mention from '@tiptap/extension-mention'
import { TextDirection } from '@/components/ui/text-direction'
import tippy, { type Instance } from 'tippy.js'
import { Bold, Check, CheckSquare, ClipboardPaste, Code, SquareCode, FileText, Image as ImageIcon, Italic, KeyRound, List, Loader2, NotebookPen, Paperclip, SendHorizontal, Strikethrough, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useQuery } from '@tanstack/react-query'
import { api, API_URL, getProjectToken } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { filesFromClipboard } from '@/lib/clipboard'
import { MentionList, type MentionItem, type MentionListRef } from './MentionList'

export const AI_MENTION_ID = 'ai'

export type PendingAttachment = { id: string; name: string; mime: string; size: number }

// Композер чата: tiptap + markdown-база, bubble-меню инструментов по выделению,
// mentions (@участники + @AI первым), Ctrl/Cmd+Enter=отправить / Enter=перенос
/** Что можно приложить к сообщению ссылкой (SPEC §8.34). */
export type PinKind = 'task' | 'note' | 'document' | 'resource'
type Pin = { id: string; kind: PinKind; number?: string; title: string }

export function Composer({
  disabled,
  placeholder,
  mentions,
  onSend,
  focusSignal,
  prefill,
  onPrefillUsed,
  canBypassAi = false,
  bypassAi = false,
}: {
  disabled?: boolean
  placeholder: string
  mentions: MentionItem[]
  /**
   * Меняется — ставим курсор в поле. Нужен, когда фокус просит внешнее
   * действие («Ответить» на сообщении): без этого человек жмёт «ответить»,
   * а потом ещё раз кликает в поле, чтобы начать печатать.
   */
  focusSignal?: number
  /** текст, который надо положить в поле (пример из пустого чата) */
  prefill?: string | null
  onPrefillUsed?: () => void
  /** отправка мимо проверки ИИ — только руководству проекта */
  canBypassAi?: boolean
  /** Режим «мимо проверки ИИ». Живёт в ChatPanel: переключатель стоит в
   *  строке режимов под полем, а не в самом поле. */
  bypassAi?: boolean
  onSend: (payload: { markdown: string; mentionIds: string[]; attachmentIds: string[]; taskRefs: string[]; raw?: boolean }) => void
}) {
  const { t } = useTranslation()
  // Режим прямой отправки залипает: включил — и дальше пишешь без проверки,
  // пока сам не выключишь. Разовый пункт в меню заставлял бы лезть туда
  // перед каждым сообщением.

  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [taskPins, setTaskPins] = useState<Pin[]>([])
  const [uploading, setUploading] = useState(0)
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

  // Живой список участников для подсказки @. Редактор читает его через ref:
  // сам он создаётся один раз, а участники приезжают запросом позже.
  const mentionsRef = useRef(mentions)
  mentionsRef.current = mentions

  const editor = useEditor({
    editable: !disabled,
    extensions: [
      // codeBlock выключаем в StarterKit и ставим свой: стандартный не знает
      // языков вовсе, а ```js в чате разработчиков — обычное дело.
      StarterKit.configure({ heading: false, blockquote: false, horizontalRule: false, codeBlock: false }),
      CodeBlockLowlight.configure({ lowlight }),
      // Направление блока: композер чата — такой же редактор, и ивритское
      // сообщение должно писаться справа налево, а латинское слева направо.
      TextDirection,
      Placeholder.configure({ placeholder }),
      Mention.configure({
        HTMLAttributes: { class: 'mention' },
        suggestion: {
          items: ({ query }) => {
            const q = query.toLowerCase()
            const ai: MentionItem = { id: AI_MENTION_ID, label: 'AI', isAi: true }
            // Через ref, а не напрямую: редактор создаётся один раз и навсегда
            // запоминает то, что видел при монтировании. Участники приезжают
            // запросом позже, поэтому в замыкании оставался пустой список — в
            // подсказке был только @AI, будто в проекте никого нет.
            const people = mentionsRef.current.filter((m) => m.label.toLowerCase().includes(q))
            // @AI всегда первым — прямое обращение к диспетчеру
            return [ai, ...people].slice(0, 8)
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
      handlePaste: (view, event) => {
        const files = filesFromClipboard(event.clipboardData)
        if (files.length) {
          event.preventDefault()
          void uploadFiles(files)
          return true
        }

        /**
         * Вставка готового markdown-блока: ```js … ```
         *
         * Само расширение это не разбирает: его input-правило срабатывает
         * только на НАБОР кавычек, а обработчик вставки — только на копию из
         * VS Code (там язык приходит отдельным типом данных). Обычный markdown
         * — из переписки, из README, из ответа ассистента — оставался текстом:
         * блок кода получался, но ограда виднелась внутри него, а язык не
         * применялся, и подсветки не было.
         *
         * Разбираем сами: снимаем ограду, берём язык из неё и кладём
         * содержимое настоящим блоком кода.
         */
        // Переводы строк Windows приводим к обычным: буфер из блокнота,
        // консоли и многих редакторов приходит с ними, и разбор ограды об это
        // спотыкался — вставка не срабатывала ровно там, где ею и пользуются.
        const text = event.clipboardData?.getData('text/plain')?.replace(/\r\n?/g, '\n')
        // Только когда ограда обрамляет ВСЮ вставку и внутри неё нет второй:
        // код вперемешку с текстом — это markdown-документ, и превращать его
        // целиком в один блок значило бы съесть остальное. Без запрета на
        // ограду внутри два блока подряд склеивались в один.
        const fence = text?.trim().match(/^```([\w-]*)\n((?:(?!\n```)[\s\S])*)\n?```$/)
        // Внутри блока кода ограда — обычные символы, там она ничего не значит.
        const inCode = view.state.selection.$from.parent.type.name === 'codeBlock'
        // Тип узла берём из схемы, а не из имени: расширение могли отключить.
        // Проверяем ДО preventDefault — иначе на редакторе без блоков кода
        // вставка просто пропадала бы, вместо того чтобы лечь обычным текстом.
        const codeBlockType = view.state.schema.nodes.codeBlock
        if (fence && !inCode && codeBlockType) {
          event.preventDefault()
          const [, language, code] = fence
          const { state } = view
          const node = codeBlockType.create(
            language ? { language } : null,
            code ? state.schema.text(code) : null,
          )
          view.dispatch(state.tr.replaceSelectionWith(node).scrollIntoView())
          return true
        }

        return false
      },
    },
  })

  useEffect(() => {
    editor?.setEditable(!disabled)
  }, [editor, disabled])

  /**
   * Плейсхолдер задаётся при СОЗДАНИИ редактора и сам не меняется.
   *
   * Человек переключает язык интерфейса — всё переводится, а подсказка в поле
   * ввода остаётся на прежнем. Правим настройку расширения на месте и просим
   * перерисовку: пересоздавать редактор нельзя, в нём набранный текст.
   */
  useEffect(() => {
    if (!editor) return
    const ext = editor.extensionManager.extensions.find((e) => e.name === 'placeholder')
    if (!ext || ext.options.placeholder === placeholder) return
    ext.options.placeholder = placeholder
    editor.view.dispatch(editor.state.tr)
  }, [editor, placeholder])

  // Внешний запрос фокуса: «Ответить» на сообщении ставит курсор сюда, чтобы
  // не приходилось отдельно кликать в поле.
  //
  // Через кадр, а не сразу: пункт меню закрывается уже после нашего вызова и
  // возвращает фокус на кнопку, которая меню открыла — курсор из поля уходил
  // ровно в тот момент, когда мы его туда поставили.
  // Пример из пустого чата: кладём в поле и отдаём фокус в конец, чтобы
  // можно было сразу дописать своё, а не стирать чужое.
  useEffect(() => {
    if (!prefill || !editor) return
    editor.commands.setContent(`<p>${prefill}</p>`)
    editor.commands.focus('end')
    onPrefillUsed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, editor])

  useEffect(() => {
    if (!focusSignal || !editor || disabled) return
    const timer = window.setTimeout(() => editor.commands.focus('end'), 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSignal, editor])

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

  const submit = (forceRaw = false) => {
    // залипший режим или разовый выбор в меню — одно и то же для сервера
    const raw = forceRaw || (canBypassAi && bypassAi)
    if (!editor) return
    const markdown = editor.isEmpty ? '' : serializeToMarkdown(editor.getJSON())
    if (!markdown.trim() && attachments.length === 0 && taskPins.length === 0) return
    const mentionIds = collectMentions(editor.getJSON())
    onSend({
      markdown: markdown || '📎',
      mentionIds,
      attachmentIds: attachments.map((a) => a.id),
      // «kind:id» — задачи остаются как есть для старых записей
      taskRefs: taskPins.map((p) => (p.kind === 'task' ? p.id : `${p.kind}:${p.id}`)),
      raw,
    })
    editor.commands.clearContent()
    setAttachments([])
    setTaskPins([])
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
            setTaskPins((prev) =>
              prev.some((x) => x.id === task.id && x.kind === 'task')
                ? prev
                : [...prev, { id: task.id, kind: 'task' as const, number: task.number, title: task.title }],
            )
            return
          } catch { /* fallthrough */ }
        }
        // Ресурс, документ, заметка → пин, как задача и файл. Раньше сюда
        // вставлялась markdown-ссылка прямо в текст: она мешала писать, её
        // можно было случайно испортить, и выглядела она как сырая разметка.
        const dropped: [string, PinKind][] = [
          ['application/x-chatick-resource', 'resource'],
          ['application/x-chatick-document', 'document'],
          ['application/x-chatick-note', 'note'],
        ]
        for (const [mime, kind] of dropped) {
          const raw = e.dataTransfer.getData(mime)
          if (!raw) continue
          try {
            const r = JSON.parse(raw) as { id: string; name: string }
            setTaskPins((prev) =>
              prev.some((x) => x.id === r.id && x.kind === kind) ? prev : [...prev, { id: r.id, kind, title: r.name }],
            )
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
        <div className="pointer-events-none border-b bg-accent/50 px-3 py-2 text-center text-xs font-medium text-brand-ink">
          {t('composer.dropHere')}
        </div>
      )}

      {/* Чипы вложений и task-пинов — одним рядом */}
      {hasPins && (
        <div className="flex flex-wrap gap-1.5 border-b px-2.5 py-2">
          {taskPins.map((p) => (
            <span
              key={`${p.kind}:${p.id}`}
              className="inline-flex max-w-52 items-center gap-1.5 rounded-full border border-brand/40 bg-accent px-2 py-1 text-xs"
            >
              {/* Иконка по типу: чипсы стоят рядом, и «задача» на документе
                  сбивает с толку сильнее, чем отсутствие иконки вообще. */}
              {p.kind === 'task' ? (
                <CheckSquare className="size-3 shrink-0 text-brand-ink" />
              ) : p.kind === 'note' ? (
                <NotebookPen className="size-3 shrink-0 text-brand-ink" />
              ) : p.kind === 'document' ? (
                <FileText className="size-3 shrink-0 text-brand-ink" />
              ) : (
                <KeyRound className="size-3 shrink-0 text-brand-ink" />
              )}
              <span className="truncate">
                {p.number && <span className="font-medium">{p.number} </span>}
                {p.title}
              </span>
              <button
                type="button"
                onClick={() => setTaskPins((prev) => prev.filter((x) => !(x.id === p.id && x.kind === p.kind)))}
                className="text-muted-foreground hover:text-destructive"
              >
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
              <Loader2 className="size-3 animate-spin text-brand-ink" />
            </span>
          )}
        </div>
      )}
      {/* Контекстное меню форматирования по выделению */}
      <BubbleMenu editor={editor} className="tiptap-bubble">
        <div className="flex rounded-md border bg-popover p-0.5 shadow-lg">
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
          {/* Блок кода отдельной кнопкой: он был доступен только тем, кто знает
              про три обратные кавычки, — то есть почти никому. В карточке
              задачи такая кнопка есть, и чат выбивался из общего поведения. */}
          <ToolBtn
            active={editor.isActive('codeBlock')}
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            title="Code block"
          >
            <SquareCode className="size-3.5" />
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
        {/* Одна скрепка вместо трёх кнопок: способов приложить файл больше,
            чем места в ряду, и каждый новый его не добавит. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              title={t('chat.attach')}
              className={cn(
                'rounded-md p-2 transition-colors disabled:opacity-40',
                keepOriginal ? 'text-brand-ink' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Paperclip className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => fileRef.current?.click()}>
              <Paperclip className="size-3.5" />
              {t('composer.chooseFile')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={pasteFromClipboard}>
              <ClipboardPaste className="size-3.5" />
              {t('composer.pasteFromClipboard')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/* Режим, а не действие: включил — и следующие картинки уходят
                без сжатия, пока не выключишь. */}
            <DropdownMenuItem onSelect={() => setKeepOriginal((v) => !v)}>
              <ImageIcon className={cn('size-3.5', keepOriginal && 'text-brand-ink')} />
              <span className="flex-1">{t('chat.keepOriginal')}</span>
              {keepOriginal && <Check className="size-3.5 text-brand-ink" />}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

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
            className="rounded-md bg-brand p-2 text-brand-foreground transition-opacity disabled:opacity-40"
          >
            <SendHorizontal className="size-4 rtl:-scale-x-100" />
          </button>
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

/**
 * Подсветка кода в композере.
 *
 * `common` — общий набор грамматик (около сорока языков), а не все подряд:
 * полный набор тянет в сборку сотни килобайт ради языков, которые в чат
 * никто не пришлёт. Создаём один раз на модуль — экземпляр на каждый рендер
 * означал бы пересборку грамматик при каждом нажатии клавиши.
 */
const lowlight = createLowlight(common)

export function serializeToMarkdown(doc: Node): string {
  const blocks: string[] = []
  for (const node of doc.content ?? []) {
    if (node.type === 'paragraph') blocks.push(inline(node.content))
    else if (node.type === 'codeBlock') {
      // Язык из атрибута узла. Без него ```js уезжало голыми кавычками:
      // отправитель язык указывал, а получатель видел код без подсветки —
      // и выглядело это как «формат не поддерживается».
      const lang = typeof node.attrs?.language === 'string' ? node.attrs.language : ''
      blocks.push('```' + lang + '\n' + inline(node.content) + '\n```')
    }
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
