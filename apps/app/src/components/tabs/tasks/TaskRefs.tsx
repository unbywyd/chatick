import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

// Свои номера задачи (SPEC §8.6).
//
// То, чем задачу зовут ВНЕ Chatick: экраны в макете, пункты договора, позиции
// сметы. Поле намеренно свободное — у каждой команды свой счёт, и навязывать
// формат значит сделать поле бесполезным для всех, кроме одной.
//
// Разбираем ТОЛЬКО по запятой. «12 - 14» — один номер: у одних это диапазон
// экранов, у других составной шифр, и решать за них нельзя.

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
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) setDraft(value ?? '')
  }, [value, editing])

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const refs = parseRefs(value ?? '')

  const commit = () => {
    setEditing(false)
    // Сравниваем по разобранному виду: «1,2» и «1, 2» — одно и то же, и слать
    // из-за пробела запрос незачем.
    if (parseRefs(draft).join(', ') !== refs.join(', ')) onChange(draft)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(ALLOWED, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation() // строка таблицы открывается по клавишам — не здесь
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            setDraft(value ?? '')
            setEditing(false)
          }
        }}
        onClick={(e) => e.stopPropagation()}
        placeholder={t('tasks.refsPlaceholder')}
        className={cn(
          'w-full min-w-0 rounded border bg-transparent px-1.5 outline-none focus:ring-2 focus:ring-ring',
          compact ? 'py-0 text-xs' : 'py-0.5 text-sm',
          className,
        )}
      />
    )
  }

  // Пусто и править нельзя — показывать нечего.
  if (!refs.length && !canEdit) return null

  return (
    <span
      role={canEdit ? 'button' : undefined}
      tabIndex={canEdit ? 0 : undefined}
      onClick={
        canEdit
          ? (e) => {
              e.stopPropagation() // клик по строке открывает задачу — здесь не нужно
              setEditing(true)
            }
          : undefined
      }
      onKeyDown={canEdit ? (e) => (e.key === 'Enter' ? setEditing(true) : undefined) : undefined}
      title={canEdit ? t('tasks.refsHint') : undefined}
      className={cn('inline-flex flex-wrap items-center gap-1', canEdit && 'cursor-text', className)}
    >
      {refs.length ? (
        refs.map((ref, i) => (
          <span
            key={`${ref}:${i}`}
            // Слегка скруглённые, а не овальные: это номер, а не ярлык
            // состояния. Цифры чуть жирнее — их и высматривают в списке.
            className={cn(
              'rounded bg-secondary font-semibold tabular-nums text-foreground',
              compact ? 'px-1 py-0 text-[11px]' : 'px-1.5 py-0.5 text-xs',
            )}
          >
            {ref}
          </span>
        ))
      ) : (
        <span className={cn('text-muted-foreground', compact ? 'text-[11px]' : 'text-xs')}>{REFS_SIGN}</span>
      )}
    </span>
  )
}
