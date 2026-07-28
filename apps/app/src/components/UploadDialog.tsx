import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { File as FileIcon, ImageIcon, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

// Подтверждение перед загрузкой файлов (SPEC §8.3).
//
// Файлы выбраны, но ещё не отправлены: сначала человек видит, что именно
// уходит, и решает, сжимать ли картинки. Раньше выбор файла сразу начинал
// загрузку — передумать было негде, а сжатие происходило молча.
//
// Оригиналы по умолчанию НЕ храним: вторая копия съедает всё, что даёт
// оптимизация. Галочка — осознанное исключение, а не настройка по привычке.

export type PendingUpload = { files: File[]; keepOriginal: boolean }

export function UploadDialog({
  files,
  busy = false,
  onCancel,
  onConfirm,
}: {
  files: File[]
  busy?: boolean
  onCancel: () => void
  onConfirm: (opts: { files: File[]; keepOriginal: boolean }) => void
}) {
  const { t } = useTranslation()
  const [keepOriginal, setKeepOriginal] = useState(false)
  const [list, setList] = useState(files)

  // Диалог переиспользуется: выбрали файлы, отменили, выбрали снова — React
  // оставляет прежний компонент, и список внутри остаётся от прошлого раза.
  // Выглядело так, будто новый выбор не срабатывает вовсе.
  useEffect(() => {
    setList(files)
    setKeepOriginal(false)
  }, [files])

  // Список опустошили крестиками — закрываем: пустое окно с недоступной
  // кнопкой ничего не сообщает, а закрыть его человек пытается тем же
  // выбором файлов, который тогда попадает в уже открытый диалог.
  useEffect(() => {
    if (!list.length) onCancel()
  }, [list.length, onCancel])

  const images = list.filter((f) => f.type.startsWith('image/'))
  const totalSize = list.reduce((n, f) => n + f.size, 0)

  // Esc отменяет — из модального окна должен быть выход без мыши.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onCancel()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={() => !busy && onCancel()}>
      <div className="w-full max-w-md space-y-3 rounded-xl border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold">{t('upload.title', { count: list.length })}</h2>

        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {list.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-2.5 rounded-md border bg-card px-2.5 py-2">
              {f.type.startsWith('image/') ? (
                <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{fmtSize(f.size)}</span>
              {/* Передумать по одному файлу, а не отменять всё и выбирать заново */}
              {list.length > 1 && (
                <button
                  className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
                  title={t('upload.remove')}
                  onClick={() => setList((prev) => prev.filter((_, j) => j !== i))}
                >
                  <X className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>

        {/* Только когда есть что сжимать: с одними документами галочка
            ничего не значит и лишь заставляет гадать, о чём она. */}
        {images.length > 0 && (
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border bg-card p-2.5">
            <input
              type="checkbox"
              checked={keepOriginal}
              onChange={(e) => setKeepOriginal(e.target.checked)}
              className="mt-0.5 size-4 accent-brand"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t('upload.keepOriginal')}</span>
              <span className="block text-xs text-muted-foreground">{t('upload.keepOriginalHint')}</span>
            </span>
          </label>
        )}

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">{fmtSize(totalSize)}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="brand"
              size="sm"
              disabled={!list.length || busy}
              onClick={() => onConfirm({ files: list, keepOriginal })}
            >
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {t('upload.send')}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Нужен ли вопрос про оригиналы.
 *
 * Без картинок сжимать нечего: показывать диалог значило бы добавить шаг
 * ради галочки, которая ни на что не влияет.
 */
export const hasImages = (files: File[]) => files.some((f) => f.type.startsWith('image/'))
