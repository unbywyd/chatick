import { DayPicker } from 'react-day-picker'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { enUS, ru, he } from 'react-day-picker/locale'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

const LOCALES = { en: enUS, ru, he } as const

// Календарь (react-day-picker v9) в дизайн-системе, с локалями en/ru/he
export function Calendar({
  selected,
  onSelect,
}: {
  selected?: Date
  onSelect: (d: Date | undefined) => void
}) {
  const { i18n } = useTranslation()
  const locale = LOCALES[(i18n.resolvedLanguage as keyof typeof LOCALES) ?? 'en'] ?? enUS

  return (
    <DayPicker
      mode="single"
      selected={selected}
      onSelect={onSelect}
      locale={locale}
      dir={document.documentElement.dir}
      showOutsideDays
      classNames={{
        root: 'rdp-root text-sm',
        months: 'flex flex-col',
        month: 'space-y-3',
        month_caption: 'flex items-center justify-center h-8 font-medium',
        nav: 'absolute inset-x-2 top-3 flex items-center justify-between',
        button_previous: 'grid size-7 place-items-center rounded-md hover:bg-accent',
        button_next: 'grid size-7 place-items-center rounded-md hover:bg-accent',
        month_grid: 'border-collapse',
        weekdays: 'flex',
        weekday: 'w-9 text-center text-xs font-normal text-muted-foreground',
        week: 'flex mt-1',
        day: 'p-0',
        day_button: cn(
          'grid size-9 place-items-center rounded-md text-sm transition-colors hover:bg-accent',
          'aria-selected:bg-brand aria-selected:font-semibold aria-selected:text-brand-foreground',
        ),
        today: 'font-bold text-brand',
        outside: 'text-muted-foreground/40',
        selected: '',
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === 'left' ? <ChevronLeft className="size-4 rtl:-scale-x-100" /> : <ChevronRight className="size-4 rtl:-scale-x-100" />,
      }}
      className="relative"
    />
  )
}
