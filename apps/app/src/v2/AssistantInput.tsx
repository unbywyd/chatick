import { forwardRef, useEffect, useImperativeHandle } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { TextDirection } from '@/components/ui/text-direction'
import { serializeToMarkdown } from '@/components/chat/Composer'
import { useLivePlaceholder, useRepaintPlaceholder } from './livePlaceholder'

export type AssistantInputHandle = { clear: () => void; focus: () => void }

/**
 * Поле ассистента — tiptap, как композер чата: markdown набирается прямо
 * (**жирный**, `код`, списки «- »), а уходит ассистенту markdown-текстом.
 * Enter — отправить, Shift+Enter — новая строка.
 */
export const AssistantInput = forwardRef<
  AssistantInputHandle,
  { placeholder: string; disabled?: boolean; onChange: (md: string) => void; onSubmit: (md: string) => void; onFiles?: (files: File[]) => void }
>(function AssistantInput({ placeholder, disabled, onChange, onSubmit, onFiles }, ref) {
  const ph = useLivePlaceholder(placeholder)
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false, horizontalRule: false }), TextDirection, Placeholder.configure({ placeholder: ph })],
    editable: !disabled,
    editorProps: {
      attributes: { class: 'ai-ed', 'aria-label': placeholder },
      // Скриншот из буфера — сразу вложением к вопросу, а не текстом.
      handlePaste: (_v, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
        if (!files.length || !onFiles) return false
        event.preventDefault()
        onFiles(files)
        return true
      },
      handleKeyDown: (view, event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return false
        // В блоке кода Enter — перенос строки, как в редакторе.
        if (view.state.selection.$from.parent.type.name === 'codeBlock') return false
        event.preventDefault()
        submit()
        return true
      },
    },
    onUpdate: ({ editor: e }) => onChange(e.isEmpty ? '' : serializeToMarkdown(e.getJSON())),
  })

  const submit = () => {
    if (!editor || editor.isEmpty) return
    onSubmit(serializeToMarkdown(editor.getJSON()))
  }

  useImperativeHandle(ref, () => ({
    clear: () => {
      editor?.commands.clearContent(true)
    },
    focus: () => {
      editor?.commands.focus('end')
    },
  }))

  useEffect(() => {
    editor?.setEditable(!disabled)
  }, [editor, disabled])
  useRepaintPlaceholder(editor, placeholder, true)

  // Язык сменили — подсказка в поле тоже (редактор при этом не пересоздаём).
  useEffect(() => {
    if (!editor) return
    const ext = editor.extensionManager.extensions.find((x) => x.name === 'placeholder')
    if (!ext || ext.options.placeholder === placeholder) return
    ext.options.placeholder = placeholder
    editor.view.dispatch(editor.state.tr)
  }, [editor, placeholder])

  return <EditorContent editor={editor} />
})
