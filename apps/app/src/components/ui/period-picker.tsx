import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarRange, ChevronDown } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { DatePicker } from '@/components/ui/date-picker'
import { cn } from '@/lib/utils'

// Один контрол вместо двух полей даты и россыпи кнопок: период — это ОДНА
// величина, и выбирают его либо готовым пресетом, либо парой дат.

export type Period = { from: string; to: string }

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export type PresetKey =
  | 'today'
  | 'yesterday'
  | 'thisWeek'
  | 'lastWeek'
  | 'thisMonth'
  | 'lastMonth'
  | 'last7'
  | 'last30'
  | 'last90'
  | 'thisYear'
  | 'all'

/**
 * Календарные пресеты считаются от начала периода, а не «минус N дней»:
 * «этот месяц» — это с 1-го числа, именно так спрашивают, когда сводят месяц.
 * weekStart приходит из настроек проекта (в Израиле неделя с воскресенья).
 */
export function resolvePreset(key: PresetKey, weekStart = 1): Period {
  const now = new Date()
  const today = iso(now)

  const startOfWeek = (ref: Date) => {
    const d = new Date(ref)
    const shift = (d.getDay() - weekStart + 7) % 7
    d.setDate(d.getDate() - shift)
    return d
  }
  const back = (days: number) => {
    const d = new Date(now)
    d.setDate(d.getDate() - days)
    return iso(d)
  }

  switch (key) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday': {
      const d = new Date(now)
      d.setDate(d.getDate() - 1)
      return { from: iso(d), to: iso(d) }
    }
    case 'thisWeek':
      return { from: iso(startOfWeek(now)), to: today }
    case 'lastWeek': {
      const start = startOfWeek(now)
      start.setDate(start.getDate() - 7)
      const end = new Date(start)
      end.setDate(end.getDate() + 6)
      return { from: iso(start), to: iso(end) }
    }
    case 'thisMonth':
      return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: today }
    case 'lastMonth': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const end = new Date(now.getFullYear(), now.getMonth(), 0)
      return { from: iso(start), to: iso(end) }
    }
    case 'last7':
      return { from: back(7), to: today }
    case 'last30':
      return { from: back(30), to: today }
    case 'last90':
      return { from: back(90), to: today }
    case 'thisYear':
      return { from: iso(new Date(now.getFullYear(), 0, 1)), to: today }
    case 'all':
      return { from: '', to: '' }
  }
}

const PRESETS: PresetKey[] = [
  'today',
  'yesterday',
  'thisWeek',
  'lastWeek',
  'thisMonth',
  'lastMonth',
  'last7',
  'last30',
  'last90',
  'thisYear',
  // «Всё время» убрано намеренно. Оно поднимало КАЖДУЮ запись компании: на
  // молодой это 92 строки, но при дюжине человек, отмечающих время дважды в
  // день, за пять лет набегает тысяч тридцать — секунды ожидания и лишний
  // объём по сети ради верхушки, которую и смотрят.
  //
  // Максимум теперь «Этот год»; кому нужно глубже, выбирает даты календарём —
  // осознанно и зная, за что платит ожиданием.
]

export function PeriodPicker({
  value,
  onChange,
  weekStart = 1,
  className,
}: {
  value: Period
  onChange: (p: Period) => void
  weekStart?: number
  className?: string
}) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)

  /**
   * Какой вариант выбран сейчас — чтобы показать его имя вместо дат.
   *
   * Помним ВЫБРАННЫЙ вариант, а не только вычисляем его из дат. Разные
   * варианты дают одни и те же даты чаще, чем кажется: 1 сентября «этот
   * месяц» — это с 1-го по 1-е, то есть буквально «сегодня». Поиск по датам
   * возвращал первый совпавший из списка, и галочка вставала на «Сегодня» —
   * человек выбирал «Этот месяц», а выбиралось другое.
   *
   * Запомненный вариант сбрасывается, как только даты перестают ему отвечать
   * (их поменяли снаружи или выбрали календарём).
   */
  const [picked, setPicked] = useState<PresetKey | null>(null)
  const activePreset = useMemo(() => {
    if (picked) {
      const p = resolvePreset(picked, weekStart)
      if (p.from === value.from && p.to === value.to) return picked
    }
    return PRESETS.find((key) => {
      const p = resolvePreset(key, weekStart)
      return p.from === value.from && p.to === value.to
    })
  }, [value, weekStart, picked])

  const label = useMemo(() => {
    if (activePreset) return t(`period.${activePreset}`)
    if (!value.from && !value.to) return t('period.all')
    const fmt = (d: string) =>
      d ? new Date(`${d}T00:00:00`).toLocaleDateString(i18n.language, { day: '2-digit', month: 'short' }) : '…'
    return `${fmt(value.from)} — ${fmt(value.to)}`
  }, [activePreset, value, t, i18n.language])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            'flex h-9 items-center gap-2 rounded-md border bg-background px-2.5 text-sm transition-colors hover:bg-accent',
            className,
          )}
        >
          <CalendarRange className="size-3.5 shrink-0 text-muted-foreground" />
          {/* Распорка: без неё стрелка липнет к тексту, когда кнопка шире
              содержимого. */}
          <span className="min-w-0 flex-1 truncate text-start">{label}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="flex">
          <ul className="w-40 border-e p-1">
            {PRESETS.map((key) => (
              <li key={key}>
                <button
                  onClick={() => {
                    setPicked(key)
                    onChange(resolvePreset(key, weekStart))
                    setOpen(false)
                  }}
                  className={cn(
                    'w-full rounded-sm px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent',
                    activePreset === key && 'bg-brand/10 text-foreground',
                  )}
                >
                  {t(`period.${key}`)}
                </button>
              </li>
            ))}
          </ul>

          {/* точные даты — рядом, а не отдельным блоком на странице */}
          <div className="space-y-2 p-3">
            <div>
              <p className="mb-1 text-xs text-muted-foreground">{t('journal.from')}</p>
              <DatePicker value={value.from} onChange={(from) => onChange({ ...value, from })} className="w-40" />
            </div>
            <div>
              <p className="mb-1 text-xs text-muted-foreground">{t('journal.to')}</p>
              <DatePicker value={value.to} onChange={(to) => onChange({ ...value, to })} className="w-40" />
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
