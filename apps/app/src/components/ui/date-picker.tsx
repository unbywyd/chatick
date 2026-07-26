import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarDays, X } from 'lucide-react'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

// Поле даты: набрать руками ИЛИ выбрать в календаре. Нативный <input type="date">
// показывает маску вида «дд.мм.гггг», ведёт себя по-разному в браузерах и не
// поддаётся оформлению — поэтому свой.

/** ISO (yyyy-mm-dd) → как принято в локали. */
function format(iso: string, locale: string): string {
  if (!iso) return ''
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' })
}

/**
 * Разбирает то, что человек набрал: 5.3.26, 05/03/2026, 2026-03-05.
 * День и месяц в том порядке, в каком их пишут в локали, — иначе 03.05 читается
 * как 3 мая у одних и 5 марта у других.
 */
function parse(input: string, dayFirst: boolean): string | null {
  const raw = input.trim()
  if (!raw) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw

  const parts = raw.split(/[.\-/\s]+/).filter(Boolean).map(Number)
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null

  let [a, b, y] = parts as [number, number, number]
  const day = dayFirst ? a : b
  const month = dayFirst ? b : a
  if (y < 100) y += 2000 // «26» — это 2026, а не 26 год

  const d = new Date(y, month - 1, day)
  // проверяем, что дата существует: 31 февраля Date молча превратит в 3 марта
  if (d.getFullYear() !== y || d.getMonth() !== month - 1 || d.getDate() !== day) return null
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function DatePicker({
  value,
  onChange,
  placeholder,
  clearable = true,
  className,
}: {
  /** ISO yyyy-mm-dd или '' */
  value: string
  onChange: (iso: string) => void
  placeholder?: string
  clearable?: boolean
  className?: string
}) {
  const { i18n } = useTranslation()
  const locale = i18n.resolvedLanguage ?? 'en'
  // в en-US месяц идёт первым, в ru/he — день
  const dayFirst = !locale.startsWith('en')

  const [text, setText] = useState(() => format(value, locale))
  const [invalid, setInvalid] = useState(false)
  const [open, setOpen] = useState(false)

  // значение могли поменять снаружи (сброс фильтров, загрузка формы)
  useEffect(() => {
    setText(format(value, locale))
    setInvalid(false)
  }, [value, locale])

  const commit = (raw: string) => {
    const iso = parse(raw, dayFirst)
    if (iso === null) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    onChange(iso)
    setText(format(iso, locale))
  }

  return (
    <div className={cn('relative', className)}>
      <input
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setInvalid(false)
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit(text)
          }
        }}
        placeholder={placeholder ?? (dayFirst ? 'дд.мм.гггг' : 'mm/dd/yyyy')}
        className={cn(
          'h-9 w-full rounded-md border bg-background px-2 pe-16 text-sm outline-none',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          invalid && 'border-destructive',
        )}
      />

      <div className="absolute inset-y-0 end-1 flex items-center gap-0.5">
        {clearable && value && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
            >
              <CalendarDays className="size-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2" align="end">
            <Calendar
              selected={value ? new Date(`${value}T00:00:00`) : undefined}
              onSelect={(d) => {
                if (d) {
                  // локальные компоненты, а не toISOString: он переводит в UTC и
                  // в минусовых поясах отдаёт вчерашний день
                  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                  onChange(iso)
                }
                setOpen(false)
              }}
            />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
