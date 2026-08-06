import { useTranslation } from 'react-i18next'
import { CircleDashed, Lock, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Task } from './types'

// Фильтр по зависимостям: три значка, каждый жмётся и отжимается отдельно.
//
// Ни один не выбран — показываем всё. Это не «пустой фильтр», а его обычное
// состояние: так контрол занимает три кнопки вместо выпадающего списка с
// пунктом «все», и не приходится объяснять, чем «все» отличается от «ничего».

export type BlockerFilterValue = Set<'blocked' | 'blocking' | 'free'>

/** Подходит ли задача под выбранное. Пустой набор пропускает всех. */
export function matchesBlockerFilter(task: Task, f: BlockerFilterValue): boolean {
  if (!f.size) return true
  // Завершённая задача не блокирует и не заблокирована: связи у неё остаются,
  // но фильтр отвечает на вопрос «что сейчас», а не «что было».
  const done = task.status === 'done'
  const blocked = !done && (task.blockedBy ?? 0) > 0
  const blocking = !done && (task.blocking ?? 0) > 0
  if (f.has('blocked') && blocked) return true
  if (f.has('blocking') && blocking) return true
  // Свободна к работе — ничего не ждёт. Держит она кого-то или нет, неважно:
  // взять её в работу можно прямо сейчас.
  if (f.has('free') && !blocked) return true
  return false
}

export function BlockerFilter({
  value,
  onChange,
}: {
  value: BlockerFilterValue
  onChange: (next: BlockerFilterValue) => void
}) {
  const { t } = useTranslation()

  const toggle = (key: 'blocked' | 'blocking' | 'free') => {
    const next = new Set(value)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange(next)
  }

  const buttons = [
    { key: 'blocked' as const, Icon: Lock, label: t('blockers.filterBlocked'), on: 'bg-accent text-foreground' },
    {
      key: 'blocking' as const,
      Icon: TriangleAlert,
      label: t('blockers.filterBlocking'),
      on: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
    },
    { key: 'free' as const, Icon: CircleDashed, label: t('blockers.filterFree'), on: 'bg-brand/15 text-brand' },
  ]

  return (
    <div className="inline-flex items-center rounded-md border p-0.5">
      {buttons.map(({ key, Icon, label, on }) => (
        <button
          key={key}
          type="button"
          title={label}
          aria-pressed={value.has(key)}
          onClick={() => toggle(key)}
          className={cn(
            'grid size-6 place-items-center rounded transition-colors',
            value.has(key) ? on : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  )
}
