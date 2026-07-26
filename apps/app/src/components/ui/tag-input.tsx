import { useRef, useState, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

// Ввод тегов чипсами: Enter или запятая добавляют, Backspace в пустом поле
// удаляет последний, клик по крестику убирает конкретный.

export function TagInput({
  value,
  onChange,
  suggestions = [],
  placeholder,
  max = 20,
  className,
}: {
  value: string[]
  onChange: (tags: string[]) => void
  /** уже использованные теги проекта — подсказка вместо угадывания */
  suggestions?: string[]
  placeholder?: string
  max?: number
  className?: string
}) {
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const add = (raw: string) => {
    // теги нормализуем к нижнему регистру: «DNS» и «dns» — один тег, иначе
    // фильтр по тегам разваливается на дубликаты
    const tag = raw.trim().toLowerCase().replace(/^#/, '')
    if (!tag || value.includes(tag) || value.length >= max) return
    onChange([...value, tag])
  }

  const commitDraft = () => {
    if (draft.trim()) add(draft)
    setDraft('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commitDraft()
      return
    }
    if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1))
    }
  }

  // подсказываем только то, чего ещё нет и что подходит под набранное
  const hints = suggestions
    .filter((s) => !value.includes(s) && (!draft.trim() || s.includes(draft.trim().toLowerCase())))
    .slice(0, 8)

  return (
    <div className={cn('relative', className)}>
      <div
        onClick={() => inputRef.current?.focus()}
        className={cn(
          'flex min-h-9 w-full cursor-text flex-wrap items-center gap-1.5 rounded-md border bg-background px-2 py-1.5 text-sm',
          focused && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
        )}
      >
        {value.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-xs">
            #{tag}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onChange(value.filter((x) => x !== tag))
              }}
              className="text-muted-foreground transition-colors hover:text-destructive"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => {
            // вставка «a, b, c» разбивается сразу, а не остаётся одной строкой
            if (e.target.value.includes(',')) {
              const parts = e.target.value.split(',')
              parts.slice(0, -1).forEach(add)
              setDraft(parts[parts.length - 1] ?? '')
              return
            }
            setDraft(e.target.value)
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            commitDraft() // не теряем набранное при уходе фокуса
          }}
          placeholder={value.length ? '' : placeholder}
          className="min-w-24 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        />
      </div>

      {focused && hints.length > 0 && (
        <div className="absolute z-20 mt-1 flex w-full flex-wrap gap-1 rounded-md border bg-popover p-2 shadow-md">
          {hints.map((s) => (
            <button
              key={s}
              type="button"
              // onMouseDown, а не onClick: blur инпута успел бы закрыть подсказки
              onMouseDown={(e) => {
                e.preventDefault()
                add(s)
                setDraft('')
              }}
              className="rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              #{s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
