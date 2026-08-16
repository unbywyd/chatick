import { useTranslation } from 'react-i18next'
import { CalendarClock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { dueDays } from './types'

/**
 * Срок задачи: дата и сколько до неё осталось.
 *
 * Одна дата отвечает «когда», но не отвечает «горит ли»: «14 сентября» надо
 * сверять с календарём в голове, а «через 2 дня» читается сразу. Показываем
 * оба — дату для точности, остаток для тревоги.
 *
 * Выполненную задачу не подсвечиваем: срок у неё в прошлом почти всегда, и
 * красный на сделанном — ложная тревога, из-за которой перестают верить
 * красному вообще.
 */
export function DueDate({
  due,
  done,
  className,
  compact,
}: {
  due: string | null
  done?: boolean
  className?: string
  /** В списке — без иконки и подписи: там на строку и так много всего. */
  compact?: boolean
}) {
  const { t, i18n } = useTranslation()
  if (!due) return null

  const left = dueDays(due)
  const overdue = !done && left !== null && left < 0
  const soon = !done && left !== null && left >= 0 && left <= 1

  const date = new Date(due).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' })
  const rest =
    done || left === null
      ? null
      : left < 0
        ? t('tasks.dueOverdueBy', { count: Math.abs(left) })
        : left === 0
          ? t('tasks.dueToday')
          : left === 1
            ? t('tasks.dueTomorrow')
            : t('tasks.dueInDays', { count: left })

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap text-xs tabular-nums',
        overdue ? 'text-destructive' : soon ? 'text-orange-500' : 'text-muted-foreground',
        className,
      )}
      title={new Date(due).toLocaleDateString(i18n.language, { dateStyle: 'long' })}
    >
      {!compact && <CalendarClock className="size-3.5 shrink-0" />}
      <span>{date}</span>
      {rest && <span className={cn(!overdue && !soon && 'text-muted-foreground/70')}>· {rest}</span>}
    </span>
  )
}
