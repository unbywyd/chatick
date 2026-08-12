import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { CalendarDays, Clock, MoreHorizontal, X } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDuration } from '@/lib/time-parse'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'

// Сводка проекта: сколько сделано, сколько запланировано, сколько ушло на
// самом деле и к какому сроку.
//
// Ничего не прогнозируем. Обещать «закончим 14-го» значит выдавать за расчёт
// то, что зависит от количества занятых людей, их параллельной загрузки и
// задач, которые никто не оценивал. Показываем факты: числа и дату.
//
// Всё в одну строку: над списком задач это шапка, а не отчёт. Разворачивать
// её в панель значило бы отодвинуть вниз то, ради чего вкладку открыли.

type Summary = {
  deadline: string | null
  tasks: { total: number; done: number; noEstimate: number; noEstimateOpen: number }
  minutes: { planned: number; plannedDone: number; plannedLeft: number; spent: number }
}

/** Полночь по местному в ISO — сервер ждёт отметку времени, а срок задают датой. */
const isoDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0).toISOString()

/** Целых дней до срока; сегодня = 0, вчера = −1. */
function daysLeft(deadline: string): number {
  const end = new Date(deadline)
  const a = new Date(end.getFullYear(), end.getMonth(), end.getDate())
  const now = new Date()
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((a.getTime() - b.getTime()) / 86_400_000)
}

/**
 * Цвет срока — только по оставшимся дням.
 *
 * Считать по объёму работы («влезает ли остаток в оставшиеся дни») заманчиво,
 * но такой расчёт зависит от того, сколько людей заняты и что не оценено, —
 * а красный цвет, загоревшийся из-за неоценённой задачи, перестают замечать.
 */
function deadlineTone(days: number): string {
  if (days < 0) return 'border-destructive/40 bg-destructive/10 text-destructive'
  if (days <= 2) return 'border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400'
  if (days <= 7) return 'border-yellow-500/40 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400'
  return 'border-brand/40 bg-brand/10 text-brand-ink'
}

export function ProjectSummary({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { companyId } = useParams()
  const [picking, setPicking] = useState(false)

  const q = useQuery({
    queryKey: ['project-summary', projectId],
    queryFn: () => api<Summary>(`/api/v1/projects/${projectId}/summary`),
  })

  const setDeadline = useMutation({
    mutationFn: (deadline: string | null) =>
      api(`/api/v1/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ deadline }) }),
    onSuccess: () => {
      setPicking(false)
      qc.invalidateQueries({ queryKey: ['project-summary', projectId] })
      qc.invalidateQueries({ queryKey: ['project', projectId] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const s = q.data
  if (!s || (!s.tasks.total && !s.deadline)) return null

  const { planned, plannedDone, plannedLeft, spent } = s.minutes
  const days = s.deadline ? daysLeft(s.deadline) : null

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
      {/* Часы: план, остаток, факт. Показываем, только если кто-то оценивал
          задачи или включал таймер — иначе это строка из нулей. */}
      {(planned > 0 || spent > 0) && (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Clock className="size-3.5 shrink-0" />
          {planned > 0 && (
            <>
              <span>
                {t('summary.planned')}: <b className="font-medium text-foreground">{formatDuration(planned)}</b>
              </span>
              <span className="text-border">·</span>
              <span>
                {t('summary.left')}: <b className="font-medium text-foreground">{formatDuration(plannedLeft)}</b>
              </span>
              <span className="text-border">·</span>
            </>
          )}
          <span>
            {t('summary.spent')}: <b className="font-medium text-foreground">{formatDuration(spent)}</b>
          </span>
          {/* Сравнение факта с закрытым планом, а не со всем: пока половина
              задач открыта, «100 из 200» читалось бы как отставание.
              Со словом, а не одним знаком: голое «−0:20» сразу после
              «Потрачено» читается как поправка к потраченному, хотя это
              отклонение от ОЦЕНКИ завершённых задач. На этом спотыкались. */}
          {plannedDone > 0 && spent > 0 && spent !== plannedDone && (
            <span
              title={t('summary.vsDoneHint')}
              className={cn(
                'rounded px-1',
                spent > plannedDone ? 'bg-orange-500/15 text-orange-600 dark:text-orange-400' : 'bg-brand/15 text-brand-ink',
              )}
            >
              {t(spent > plannedDone ? 'summary.slowerBy' : 'summary.fasterBy', {
                time: formatDuration(Math.abs(spent - plannedDone)),
              })}
            </span>
          )}
        </span>
      )}

      {/* Неоценённые открытые задачи: без этой пометки «осталось 12ч» читается
          как «почти всё», когда рядом висят семь задач без оценки. */}
      {s.tasks.noEstimateOpen > 0 && planned > 0 && (
        <span className="text-muted-foreground" title={t('summary.noEstimateHint')}>
          {t('summary.noEstimate', { count: s.tasks.noEstimateOpen })}
        </span>
      )}

      {/* Срок и меню — прижаты к концу строки */}
      <span className="ms-auto flex items-center gap-1.5">
        {s.deadline ? (
          <Popover open={picking} onOpenChange={canEdit ? setPicking : undefined}>
            <PopoverTrigger asChild disabled={!canEdit}>
              <button
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 transition-colors',
                  deadlineTone(days!),
                  canEdit && 'hover:brightness-95',
                )}
              >
                <CalendarDays className="size-3" />
                <span className="tabular-nums">{new Date(s.deadline).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' })}</span>
                <span className="opacity-80">
                  {days! < 0 ? t('summary.overdue', { count: -days! }) : t('summary.daysLeft', { count: days! })}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto">
              <Calendar
                selected={new Date(s.deadline)}
                onSelect={(d) => d && setDeadline.mutate(isoDay(d))}
              />
              <Button variant="ghost" size="sm" className="mt-1 w-full" onClick={() => setDeadline.mutate(null)}>
                <X className="size-3.5" />
                {t('summary.clearDeadline')}
              </Button>
            </PopoverContent>
          </Popover>
        ) : canEdit ? (
          <Popover open={picking} onOpenChange={setPicking}>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-muted-foreground transition-colors hover:text-foreground">
                <CalendarDays className="size-3" />
                {t('summary.setDeadline')}
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto">
              <Calendar onSelect={(d) => d && setDeadline.mutate(isoDay(d))} />
            </PopoverContent>
          </Popover>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* Часы настраиваются на компании — ведём туда, а не открываем
                вторую форму с теми же полями. */}
            <DropdownMenuItem onClick={() => navigate(`/start/${companyId}/settings?s=time`)}>
              <Clock className="size-3.5" />
              {t('summary.timeSettings')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </div>
  )
}
