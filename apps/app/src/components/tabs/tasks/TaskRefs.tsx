import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'

// Свои номера задачи (SPEC §8.6).
//
// То, чем задачу зовут ВНЕ Chatick: экраны в макете, пункты договора, позиции
// сметы. Поле намеренно свободное — у каждой команды свой счёт, и навязывать
// формат значит сделать поле бесполезным для всех, кроме одной.
//
// Разбираем ТОЛЬКО по запятой. «12 - 14» — один номер: у одних это диапазон
// экранов, у других составной шифр, и решать за них нельзя.
//
// Правка — в поповере, а не полем на месте. Инлайн-поле стояло в узкой ячейке
// таблицы и в плотной строке карточки: по клику оно раздвигало строку и
// переносило соседей, а попасть по самим цифрам было почти нечем.

/** Цифры, точки, дефисы и пробелы внутри; запятая — разделитель. */
const ALLOWED = /[^0-9.\-\s,]/g

export function parseRefs(value: string): string[] {
  return value
    .replace(ALLOWED, '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

/** Международный знак номера: одинаково читается на любом языке интерфейса. */
export const REFS_SIGN = '№'

export function TaskRefs({
  value,
  canEdit,
  onChange,
  compact = false,
  className,
}: {
  value: string | undefined
  canEdit: boolean
  onChange: (next: string) => void
  /** в таблице чипы мельче: в колонку должно влезать три-четыре */
  compact?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const refs = parseRefs(value ?? '')

  // В таблице показываем первые два номера, остальные — счётчиком.
  //
  // У задачи их бывает и десять: строка разъезжалась на четыре ряда, и колонка
  // номеров начинала задавать высоту всей таблице. Читать по ним всё равно
  // нечего — по номерам ищут конкретный, а для этого есть поповер, он и так
  // открывается по клику. Полный список уезжает в подсказку, чтобы его можно
  // было увидеть не открывая.
  const LIMIT = 2
  const shown = compact ? refs.slice(0, LIMIT) : refs
  const hidden = refs.length - shown.length

  const chips = (
    <span
      className={cn(
        'inline-flex items-center',
        // В таблице в одну строку: перенос — это и есть то, что разгоняло высоту.
        compact ? 'flex-nowrap gap-0.5' : 'flex-wrap gap-1',
      )}
    >
      {/* Знак номера — подписью ко всему ряду, а не в каждом чипе: повторять
          его у каждого числа значит превращать метку в шум. dir="ltr" — чтобы
          в иврите он остался ПЕРЕД числами, а не уехал за них.
          В таблице знака нет вовсе: там он стоит в шапке колонки, и повторять
          его в каждой строке — то же самое, только на весь столбец. */}
      {!compact && (
        <span dir="ltr" className="me-0.5 shrink-0 text-xs text-muted-foreground">
          {REFS_SIGN}
        </span>
      )}
      {shown.map((ref, i) => (
        <span
          key={`${ref}:${i}`}
          // Слегка скруглённые, а не овальные: это номер, а не ярлык состояния.
          className={cn(
            'rounded bg-secondary font-semibold tabular-nums text-foreground',
            compact ? 'px-1 py-0 text-[11px]' : 'px-1.5 py-0.5 text-xs',
            // Номер бывает и составным («12 - 14»): в таблице обрезаем, чтобы
            // одно длинное значение не растянуло колонку на всех.
            compact && 'max-w-[3.5rem] truncate',
          )}
        >
          {ref}
        </span>
      ))}
      {hidden > 0 && (
        <span dir="ltr" className="shrink-0 px-0.5 text-[11px] tabular-nums text-muted-foreground">
          +{hidden}
        </span>
      )}
    </span>
  )

  // Спрятанные номера — в подсказку: увидеть все, не открывая поповер.
  const hint = hidden > 0 ? `${REFS_SIGN} ${refs.join(', ')}` : t('tasks.refsHint')

  // Пусто и править нельзя — показывать нечего.
  if (!refs.length && !canEdit) return null
  if (!canEdit)
    return (
      <span className={className} title={hidden > 0 ? hint : undefined}>
        {chips}
      </span>
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={hint}
          onClick={(e) => e.stopPropagation()} // клик по строке открывает задачу
          className={cn(
            // Как у соседних управляемых полей: рамка по наведению и стрелка,
            // иначе не видно, что по этому месту вообще можно нажать.
            'inline-flex items-center gap-1 rounded-md transition-colors hover:bg-accent',
            compact ? 'px-1 py-0.5' : 'px-1.5 py-1',
            className,
          )}
        >
          {chips}
          <ChevronDown className="size-3 shrink-0 opacity-40" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2" onClick={(e) => e.stopPropagation()}>
        <RefsEditor refs={refs} onChange={onChange} />
      </PopoverContent>
    </Popover>
  )
}

/**
 * Редактор номеров: готовые — чипами с крестиком, новый — полем снизу.
 *
 * Каждый номер отдельной сущностью, а не одной строкой с запятыми: строку
 * приходилось перечитывать глазами, чтобы понять, где кончается один номер и
 * начинается другой, — а «4 - 3» посреди неё выглядит как два.
 */
function RefsEditor({ refs, onChange }: { refs: string[]; onChange: (next: string) => void }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const commit = (next: string[]) => onChange(next.join(', '))

  const add = () => {
    // Запятую внутри набранного тоже разбираем: её жмут по привычке, и
    // «1, 2» одним вводом должно дать два номера, а не один сломанный.
    const parts = parseRefs(draft)
    if (!parts.length) return
    setDraft('')
    commit([...refs, ...parts])
  }

  return (
    <div className="space-y-2">
      {refs.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {/* Та же подпись, что и снаружи: одна на ряд, а не у каждого числа. */}
          <span dir="ltr" className="me-0.5 shrink-0 text-xs text-muted-foreground">
            {REFS_SIGN}
          </span>
          {refs.map((ref, i) => (
            <span
              key={`${ref}:${i}`}
              className="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-xs font-semibold tabular-nums"
            >
              {ref}
              <button
                type="button"
                title={t('files.delete')}
                onClick={() => commit(refs.filter((_, j) => j !== i))}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(ALLOWED, ''))}
        onBlur={add}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            add()
          }
          // Backspace на пустом поле убирает последний — привычно по любому
          // полю тегов и избавляет от прицеливания в крестик.
          if (e.key === 'Backspace' && !draft && refs.length) commit(refs.slice(0, -1))
        }}
        placeholder={t('tasks.refsPlaceholder')}
        className="w-full rounded border bg-transparent px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
      <p className="text-[11px] leading-snug text-muted-foreground">{t('tasks.refsHint')}</p>
    </div>
  )
}
