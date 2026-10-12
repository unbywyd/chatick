import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'

/**
 * Календарь и поле даты в стиле макета — вместо системного <input type="date">:
 * тот показывает «дд.мм.гггг», в каждом браузере выглядит по-своему и не
 * красится под тему. Даты — строками yyyy-mm-dd (местный день, без часовых
 * поясов): так их и хранят формы.
 */

export const toYmd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const fromYmd = (s: string) => {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d)
}

/** Неделя с понедельника, кроме иврита — там с воскресенья, как в Израиле. */
const weekStartFor = (lng: string) => (lng.startsWith('he') ? 0 : 1)

export function Calendar({ value, onPick, weekStart }: { value: string | null; onPick: (ymd: string) => void; weekStart?: number }) {
  const { i18n } = useTranslation()
  const lng = i18n.language
  const ws = weekStart ?? weekStartFor(lng)
  const today = toYmd(new Date())
  const [view, setView] = useState(() => {
    const d = value ? fromYmd(value) : new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const first = new Date(view.getFullYear(), view.getMonth(), 1)
  const lead = (first.getDay() - ws + 7) % 7
  const days: Date[] = []
  for (let i = 0; i < 42; i++) days.push(new Date(view.getFullYear(), view.getMonth(), 1 - lead + i))
  // Шесть недель не нужны, если месяц укладывается в пять.
  const cells = days[35]!.getMonth() !== view.getMonth() ? days.slice(0, 35) : days
  const names = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 7 + ((ws + i) % 7)).toLocaleDateString(lng, { weekday: 'short' }))
  const shift = (n: number) => setView(new Date(view.getFullYear(), view.getMonth() + n, 1))
  return (
    <div className="cal">
      <div className="cal-h">
        <button className="ib" onClick={() => shift(-1)} aria-label="‹">
          <Icon name="chevronStart" sm />
        </button>
        <b>{view.toLocaleDateString(lng, { month: 'long', year: 'numeric' })}</b>
        <button className="ib" onClick={() => shift(1)} aria-label="›">
          <Icon name="chevronEnd" sm />
        </button>
      </div>
      <div className="cal-g" role="grid">
        {names.map((n) => (
          <span key={n} className="cal-w">
            {n}
          </span>
        ))}
        {cells.map((d) => {
          const k = toYmd(d)
          const out = d.getMonth() !== view.getMonth()
          return (
            <button
              key={k}
              className={'cal-d' + (out ? ' out' : '') + (k === today ? ' now' : '') + (k === value ? ' on' : '')}
              onClick={() => onPick(k)}
              aria-pressed={k === value}
              aria-label={d.toLocaleDateString(lng, { day: 'numeric', month: 'long', year: 'numeric' })}
            >
              {d.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Всплывающий слой с подложкой-«закрывашкой»: общий для полей даты и выбора. */
export function Pop({ open, onClose, children, wide, align = 'start' }: { open: boolean; onClose: () => void; children: React.ReactNode; wide?: boolean; align?: 'start' | 'end' }) {
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [open, onClose])
  if (!open) return null
  return (
    <>
      <div className="gt-scrim" onClick={onClose} />
      <div className={'upop' + (wide ? ' wide' : '') + (align === 'end' ? ' end' : '')} role="dialog">
        {children}
      </div>
    </>
  )
}

/**
 * Поле даты: кнопка с датой → календарь. clearable — «Убрать дату».
 * quick — быстрые варианты над календарём (сегодня, завтра, через неделю).
 */
export function DateField({
  value,
  onChange,
  placeholder,
  clearable,
  quick,
  className,
  ariaLabel,
}: {
  value: string | null
  onChange: (ymd: string | null) => void
  placeholder?: string
  clearable?: boolean
  quick?: boolean
  className?: string
  ariaLabel?: string
}) {
  const { t, i18n } = useTranslation('v2')
  const [open, setOpen] = useState(false)
  const pick = (v: string | null) => {
    setOpen(false)
    onChange(v)
  }
  const plus = (n: number) => {
    const d = new Date()
    d.setDate(d.getDate() + n)
    return toYmd(d)
  }
  return (
    <span className="ufield">
      <button className={'udate' + (className ? ' ' + className : '')} onClick={() => setOpen(!open)} aria-expanded={open} aria-label={ariaLabel}>
        <Icon name="calendar" sm />
        <span>{value ? fromYmd(value).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short', year: 'numeric' }) : (placeholder ?? t('ui.pickDate'))}</span>
      </button>
      <DatePop open={open} onClose={() => setOpen(false)} value={value} onPick={pick} clearable={clearable} quick={quick} plus={plus} />
    </span>
  )
}

export function DatePop({
  open,
  onClose,
  value,
  onPick,
  clearable,
  quick,
  plus = (n: number) => {
    const d = new Date()
    d.setDate(d.getDate() + n)
    return toYmd(d)
  },
}: {
  open: boolean
  onClose: () => void
  value: string | null
  onPick: (ymd: string | null) => void
  clearable?: boolean
  quick?: boolean
  plus?: (n: number) => string
}) {
  const { t } = useTranslation('v2')
  return (
    <Pop open={open} onClose={onClose}>
      {quick && (
        <div className="uquick">
          <button onClick={() => onPick(plus(0))}>{t('due.today')}</button>
          <button onClick={() => onPick(plus(1))}>{t('due.tomorrow')}</button>
          <button onClick={() => onPick(plus(7))}>{t('row.week')}</button>
        </div>
      )}
      <Calendar value={value} onPick={onPick} />
      {clearable && value && (
        <button className="uclear" onClick={() => onPick(null)}>
          {t('row.noDue')}
        </button>
      )}
    </Pop>
  )
}

/**
 * Выбор из списка вместо системного <select>: стрелки, Enter, поиск, когда
 * вариантов много.
 */
export function Select<V extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  searchable,
}: {
  value: V
  options: { value: V; label: string; hint?: string }[]
  onChange: (v: V) => void
  ariaLabel?: string
  searchable?: boolean
}) {
  const { t } = useTranslation('v2')
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const s = q.trim().toLowerCase()
  const shown = options.filter((o) => !s || o.label.toLowerCase().includes(s))
  const cur = options.find((o) => o.value === value)
  useEffect(() => {
    if (open) setI(Math.max(0, shown.findIndex((o) => o.value === value)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const pick = (v: V) => {
    setOpen(false)
    setQ('')
    onChange(v)
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setI((x) => Math.min(shown.length - 1, x + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setI((x) => Math.max(0, x - 1))
    } else if (e.key === 'Enter' && shown[i]) {
      e.preventDefault()
      pick(shown[i]!.value)
    }
  }
  return (
    <span className="ufield">
      <button className="usel" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} onKeyDown={open ? onKey : undefined}>
        <span className="bidi">{cur?.label ?? '—'}</span>
        <Icon name="chevron" sm />
      </button>
      <Pop open={open} onClose={() => setOpen(false)} wide>
        {(searchable ?? options.length > 8) && (
          <label className="cbx-s" style={{ margin: '0 4px 6px' }}>
            <Icon name="search" sm />
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder={t('ui.find')} aria-label={t('ui.find')} autoFocus />
          </label>
        )}
        <div ref={list} role="listbox" className="ulist" tabIndex={-1} onKeyDown={onKey}>
          {shown.map((o, k) => (
            <button key={o.value} role="option" aria-selected={o.value === value} className={'gp' + (k === i ? ' sel' : '') + (o.value === value ? ' cur' : '')} onMouseEnter={() => setI(k)} onClick={() => pick(o.value)}>
              <span className="nm bidi">{o.label}</span>
              {o.hint && <small className="uhint">{o.hint}</small>}
              {o.value === value && <Icon name="check" sm />}
            </button>
          ))}
          {!shown.length && <div className="cbx-none">{t('ui.nothing')}</div>}
        </div>
      </Pop>
    </span>
  )
}
