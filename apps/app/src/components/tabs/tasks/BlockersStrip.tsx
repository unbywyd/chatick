import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import type { Task } from './types'

// Полоса блокеров над списком задач.
//
// Отвечает на один вопрос: что сейчас держит проект. Это задачи, от которых
// зависят другие, — пока они не сделаны, часть работы взять нельзя, и по
// обычному списку это не видно: они разбросаны по спринтам и ничем не
// выделяются, кроме значка в своей строке.
//
// Компактно: одна строка. Слева счёт и лица тех, от кого ждут решения,
// дальше — сами задачи каруселью. Полоса не должна отодвигать список задач
// вниз, ради которого на вкладку и заходят.

export function BlockersStrip({
  tasks,
  onOpen,
  className,
}: {
  tasks: Task[]
  onOpen: (id: string) => void
  className?: string
}) {
  const { t } = useTranslation()
  const railRef = useRef<HTMLDivElement>(null)

  // Держат других и сами не закрыты: завершённая задача никого уже не держит,
  // даже если связи на неё остались.
  const blockers = tasks
    .filter((x) => (x.blocking ?? 0) > 0 && x.status !== 'done')
    .sort((a, b) => (b.blocking ?? 0) - (a.blocking ?? 0))

  if (!blockers.length) return null

  // Сколько задач ждут. Считаем по самим задачам, а не суммой счётчиков:
  // задача, ждущая двух блокеров, попала бы в сумму дважды, и «держат 26» при
  // 20 задачах в проекте выглядело бы ошибкой — ею и было бы.
  const waitingCount = new Set(
    tasks.filter((x) => (x.blockedBy ?? 0) > 0 && x.status !== 'done').map((x) => x.id),
  ).size

  // От кого ждут решения: исполнители блокирующих задач, без повторов.
  const people = new Map<string, { id: string; name: string; avatarUrl: string | null }>()
  for (const b of blockers) if (b.assignee) people.set(b.assignee.id, b.assignee)
  const faces = [...people.values()]

  const scrollBy = (dx: number) => railRef.current?.scrollBy({ left: dx, behavior: 'smooth' })

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border border-orange-500/30 bg-orange-500/5 px-2 py-1.5',
        className,
      )}
    >
      {/* Счёт: сколько держат и сколько ждут. Коротко — это подпись, а не текст. */}
      <span className="flex shrink-0 items-center gap-1.5 text-xs">
        <TriangleAlert className="size-3.5 shrink-0 text-orange-500" />
        <b className="font-semibold tabular-nums">{blockers.length}</b>
        <span className="hidden text-muted-foreground sm:inline">
          {t('blockers.stripHolding', { count: waitingCount })}
        </span>
      </span>

      {/* Лица тех, от кого ждут. Стопкой внахлёст: место в строке дороже. */}
      {faces.length > 0 && (
        <span className="flex shrink-0 items-center -space-x-1.5">
          {faces.slice(0, 4).map((p) => (
            <span key={p.id} title={p.name} className="rounded-full ring-2 ring-background">
              <Avatar name={p.name} src={p.avatarUrl} size={20} />
            </span>
          ))}
          {faces.length > 4 && (
            <span
              title={faces.slice(4).map((p) => p.name).join(', ')}
              className="grid size-5 place-items-center rounded-full bg-secondary text-[10px] font-medium tabular-nums ring-2 ring-background"
            >
              +{faces.length - 4}
            </span>
          )}
        </span>
      )}

      {/* Сами задачи. Прокрутка вместо переноса: полоса остаётся в одну строку
          при любом их количестве. */}
      <div ref={railRef} className="flex min-w-0 flex-1 gap-1 overflow-x-auto scrollbar-none">
        {blockers.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => onOpen(b.id)}
            title={b.title}
            className="flex shrink-0 items-center gap-1.5 rounded-md border bg-background px-1.5 py-0.5 text-xs transition-colors hover:bg-accent"
          >
            <span className="tabular-nums text-muted-foreground">{b.number}</span>
            <span className="max-w-[9rem] truncate">{b.title}</span>
            <span className="rounded bg-orange-500/15 px-1 text-[10px] font-semibold tabular-nums text-orange-600 dark:text-orange-400">
              {b.blocking}
            </span>
          </button>
        ))}
      </div>

      {/* Стрелки только когда каруселью реально пользуются: на трёх задачах
          они лишний шум. */}
      {blockers.length > 3 && (
        <span className="hidden shrink-0 items-center gap-0.5 sm:flex">
          <button
            type="button"
            onClick={() => scrollBy(-240)}
            className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft className="size-3.5 rtl:rotate-180" />
          </button>
          <button
            type="button"
            onClick={() => scrollBy(240)}
            className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronRight className="size-3.5 rtl:rotate-180" />
          </button>
        </span>
      )}
    </div>
  )
}
