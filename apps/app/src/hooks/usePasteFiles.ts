import { useEffect } from 'react'
import { filesFromClipboard } from '@/lib/clipboard'

// Вставка файлов/картинок из буфера в любом загрузчике (SPEC §8.16).
// Слушает paste на документе, пока компонент смонтирован; игнорирует вставку,
// когда фокус в текстовом поле/редакторе (там свой обработчик или обычный текст).
export function usePasteFiles(onFiles: (files: File[]) => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const handler = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return // не перехватываем текстовый ввод
      const files = filesFromClipboard(e.clipboardData)
      if (files.length) {
        e.preventDefault()
        onFiles(files)
      }
    }
    document.addEventListener('paste', handler)
    return () => document.removeEventListener('paste', handler)
  }, [onFiles, enabled])
}
