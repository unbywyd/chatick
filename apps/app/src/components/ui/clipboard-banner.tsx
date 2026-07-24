import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardPaste, X } from 'lucide-react'
import { readClipboard, textPreview, type ClipboardContent } from '@/lib/clipboard'
import { cn } from '@/lib/utils'

// Баннер «Вставить из буфера» (SPEC §8.16): по клику читает буфер и показывает превью
// (картинка/текст), затем вставляет по подтверждению. Компактный, встраивается рядом с загрузчиком.
export function ClipboardBanner({
  onImage,
  onText,
  className,
  compact = false,
}: {
  onImage?: (files: File[]) => void
  onText?: (text: string) => void
  className?: string
  compact?: boolean
}) {
  const { t } = useTranslation()
  const [content, setContent] = useState<ClipboardContent | null>(null)

  // освобождаем object-URL превью
  useEffect(() => {
    return () => {
      if (content?.kind === 'image') URL.revokeObjectURL(content.previewUrl)
    }
  }, [content])

  const load = async () => setContent(await readClipboard())

  const accept = () => {
    if (!content) return
    if (content.kind === 'image' && onImage) onImage(content.files)
    else if (content.kind === 'text' && onText) onText(content.text)
    setContent(null)
  }

  // ничего не прочитано ещё — только кнопка-триггер
  if (!content) {
    return (
      <button
        type="button"
        onClick={load}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1.5 text-xs text-foreground transition-colors hover:border-brand hover:text-brand',
          className,
        )}
        title={t('clipboard.paste')}
      >
        <ClipboardPaste className="size-3.5" />
        {!compact && t('clipboard.paste')}
      </button>
    )
  }

  if (content.kind === 'empty' || content.kind === 'denied') {
    // короткое сообщение, само скрывается по клику
    return (
      <button
        type="button"
        onClick={() => setContent(null)}
        className={cn('inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground', className)}
      >
        {t(content.kind === 'denied' ? 'clipboard.denied' : 'clipboard.empty')}
        <X className="size-3" />
      </button>
    )
  }

  // превью содержимого + подтверждение
  return (
    <div className={cn('flex items-center gap-2 rounded-md border bg-card p-1.5', className)}>
      {content.kind === 'image' ? (
        <img src={content.previewUrl} alt="" className="size-10 shrink-0 rounded object-cover" />
      ) : (
        <span className="line-clamp-2 max-w-64 flex-1 text-xs text-muted-foreground">{textPreview(content.text)}</span>
      )}
      <button
        type="button"
        onClick={accept}
        className="rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-brand-foreground"
      >
        {t('clipboard.insert')}
      </button>
      <button type="button" onClick={() => setContent(null)} className="rounded-md p-1 text-muted-foreground hover:text-foreground">
        <X className="size-3.5" />
      </button>
    </div>
  )
}
