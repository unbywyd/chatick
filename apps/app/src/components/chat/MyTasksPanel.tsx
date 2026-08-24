import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ChevronDown, ChevronRight, Flag, LayoutList, ListOrdered } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { ProjectBadge } from '@/components/ui/project-badge'
import { STATUS_COLOR, STATUS_ICON, PRIORITY_COLOR, type Priority, type Status } from '@/components/tabs/tasks/types'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * Мои задачи по всем проектам компании — вид панели рядом с чатом и ИИ.
 *
 * Панель при переключении проекта не размонтируется (у ProjectLayout нет key),
 * а её данные живут на session-токене и переживают сброс проектного кэша.
 * Поэтому клик по задаче не мигает списком: слева всё стоит на месте, справа
 * открывается задача.
 */

type MyTask = {
  id: string
  number: string
  title: string
  status: Status
  priority: Priority
  dueDate: string | null
  createdAt: string
  projectId: string
  author: { id: string; name: string; avatarUrl: string | null } | null
  project: { id: string; name: string; color: string; logoUrl: string | null } | null
}

/**
 * Как человек привык видеть список. Живёт в браузере: это его привычка, а не
 * свойство проекта или компании.
 *
 * Пусто читаем как «по проектам» — это умолчание.
 */
const GROUP_KEY = 'chatick_my_tasks_grouped'

/** Просрочка в днях, если срок прошёл. */
function overdueDays(due: string | null): number {
  if (!due) return 0
  const ms = Date.now() - new Date(due).getTime()
  return ms > 0 ? Math.floor(ms / 86_400_000) : 0
}

export function MyTasksPanel({ onOpen }: { onOpen?: () => void }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { companyId, id: projectId } = useParams()

  const q = useQuery({
    queryKey: ['my-tasks', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ items: MyTask[] }>(`/api/v1/my/tasks?companyId=${companyId}`),
    // Задачи назначают и закрывают, пока человек смотрит в панель.
    refetchInterval: 60_000,
  })

  const items = q.data?.items ?? []

  /**
   * Как разложен список.
   *
   * По проектам — умолчание: имя проекта уходит в заголовок секции, и строка
   * задачи перестаёт его повторять. Список читается короче, а границы между
   * чужими работами видны сами собой.
   *
   * По срочности — сквозной порядок, каким его отдаёт сервер: сначала
   * просроченные, потом от старых к новым. Нужен, когда вопрос не «что в этом
   * проекте», а «что горит вообще».
   *
   * Выбор держим в браузере: это привычка человека, а не свойство проекта.
   */
  const [grouped, setGrouped] = useState(() => localStorage.getItem(GROUP_KEY) !== '0')
  const [closed, setClosed] = useState<Set<string>>(new Set())

  const groups = useMemo(() => {
    if (!grouped) return []
    const by = new Map<string, { project: MyTask['project']; id: string; tasks: MyTask[] }>()
    for (const t of items) {
      const g = by.get(t.projectId) ?? { project: t.project, id: t.projectId, tasks: [] }
      g.tasks.push(t)
      by.set(t.projectId, g)
    }
    /**
     * Открытый проект — первым.
     *
     * Не прокруткой к нему: панель отвечает на вопрос «что горит», и уехав к
     * текущему проекту, она спрятала бы просроченное из соседнего — ровно то,
     * ради чего её и открывают. Достаточно поставить сверху.
     */
    /**
     * Внутри секции — от новых к старым.
     *
     * Сервер отдаёт по срочности, и это верно для сквозного списка: там
     * вопрос «что горит вообще». Но когда проект уже выбран, разговор идёт о
     * его работе, и первым хочется видеть свежее — то, что поставили только
     * что, а не забытое полугодовой давности.
     */
    for (const g of by.values()) {
      g.tasks.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
    }

    return [...by.values()].sort((a, b) =>
      a.id === projectId ? -1 : b.id === projectId ? 1 : 0,
    )
  }, [items, grouped, projectId])

  // Скелетон вместо многоточия: панель открыта по умолчанию, и первое, что
  // человек видит при входе, не должно быть пустым местом.
  if (q.isLoading)
    return (
      <ul className="space-y-1 p-2" aria-hidden>
        {[92, 76, 84].map((w, i) => (
          <li key={i} className="rounded-lg border bg-card p-2.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-2 h-4" style={{ width: `${w}%` }} />
            <Skeleton className="mt-2 h-3 w-16" />
          </li>
        ))}
      </ul>
    )

  if (!items.length) {
    return (
      <div className="p-6 text-center">
        <p className="text-sm font-medium">{t('myTasks.emptyTitle')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t('myTasks.emptyText')}</p>
      </div>
    )
  }

  /** Строка задачи. Имя проекта показываем только вне группировки. */
  const row = (task: MyTask, withProject: boolean) => {
    const late = overdueDays(task.dueDate)
    const StatusIcon = STATUS_ICON[task.status]
    return (
      <li key={task.id}>
        <button
          type="button"
          onClick={() => {
            navigate(`/c/${companyId}/p/${task.projectId}/tasks/${task.id}`)
            onOpen?.()
          }}
          className="w-full rounded-lg border bg-card p-2.5 text-start transition-colors hover:bg-accent"
        >
          {/* Проект — отдельной строкой только в сквозном списке: в секциях
              он уже назван в заголовке. */}
          {withProject && task.project && (
            <div className="mb-1 flex items-center gap-2">
              <ProjectBadge
                name={task.project.name}
                color={task.project.color}
                logoUrl={task.project.logoUrl}
                size={18}
              />
              <span className="truncate text-[11px] text-muted-foreground">{task.project.name}</span>
            </div>
          )}

          <p className="line-clamp-2 text-sm leading-snug">{task.title}</p>

          {/* Номер, автор, дата и просрочка — одной строкой. Номер стоял
              отдельным рядом, оставляя рядом с собой пустоту, а карточка
              росла до трёх рядов там, где хватает двух. */}
          <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
            {/* Статус — значком в его цвете: слово заняло бы место, которого в
                узкой колонке нет, а цвет считывается боковым зрением. */}
            <StatusIcon className={cn('size-3.5 shrink-0', STATUS_COLOR[task.status])} />
            {/* Флажок только у срочного и важного: у обычной задачи он был бы
                шумом — их большинство, и метка на большинстве ничего не метит. */}
            {(task.priority === 'urgent' || task.priority === 'high') && (
              <Flag className={cn('size-3 shrink-0', PRIORITY_COLOR[task.priority])} />
            )}
            <span className="shrink-0 font-mono text-[10px] font-semibold text-foreground/70">{task.number}</span>
            {/* Кто поставил: в чужой задаче это первое, что хочется знать. */}
            {task.author && (
              <Avatar name={task.author.name} src={task.author.avatarUrl} size={16} title={task.author.name} />
            )}
            <span className="truncate">{new Date(task.createdAt).toLocaleDateString(i18n.language)}</span>
            {late > 0 && (
              <span className="ms-auto shrink-0 rounded-full bg-destructive/10 px-1.5 py-0.5 font-medium text-destructive">
                {t('myTasks.overdue', { count: late })}
              </span>
            )}
          </div>
        </button>
      </li>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Переключатель закреплён, а список едет под ним: он объясняет, ПОЧЕМУ
          список выглядит именно так, и уехав вместе с ним под шапку, оставлял
          порядок без объяснения. */}
      <div className="flex shrink-0 items-center gap-1 rounded-lg bg-secondary/60 p-1 m-2 mb-1">
        {([
          { key: true, icon: LayoutList, label: 'myTasks.byProject' },
          { key: false, icon: ListOrdered, label: 'myTasks.byUrgency' },
        ] as const).map(({ key, icon: Icon, label }) => (
          <button
            key={String(key)}
            type="button"
            onClick={() => {
              setGrouped(key)
              localStorage.setItem(GROUP_KEY, key ? '1' : '0')
            }}
            className={cn(
              'flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
              grouped === key
                ? 'border border-border bg-background text-foreground shadow-sm'
                : 'border border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-3" />
            {t(label)}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      {grouped ? (
        <div className="space-y-3">
          {groups.map((g) => {
            const shut = closed.has(g.id)
            return (
              <div key={g.id}>
                {/* Заголовок секции — он же кнопка сворачивания. Липкий:
                    в длинном списке иначе не понять, чей проект перед тобой. */}
                <button
                  type="button"
                  onClick={() =>
                    setClosed((prev) => {
                      const next = new Set(prev)
                      if (!next.delete(g.id)) next.add(g.id)
                      return next
                    })
                  }
                  // -mt-2 pt-2: липкий заголовок липнет к САМОМУ верху, без
                  // просвета, в котором проступала карточка под ним.
                  className="sticky -top-2 z-10 -mt-2 mb-1 flex w-full items-center gap-2 rounded-md bg-card px-1.5 pb-1 pt-2 text-start transition-colors hover:bg-accent"
                >
                  {shut ? (
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground rtl:-scale-x-100" />
                  ) : (
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  {g.project && (
                    <ProjectBadge
                      name={g.project.name}
                      color={g.project.color}
                      logoUrl={g.project.logoUrl}
                      size={18}
                    />
                  )}
                  <span className="truncate text-xs font-medium">{g.project?.name}</span>
                  <span className="ms-auto shrink-0 rounded-full bg-secondary px-1.5 text-[10px] tabular-nums text-muted-foreground">
                    {g.tasks.length}
                  </span>
                </button>
                {!shut && <ul className="space-y-1">{g.tasks.map((task) => row(task, false))}</ul>}
              </div>
            )
          })}
        </div>
      ) : (
        <ul className="space-y-1">{items.map((task) => row(task, true))}</ul>
      )}
      </div>
    </div>
  )
}
