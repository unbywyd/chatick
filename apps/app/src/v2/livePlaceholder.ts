import { useCallback, useEffect, useRef } from 'react'
import type { Editor } from '@tiptap/core'

/**
 * Подсказка tiptap, которая следует за языком.
 *
 * Placeholder.configure({ placeholder: 'строка' }) запоминает строку при
 * создании редактора, а при смене языка редактор не пересоздаётся: в русском
 * интерфейсе оставалась ивритская подсказка. Пустой абзац берёт направление из
 * текста подсказки (unicode-bidi: plaintext), так что поле заодно стояло справа.
 *
 * Поэтому подсказка — функция, читающая последний текст (её и отдаём в
 * Placeholder.configure), а useRepaintPlaceholder при смене текста
 * перерисовывает украшения пустой транзакцией.
 */
export function useLivePlaceholder(text: string) {
  const ref = useRef(text)
  ref.current = text
  return useCallback(() => ref.current, [])
}

/** label — заодно aria-label поля, если он совпадает с подсказкой. */
export function useRepaintPlaceholder(editor: Editor | null, text: string, label = false) {
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    if (label) editor.view.dom.setAttribute('aria-label', text)
    editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false))
  }, [editor, text, label])
}
