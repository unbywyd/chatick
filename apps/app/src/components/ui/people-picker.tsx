import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, X } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

// Выбор людей: поиск + чипсы. Ряд кнопок со всеми участниками годится на трёх
// человек и разваливается на двадцати.

export type Person = { id: string; name: string; avatarUrl?: string | null; email?: string }

export function PeoplePicker({
  people,
  value,
  onChange,
  placeholder,
  className,
  single = false,
  clearLabel,
}: {
  people: Person[]
  value: string[]
  onChange: (ids: string[]) => void
  placeholder?: string
  className?: string
  /** одиночный выбор (фильтры «автор», «упомянут»): выбранный виден в кнопке */
  single?: boolean
  /** подпись пункта «сбросить» в одиночном режиме */
  clearLabel?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people])
  const picked = value.map((id) => byId.get(id)).filter(Boolean) as Person[]

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return people
      // в одиночном режиме выбранного не прячем: по нему видно, что выбрано
      .filter((p) => single || !value.includes(p.id))
      .filter((p) => !needle || p.name.toLowerCase().includes(needle) || (p.email ?? '').toLowerCase().includes(needle))
  }, [people, value, q, single])

  const add = (id: string) => {
    if (single) {
      onChange([id])
      setQ('')
      setOpen(false)
      return
    }
    onChange([...value, id])
    setQ('')
    inputRef.current?.focus()
  }

  return (
    <div className={cn('space-y-1.5', className)}>
      {!single && picked.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {picked.map((p) => (
            <span
              key={p.id}
              className="inline-flex items-center gap-1.5 rounded-full border py-0.5 pe-1.5 ps-0.5 text-xs"
            >
              <Avatar name={p.name} src={p.avatarUrl} size={18} />
              {p.name}
              <button
                type="button"
                onClick={() => onChange(value.filter((x) => x !== p.id))}
                className="text-muted-foreground transition-colors hover:text-destructive"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex h-9 w-full items-center gap-2 rounded-md border bg-background px-2 text-sm transition-colors hover:bg-accent',
              single && picked[0] ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {single && picked[0] ? (
              <>
                <Avatar name={picked[0].name} src={picked[0].avatarUrl} size={20} />
                <span className="min-w-0 flex-1 truncate text-start">{picked[0].name}</span>
                <X
                  className="size-3.5 shrink-0 text-muted-foreground transition-colors hover:text-destructive"
                  onClick={(e) => {
                    // сброс, не открывая список
                    e.stopPropagation()
                    onChange([])
                  }}
                />
              </>
            ) : (
              <>
                <Search className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-start">{placeholder ?? t('people.add')}</span>
              </>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
          <div className="border-b p-1.5">
            <input
              ref={inputRef}
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                // Enter выбирает первого в списке — набрал три буквы и дальше
                if (e.key === 'Enter' && matches[0]) {
                  e.preventDefault()
                  add(matches[0].id)
                }
              }}
              placeholder={t('people.search')}
              className="h-7 w-full bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-60 overflow-y-auto p-1">
            {single && value.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  onChange([])
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1.5 text-start text-sm text-muted-foreground transition-colors hover:bg-accent"
              >
                <X className="size-4" />
                {clearLabel ?? t('people.anyone')}
              </button>
            )}
            {matches.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => add(p.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-1.5 py-1.5 text-start text-sm transition-colors hover:bg-accent',
                  single && value.includes(p.id) && 'bg-accent font-medium',
                )}
              >
                <Avatar name={p.name} src={p.avatarUrl} size={20} />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
              </button>
            ))}
            {matches.length === 0 && (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                {value.length && !q.trim() ? t('people.allPicked') : t('people.noMatches')}
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
