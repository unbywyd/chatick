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

/**
 * Сколько дней задача держит другие. Ноль возвращаем как 0 — «сегодня», а не
 * прочерк: блокер, возникший час назад, тоже держит, просто недолго.
 *
 * Считаем от даты СВЯЗКИ, а не от создания задачи. Разница не теоретическая:
 * на живых данных TASK-49 заведена за неделю до того, как стала блокером, и
 * по возрасту задачи вышло бы «тормозит 7 дней» вместо двух. Врёт это ровно
 * на тех блокерах, что выявили по ходу работы, — а они и есть самые важные.
 *
 * null — когда даты нет: связок нет, все ждущие закрыты, или сервер поле не
 * прислал. Выдумывать возраст нельзя — лучше промолчать, чем показать «0 дн»
 * там, где мы не знаем.
 */
function ageOf(since: string | null | undefined): number | null {
  if (!since) return null
  const ms = Date.now() - new Date(since).getTime()
  if (Number.isNaN(ms)) return null
  return Math.max(0, Math.floor(ms / 86400000))
}

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

  // Сколько уже стоит: возраст самого давнего блокера. Берём максимум, а не
  // среднее — проект стоит столько, сколько стоит худшая его связка, и
  // усреднение с недавними блокерами как раз спрятало бы месячную.
  const worst = blockers.reduce<{ link: number; task: number | null } | null>((max, b) => {
    const link = ageOf(b.blockingSince)
    if (link === null) return max
    return max === null || link > max.link ? { link, task: ageOf(b.createdAt) } : max
  }, null)
  const worstAge = worst?.link ?? null

  // Возраст самой задачи рядом со сроком блокировки — но только когда они
  // расходятся заметно.
  //
  // Числа отвечают на разные вопросы: связка — «сколько стоит проект»,
  // задача — «сколько её не берут». Второе бывает много больше: связи здесь
  // ставят задним числом, из 38 только 7 заведены сразу, остальные в среднем
  // через сутки. Тогда «2 дня» скрывает, что задача уже неделю лежит.
  //
  // Порог в 2 дня, а не любое расхождение: разница в день — это «завели
  // вечером, связали утром», и второе число там лишний шум.
  const taskAge = worst && worst.task !== null && worst.task - worst.link >= 2 ? worst.task : null

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
        <b className="tabular-nums text-muted-foreground">{blockers.length}</b>
        <span className="hidden text-muted-foreground sm:inline">
          {t('blockers.stripHolding', { count: waitingCount })}
        </span>
        {/* Возраст САМОГО ДАВНЕГО блокера — здесь, а не только у задач:
            это ответ на «сколько уже стоит проект», и его должно быть видно
            до того, как человек начнёт разбирать карусель.

            Всегда контрастнее соседей, независимо от срока. Приглушённым по
            muted-foreground он сливался со строкой и не читался вовсе — а
            тогда его незачем и показывать. Два дня не тревога, но прочитать
            их всё равно надо: это единственное число, ради которого полосу и
            смотрят. Тревогу передаём цветом, а не яркостью. */}
        {worstAge !== null && (
          <span
            className={cn(
              'shrink-0 font-semibold tabular-nums',
              worstAge >= 14 ? 'text-orange-600 dark:text-orange-400' : 'text-foreground',
            )}
          >
            · {t('blockers.stripWorst', { count: worstAge })}
          </span>
        )}
        {/* Возраст задачи — приглушённо: это второй по важности упрёк.
            Прячем на узком экране, там дороже сама карусель. */}
        {taskAge !== null && (
          <span className="hidden shrink-0 tabular-nums text-muted-foreground md:inline">
            · {t('blockers.stripTaskAge', { count: taskAge })}
          </span>
        )}
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
        {blockers.map((b) => {
          // Возраст у задачи — только если он отличается от худшего.
          //
          // Иначе выходит «29 дней тормозит проект · TASK-9 29д · TASK-10 29д
          // · TASK-19 29д»: одно число четыре раза в одной строке. Так и
          // бывает, когда блокеры завели разом при разборе проекта — а это
          // самый частый случай. Число полезно там, где оно спорит с
          // заголовком: 29 в счётчике и 2 у задачи означают, что держит один,
          // а остальные подтянулись недавно.
          const own = ageOf(b.blockingSince)
          const age = own !== null && worstAge !== null && own === worstAge ? null : own
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => onOpen(b.id)}
              title={b.title}
              className="flex shrink-0 items-center gap-1.5 rounded-md border bg-background px-1.5 py-0.5 text-xs transition-colors hover:bg-accent"
            >
              <span className="tabular-nums text-muted-foreground">{b.number}</span>
              <span className="max-w-[9rem] truncate">{b.title}</span>
              {/* Сколько задача держит других — и СКОЛЬКО УЖЕ.
                  Одно число «3» не отвечает на главный вопрос: три дня — это
                  работа, три недели — это забыли, а выглядят они одинаково.
                  На живых данных разброс от 2 до 29 дней в одной компании. */}
              <span className="rounded bg-orange-500/15 px-1 text-[10px] font-semibold tabular-nums text-orange-600 dark:text-orange-400">
                {b.blocking}
              </span>
              {age !== null && (
                <span
                  className={cn(
                    'shrink-0 text-[10px] tabular-nums',
                    age >= 14 ? 'font-semibold text-orange-600 dark:text-orange-400' : 'text-muted-foreground',
                  )}
                >
                  {t('blockers.stripAge', { count: age })}
                </span>
              )}
            </button>
          )
        })}
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
