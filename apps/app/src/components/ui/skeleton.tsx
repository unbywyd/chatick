import type React from 'react'
import { cn } from '@/lib/utils'

/**
 * Заглушки на время загрузки.
 *
 * При смене проекта экран уходил в пустоту с многоточием по центру: на тёмной
 * теме это выглядит как сломанное приложение, а не как ожидание. Особенно
 * заметно, когда база отвечает не мгновенно.
 *
 * Скелетон показывает будущую раскладку: человек видит, что содержимое едет,
 * и куда именно оно встанет.
 */

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <span style={style} className={cn('block animate-pulse rounded-md bg-muted', className)} />
}

/** Строки списка задач: рабочая зона при входе в проект. */
export function TaskListSkeleton() {
  return (
    <div className="page-w space-y-4 p-6" aria-hidden>
      <div className="flex items-center gap-3">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="ms-auto h-8 w-24" />
      </div>
      <div className="space-y-2">
        {/* Разной ширины: одинаковые полосы читаются как таблица, а не как
            загружающийся список. */}
        {[92, 78, 85, 70, 88, 64].map((w, i) => (
          <div key={i} className="flex items-center gap-3 rounded-lg border p-3">
            <Skeleton className="size-4 shrink-0 rounded-full" />
            <Skeleton className="h-4" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Лента сообщений: колонка чата, пока едет история. */
export function ChatSkeleton() {
  return (
    <div className="flex-1 space-y-4 p-4" aria-hidden>
      {[
        { mine: false, w: 70 },
        { mine: true, w: 55 },
        { mine: false, w: 80 },
        { mine: false, w: 45 },
        { mine: true, w: 65 },
      ].map((m, i) => (
        <div key={i} className={cn('flex items-start gap-2', m.mine && 'flex-row-reverse')}>
          <Skeleton className="size-7 shrink-0 rounded-full" />
          <Skeleton className="h-12 rounded-xl" style={{ width: `${m.w}%` }} />
        </div>
      ))}
    </div>
  )
}
