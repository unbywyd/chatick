import { forwardRef, useEffect, useImperativeHandle } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { TextDirection } from '@/components/ui/text-direction'
import { serializeToMarkdown } from '@/components/chat/Composer'

export type AssistantInputHandle = { clear: () => void; focus: () => void }

/**
 * Поле ассистента — tiptap, как композер чата: markdown набирается прямо
 * (**жирный**, `код`, списки «- »), а уходит ассистенту markdown-текстом.
 * Enter — отправить, Shift+Enter — новая строка.
 */
export const AssistantInput = forwardRef<
  AssistantInputHandle,
  { placeholder: string; disabled?: boolean; onChange: (md: string) => void; onSubmit: (md: string) => void }
>(function AssistantInput({ placeholder, disabled, onChange, onSubmit }, ref) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false, horizontalRule: false }), TextDirection, Placeholder.configure({ placeholder })],
    editable: !disabled,
    editorProps: {
      attributes: { class: 'ai-ed', 'aria-label': placeholder },
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
