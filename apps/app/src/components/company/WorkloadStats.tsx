import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Ban, CircleDashed, FolderKanban, Play, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'

// Кто над чем работает — секция планирования на обзоре компании.
//
// Отвечает на вопрос, которого нет больше нигде: у кого есть работа, у кого
// нет, и над чем именно. Обзор выше говорит про проекты, «Люди» под ней — про
// то, КАК человек работает с очередью (быстро ли отвечает, не молчит ли).
// Здесь — про саму очередь.
//
// Карточка кликабельна: числа отвечают «сколько», модалка — «где именно».
// Без неё «6 проектов» заставляет гадать, что это за проекты.

type Project = { id: string; name: string; color: string | null; tasks: number }

type Person = {
  id: string
  name: string
  avatarUrl: string | null
  role: string
  /**
   * Состояние — считает СЕРВЕР, клиент только выбирает текст и цвет.
   *
   * Правило, выписанное дважды, однажды разойдётся: в списке человек
   * «свободен», а в карточке нет.
   */
  state: 'idle' | 'stuck' | 'waiting' | 'working'
  openTasks: number
  /** Незаблокированные: их можно взять прямо сейчас. */
  freeTasks: number
  blockedTasks: number
  /** Что человек может делать сам: todo + in_progress + review, без заблокированных. */
  actionableTasks: number
  /** Принято и ждёт закрытия — с человека уже снято. */
  waitingTasks: number
  doingTasks: number
  projectCount: number
  plannedMinutes: number
  /** Задач без оценки: без этого числа часам нельзя верить. */
  noEstimate: number
  lastActiveAt: string | null
  projects: Project[]
}

/** Часы из минут. Округляем до одного знака: «0.5 ч» не должно стать нулём. */
function hours(minutes: number): string {
  return (minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)
}

export function WorkloadStats({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const [openPerson, setOpenPerson] = useState<Person | null>(null)

  const q = useQuery({
    queryKey: ['company-workload', companyId],
    queryFn: () => api<{ items: Person[] }>(`/api/v1/companies/${companyId}/workload`),
  })

  const items = q.data?.items ?? []
  if (q.isLoading) return null
  if (!items.length) return null

  return (
    <section className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">{t('workload.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('workload.hint')}</p>
      </div>

      {/* min-w-0 на карточках: без него длинное имя проекта распирает сетку
          вбок — та же беда, что уже ловили на полосе активности. */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((p) => (
          <PersonCard key={p.id} person={p} onOpen={() => setOpenPerson(p)} />
        ))}
      </div>

      {openPerson && <PersonDialog person={openPerson} onClose={() => setOpenPerson(null)} />}
    </section>
  )
}

/**
 * Карточка человека.
 *
 * Три вещи в порядке важности: состояние (что с ним сейчас), объём (сколько
 * работы) и где она лежит. Проектов показываем один и «+N» — полный список
 * в модалке: у человека их бывает двенадцать, и в карточку они не влезут.
 */
function PersonCard({ person: p, onOpen }: { person: Person; onOpen: () => void }) {
  const { t } = useTranslation()

  // Цвет и текст — по состоянию с сервера. Свободен и «стоит» тревожны
  // по-разному: первому дают работу, у второго её разблокируют.
  const tone =
    p.state === 'idle' ? 'text-muted-foreground'
    : p.state === 'stuck' ? 'text-orange-600 dark:text-orange-400'
    : p.state === 'waiting' ? 'text-muted-foreground'
    : 'text-brand-ink'

  const StateIcon = p.state === 'stuck' ? Ban : p.state === 'working' ? Play : CircleDashed

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-w-0 flex-col gap-2 rounded-lg border bg-background p-3 text-start transition-colors hover:border-brand/60 hover:bg-accent/40"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Avatar name={p.name} src={p.avatarUrl} className="size-7 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
        <span className={cn('flex shrink-0 items-center gap-1 text-xs font-medium', tone)}>
          <StateIcon className="size-3.5" />
          {t(`workload.state.${p.state}`)}
        </span>
      </div>

      {/* Объём: задачи и часы. Часы — только по оценённым, и если оценены не
          все, говорим об этом сразу: иначе по неполному числу планируют. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span>
          <b className="text-sm font-semibold tabular-nums text-foreground">{p.actionableTasks}</b>{' '}
          {t('workload.tasks', { count: p.actionableTasks })}
        </span>
        {p.plannedMinutes > 0 && (
          <span>
            <b className="text-sm font-semibold tabular-nums text-foreground">{hours(p.plannedMinutes)}</b>{' '}
            {t('workload.hours')}
          </span>
        )}
        {p.noEstimate > 0 && (
          <span className="text-amber-600 dark:text-amber-500">
            {t('workload.noEstimate', { count: p.noEstimate })}
          </span>
        )}
      </div>

      {/* Принято и ждёт закрытия — приглушённо и только когда есть.
          Объясняет разницу между главным числом и полной очередью: у одного
          человека 31 задача из 52 уже принята, своей работы 19. Без этой
          строки «19 задач» выглядело бы потерей трёх десятков. */}
      {p.waitingTasks > 0 && (
        <div className="text-xs text-muted-foreground">
          {t('workload.waiting', { count: p.waitingTasks })}
        </div>
      )}

      {/* Заблокированные — отдельной строкой и только когда есть: это не
          «часть очереди», а работа, которую человек взять не может. */}
      {p.blockedTasks > 0 && (
        <div className="flex items-center gap-1 text-xs text-orange-600 dark:text-orange-400">
          <Ban className="size-3" />
          {t('workload.blocked', { count: p.blockedTasks })}
        </div>
      )}

      {/* Над чем работает: главный проект и сколько ещё. */}
      {p.projects.length > 0 && (
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <FolderKanban className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{p.projects[0]!.name}</span>
          {p.projects.length > 1 && (
            <span className="shrink-0 rounded bg-secondary px-1 font-medium tabular-nums">
              +{p.projects.length - 1}
            </span>
          )}
        </div>
      )}
    </button>
  )
}

/** Подробности: все проекты человека и сколько задач в каждом. */
function PersonDialog({ person: p, onClose }: { person: Person; onClose: () => void }) {
  const { t } = useTranslation()
  const max = Math.max(1, ...p.projects.map((x) => x.tasks))

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-16"
      onClick={onClose}
    >
      <div className="w-full max-w-lg rounded-xl border bg-card shadow-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="flex min-w-0 items-center gap-2 text-lg font-bold">
            <Avatar name={p.name} src={p.avatarUrl} className="size-7 shrink-0" />
            <span className="min-w-0 truncate">{p.name}</span>
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-4">
          {/* Сводка теми же числами, что на карточке: расхождение между
              карточкой и её же модалкой — худшее, что можно показать. */}
          <div className="mb-4 grid grid-cols-3 gap-2 text-center">
            <Sum value={String(p.actionableTasks)} label={t('workload.sumOpen')}
              note={p.waitingTasks > 0 ? t('workload.waiting', { count: p.waitingTasks }) : undefined} />
            <Sum
              value={p.plannedMinutes > 0 ? hours(p.plannedMinutes) : '—'}
              label={t('workload.sumHours')}
              note={p.noEstimate > 0 ? t('workload.noEstimate', { count: p.noEstimate }) : undefined}
            />
            <Sum
              value={String(p.blockedTasks)}
              label={t('workload.sumBlocked')}
              tone={p.blockedTasks > 0 ? 'warn' : undefined}
            />
          </div>

          <h3 className="mb-2 text-sm font-medium">
            {t('workload.byProject', { count: p.projects.length })}
          </h3>
          {!p.projects.length ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('workload.noTasks')}</p>
          ) : (
            <ul className="space-y-1.5">
              {p.projects.map((pr) => (
                <li key={pr.id} className="flex min-w-0 items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{pr.name}</span>
                  {/* Полоска вместо числа отдельно: с ней сразу видно, что у
                      Elisha одиннадцать проектов по одной задаче, а не
                      равномерная нагрузка. */}
                  <span className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-secondary">
                    <span
                      className="block h-full rounded-full bg-brand"
                      style={{ width: `${Math.round((pr.tasks / max) * 100)}%` }}
                    />
                  </span>
                  <span className="w-6 shrink-0 text-end tabular-nums text-muted-foreground">{pr.tasks}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function Sum({
  value,
  label,
  note,
  tone,
}: {
  value: string
  label: string
  note?: string
  tone?: 'warn'
}) {
  return (
    <div className="rounded-lg border p-2">
      <div
        className={cn(
          'text-lg font-bold tabular-nums',
          tone === 'warn' && 'text-orange-600 dark:text-orange-400',
        )}
      >
        {value}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {note && <div className="text-[10px] text-amber-600 dark:text-amber-500">{note}</div>}
    </div>
  )
}
