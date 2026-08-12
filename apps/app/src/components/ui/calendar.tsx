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
        day_button: 'grid size-9 place-items-center rounded-md text-sm transition-colors hover:bg-accent',
        // Выделение вешаем на ЯЧЕЙКУ дня, а не на кнопку внутри.
        //
        // aria-selected в react-day-picker v10 стоит на ячейке, поэтому
        // «aria-selected:…» на day_button не срабатывало никогда: выбранный
        // день ничем не отличался от остальных. Заметно это стало на записи от
        // 5 августа — подсвеченным выглядел 6-е, то есть просто «сегодня».
        selected: '[&>button]:bg-brand [&>button]:font-semibold [&>button]:text-brand-foreground',
        // Сегодня — жирным и цветом. Цвет задаём кнопке, чтобы выделение выше
        // его перебивало: у выбранного сегодняшнего дня иначе остаётся
        // брендовый текст на брендовом фоне, то есть нечитаемый.
        today: 'font-bold [&>button]:text-brand-ink',
        outside: 'text-muted-foreground/40',
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === 'left' ? <ChevronLeft className="size-4 rtl:-scale-x-100" /> : <ChevronRight className="size-4 rtl:-scale-x-100" />,
      }}
      className="relative"
    />
  )
}
