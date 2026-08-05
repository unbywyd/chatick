import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { STATUS_BADGE, STATUS_ICON, type Status } from './types'

/**
 * Статус задачи тегом.
 *
 * Один компонент на всё приложение: таблица, карточка задачи, доска, фильтры
 * и форма создания. Раньше каждое место рисовало статус само — иконкой с
 * подписью, и оттенки разъезжались: в таблице значок был серо-синий, в
 * карточке лаймовый, а на доске вообще без подписи.
 */
export function StatusBadge({
  status,
  size = 'md',
  withIcon = true,
  className,
}: {
  status: Status
  /** sm — плотная строка таблицы, md — карточка и меню */
  size?: 'sm' | 'md'
  withIcon?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const Icon = STATUS_ICON[status]
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md font-medium whitespace-nowrap',
        size === 'sm' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-1 text-xs',
        STATUS_BADGE[status],
        className,
      )}
    >
      {withIcon && <Icon className={size === 'sm' ? 'size-3' : 'size-3.5'} />}
      {t(`tasks.status.${status}`)}
    </span>
  )
}
