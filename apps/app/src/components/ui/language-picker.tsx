import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Search } from 'lucide-react'
import { PROJECT_LANGUAGES, languageLabel, searchLanguages } from '@/lib/languages'
import { cn } from '@/lib/utils'

// Выбор языка проекта с поиском.
//
// Список длинный: ИИ работает с любым языком, и ограничивать его тремя, на
// которые переведён интерфейс, значит навязывать команде чужой язык. Длинный
// список без поиска бесполезен, поэтому здесь автодополнение.

export function LanguagePicker({
  value,
  onChange,
  disabled,
  className,
}: {
  value: string
  onChange: (code: string) => void
  disabled?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const found = useMemo(() => searchLanguages(q), [q])

  // Клик мимо и Esc закрывают — как у любого выпадающего списка
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    // Фокус в поиск: список открывают, чтобы найти, а не листать
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.clearTimeout(timer)
    }
  }, [open])

  const pick = (code: string) => {
    onChange(code)
    setOpen(false)
    setQ('')
  }

  return (
    <div ref={boxRef} className={cn('relative', className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-md border bg-transparent px-3 text-sm outline-none transition-shadow',
          'focus:ring-2 focus:ring-ring disabled:cursor-default disabled:opacity-50',
        )}
      >
        <span className="truncate">{languageLabel(value)}</span>
        <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border bg-popover shadow-lg">
          <div className="relative border-b">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                // Enter выбирает единственное найденное: искали именно его
                if (e.key === 'Enter' && found.length) {
                  e.preventDefault()
                  pick(found[0]!.code)
                }
              }}
              placeholder={t('projectForm.languageSearch')}
              className="h-9 w-full bg-transparent ps-8 pe-3 text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <ul className="max-h-64 overflow-y-auto p-1">
            {found.map((l) => (
              <li key={l.code}>
                <button
                  type="button"
                  onClick={() => pick(l.code)}
                  className={cn(
                    'flex w-full cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-start text-sm',
                    l.code === value ? 'text-brand-ink' : 'hover:bg-accent',
                  )}
                >
                  <span className="truncate">
                    {l.label}
                    {/* Английское название рядом: по нему ищут чаще, чем по самоназванию */}
                    {l.english !== l.label && (
                      <span className="ms-2 text-xs text-muted-foreground">{l.english}</span>
                    )}
                  </span>
                  {l.code === value && <Check className="size-3.5 shrink-0" />}
                </button>
              </li>
            ))}
            {!found.length && (
              <li className="px-2 py-6 text-center text-sm text-muted-foreground">
                {t('projectForm.languageNotFound')}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

export { PROJECT_LANGUAGES }
