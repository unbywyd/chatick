import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Search } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

// Селект с поиском: обычный список бесполезен, когда вариантов сотни —
// часовые пояса, задачи, длинные справочники.

export type ComboOption = { value: string; label: string; hint?: string }

export function Combobox({
  options,
  value,
  onChange,
  placeholder,
  emptyText,
  className,
}: {
  options: ComboOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  emptyText?: string
  className?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')

  const current = options.find((o) => o.value === value)

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return options.slice(0, 200)
    return options
      .filter((o) => o.label.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle))
      .slice(0, 200)
  }, [options, q])

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setQ('')
      }}
    >
      <PopoverTrigger asChild>
        <button
          className={cn(
            'flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-background px-2 text-sm',
            'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            className,
          )}
        >
          <span className={cn('truncate', !current && 'text-muted-foreground')}>
            {current?.label ?? placeholder ?? '—'}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <div className="flex items-center gap-1.5 border-b px-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // Enter берёт первое совпадение — набрал «jeru», нажал, готово
              if (e.key === 'Enter' && matches[0]) {
                onChange(matches[0].value)
                setOpen(false)
              }
            }}
            placeholder={t('people.search')}
            className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {matches.map((o) => (
            <button
              key={o.value}
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent"
            >
              <Check className={cn('size-3.5 shrink-0', o.value === value ? 'opacity-100' : 'opacity-0')} />
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.hint && <span className="shrink-0 text-xs text-muted-foreground">{o.hint}</span>}
            </button>
          ))}
          {!matches.length && (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">{emptyText ?? t('people.noMatches')}</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
