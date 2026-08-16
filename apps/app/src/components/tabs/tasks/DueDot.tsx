import { useTranslation } from 'react-i18next'
import { CalendarClock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DUE_COLOR, dueDays, dueLevel, type Task } from './types'

/**
 * Срок в таблице — одной иконкой.
 *
 * В таблице места под дату нет, а знать про срок надо. Иконка занимает колонку
 * в четыре символа шириной и отвечает на главный вопрос — «горит?» — цветом,
 * до всякого чтения. Подробности (дата и остаток) уходят в подсказку: она
 * нужна для одной строки за раз, а не для всех сразу.
 *
 * Подсказка — родной title, как у остальной таблицы: свой тултип пришлось бы
 * держать открытым при скролле и уводить с тач-экранов, а выигрыш здесь —
 * ровно ноль.
 *
 * Цвет никогда не единственный признак: без срока иконки нет вовсе, а текст
 * подсказки повторяет всё словами — дальтонику зелёный и оранжевый различать
 * не придётся.
 */
export function DueDot({ task, className }: { task: Task; className?: string }) {
  const { t, i18n } = useTranslation()
  const level = dueLevel(task)

  // Ни срока, ни смысла: у выполненной задачи дата уже ничего не решает.
  if (!level) return null

  const left = dueDays(task.dueDate)
  const date = new Date(task.dueDate!).toLocaleDateString(i18n.language, { dateStyle: 'long' })
  const rest =
    left === null
      ? ''
      : left < 0
        ? t('tasks.dueOverdueBy', { count: Math.abs(left) })
        : left === 0
          ? t('tasks.dueToday')
          : left === 1
            ? t('tasks.dueTomorrow')
            : t('tasks.dueInDays', { count: left })

  return (
    <span
      className={cn('inline-flex items-center', DUE_COLOR[level], className)}
      title={`${t('tasks.dueLabel')}: ${date} · ${rest}`}
      aria-label={`${t('tasks.dueLabel')}: ${date} · ${rest}`}
    >
      <CalendarClock className="size-3.5 shrink-0" />
    </span>
  )
}
