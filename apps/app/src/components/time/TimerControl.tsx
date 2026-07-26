import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Clock3, Pause, Play } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { formatElapsed, parseTimeOfDay, withTimeOfDay } from '@/lib/time-parse'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { ProjectBadge } from '@/components/ui/project-badge'
import { useProjectSocket } from '@/hooks/useProjectSocket'

// Быстрый контроль таймера в сайдбаре (SPEC §8.32): запустить, остановить,
// поправить время начала. Всё остальное — на странице /p/:id/time.

type ProjectLite = { id: string; name: string; color?: string; logoUrl?: string | null; isMember: boolean }

export type RunningEntry = {
  id: string
  description: string
  startedAt: string
  task: { id: string; number: string; title: string } | null
  projectId: string
  /** null — таймер здесь; строка — идёт в другом проекте */
  projectName: string | null
}

/** Секунды с момента начала — тикает раз в секунду, пока таймер идёт. */
function useElapsed(startedAt?: string): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!startedAt) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [startedAt])
  return startedAt ? Math.floor((now - new Date(startedAt).getTime()) / 1000) : 0
}

export function TimerControl({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation()
  const { id: projectId } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const running = useQuery({
    queryKey: ['time-running', projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<{ items: RunningEntry[] }>('/api/v1/time/running', {}, 'project'),
    // опрос — только страховка: основное обновление приходит по сокету
    refetchInterval: 60_000,
  })

  // Таймер могли запустить не отсюда: ИИ из чата, мост из редактора, другая
  // вкладка. Без сокета контрол показывал старое состояние до минуты.
  useProjectSocket(projectId, {
    onMessage: () => {},
    onTime: () => {
      qc.invalidateQueries({ queryKey: ['time-running', projectId] })
      qc.invalidateQueries({ queryKey: ['time-entries', projectId] })
    },
  })

  const first = running.data?.items[0]
  const elapsed = useElapsed(first?.startedAt)
  const count = running.data?.items.length ?? 0

  const onErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))
  const refresh = () => qc.invalidateQueries({ queryKey: ['time-running', projectId] })

  const [draft, setDraft] = useState('')

  // проекты нужны, чтобы показать, к какому привязан таймер, и дать перенести
  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<{ companies: { id: string }[] }>('/api/v1/companies'),
  })
  const companyId = companies.data?.companies[0]?.id
  const projectsQ = useQuery({
    queryKey: ['sidebar-projects', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<ProjectLite[]>(`/api/v1/projects?companyId=${companyId}`),
  })
  const myProjects = (projectsQ.data ?? []).filter((p) => p.isMember)
  const start = useMutation({
    mutationFn: (description: string) =>
      // projectId передаём явно: токен меняется с задержкой, и без этого
      // запуск иногда уезжал в предыдущий проект
      api('/api/v1/time/start', { method: 'POST', body: JSON.stringify({ description, projectId }) }, 'project'),
    onSuccess: () => {
      setDraft('')
      refresh()
    },
    onError: onErr,
  })
  const stop = useMutation({
    mutationFn: (id: string) =>
      api<{ discarded?: boolean }>(`/api/v1/time/${id}/stop`, { method: 'POST' }, 'project'),
    onSuccess: (r) => {
      // Секундная запись не сохраняется — но молчать об этом нельзя: человек
      // нажал стоп и вправе знать, почему в списке ничего не появилось.
      if (r?.discarded) toast.info(t('time.discarded'))
      refresh()
      qc.invalidateQueries({ queryKey: ['time-entries', projectId] })
    },
    onError: onErr,
  })
  const move = useMutation({
    mutationFn: ({ id, projectId: target }: { id: string; projectId: string }) =>
      api(`/api/v1/time/${id}`, { method: 'PATCH', body: JSON.stringify({ projectId: target }) }, 'project'),
    onSuccess: () => {
      refresh()
      qc.invalidateQueries({ queryKey: ['time-entries'] })
    },
    onError: onErr,
  })

  const patchStart = useMutation({
    mutationFn: ({ id, startedAt }: { id: string; startedAt: string }) =>
      api(`/api/v1/time/${id}`, { method: 'PATCH', body: JSON.stringify({ startedAt }) }, 'project'),
    onSuccess: refresh,
    onError: onErr,
  })

  if (!projectId) return null

  const toggle = () => (first ? stop.mutate(first.id) : start.mutate(draft.trim()))

  // Таймер, забытый в соседнем проекте, виден и здесь: человек один, и работа
  // в другом проекте не перестаёт идти оттого, что он переключил вкладку.
  const elsewhere = first?.projectName ?? null

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1">
        <button
          onClick={toggle}
          title={first ? (elsewhere ? t('time.runningIn', { project: elsewhere }) : t('time.stop')) : t('time.start')}
          className={cn(
            'grid size-8 place-items-center rounded-md transition-colors',
            first
              ? elsewhere
                ? 'bg-amber-500/20 text-amber-500' // чужой проект — другим цветом
                : 'bg-brand text-brand-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          {first ? <Pause className="size-4" /> : <Play className="size-4" />}
        </button>
        {first && (
          <>
            <button
              onClick={() => navigate(`/p/${first.projectId}/time`)}
              className={cn('font-mono text-[10px] tabular-nums', elsewhere ? 'text-amber-500' : 'text-brand')}
              title={elsewhere ? t('time.runningIn', { project: elsewhere }) : t('time.openPage')}
            >
              {formatElapsed(elapsed)}
            </button>
            {/* маленький значок проекта: в узкой колонке это единственный
                способ понять, чей таймер идёт */}
            {(() => {
              const p = myProjects.find((x) => x.id === first.projectId)
              return p ? <ProjectBadge name={p.name} color={p.color} logoUrl={p.logoUrl} size={16} /> : null
            })()}
          </>
        )}
      </div>
    )
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <button
        onClick={toggle}
        title={first ? (elsewhere ? t('time.runningIn', { project: elsewhere }) : t('time.stop')) : t('time.start')}
        className={cn(
          'grid size-8 shrink-0 place-items-center rounded-md transition-colors',
          first
            ? elsewhere
              ? 'bg-amber-500/20 text-amber-500'
              : 'bg-brand text-brand-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        {first ? <Pause className="size-4" /> : <Play className="size-4" />}
      </button>

      {first ? (
        <div className="min-w-0 flex-1 leading-tight">
          <span className={cn('block font-mono text-xs tabular-nums', elsewhere ? 'text-amber-500' : 'text-brand')}>
            {formatElapsed(elapsed)}
            {count > 1 && <span className="ms-1 text-[10px] text-muted-foreground">+{count - 1}</span>}
          </span>
          {/* К какому проекту привязан таймер — видно ВСЕГДА, а не только когда
              он чужой: стоя в своём проекте, человек иначе решает, что таймер
              общий, раз он висит над списком проектов. */}
          <div className="flex items-center gap-1">
            <ProjectSwitch
              projects={myProjects}
              currentId={first.projectId}
              onPick={(target) => move.mutate({ id: first.id, projectId: target })}
            />
            {!elsewhere && (
              <StartTimeEdit
                startedAt={first.startedAt}
                onChange={(iso) => patchStart.mutate({ id: first.id, startedAt: iso })}
                label={first.task ? `${first.task.number}` : first.description || t('time.noTask')}
              />
            )}
          </div>
        </div>
      ) : (
        // Поле, а не надпись: чаще всего человек хочет сразу сказать, над чем
        // садится работать, и лишний заход на страницу учёта ради этого лишний.
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') start.mutate(draft.trim())
          }}
          placeholder={t('time.whatAreYouDoing')}
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
      )}

      <button
        onClick={() => navigate(`/p/${projectId}/time`)}
        title={t('time.openPage')}
        className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Clock3 className="size-4" />
      </button>
    </div>
  )
}

/**
 * Время начала правится на месте: «9», «930», «9:30» — как в Clockify.
 * Если введённое время в будущем, значит речь о вчерашнем дне.
 */
function StartTimeEdit({
  startedAt,
  onChange,
  label,
}: {
  startedAt: string
  onChange: (iso: string) => void
  label: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')

  const started = new Date(startedAt)
  const shown = `${String(started.getHours()).padStart(2, '0')}:${String(started.getMinutes()).padStart(2, '0')}`

  const commit = () => {
    const minutes = parseTimeOfDay(draft)
    if (minutes === null) {
      setOpen(false)
      return
    }
    const next = withTimeOfDay(started, minutes)
    // указали время позже текущего момента — значит начали вчера
    if (next.getTime() > Date.now()) next.setDate(next.getDate() - 1)
    onChange(next.toISOString())
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setDraft(shown)
      }}
    >
      <PopoverTrigger asChild>
        <button className="block max-w-full truncate text-[10px] text-muted-foreground hover:text-foreground">
          {shown} · {label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-44 p-2" align="start">
        <p className="mb-1 text-[10px] text-muted-foreground">{t('time.startedAt')}</p>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setOpen(false)
          }}
          placeholder="9:30"
          className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none"
        />
      </PopoverContent>
    </Popover>
  )
}

/** Значок проекта, к которому привязан таймер; по клику — перенести в другой. */
function ProjectSwitch({
  projects,
  currentId,
  onPick,
}: {
  projects: ProjectLite[]
  currentId: string
  onPick: (projectId: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const current = projects.find((p) => p.id === currentId)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex min-w-0 items-center gap-1 rounded px-0.5 py-0.5 transition-colors hover:bg-accent"
          title={t('time.changeProject')}
        >
          <ProjectBadge name={current?.name ?? '?'} color={current?.color} logoUrl={current?.logoUrl} size={14} />
          <span className="max-w-24 truncate text-[10px] text-muted-foreground">{current?.name ?? '—'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1" align="start">
        <p className="px-2 py-1 text-[10px] text-muted-foreground">{t('time.changeProject')}</p>
        {projects.map((p) => (
          <button
            key={p.id}
            onClick={() => {
              if (p.id !== currentId) onPick(p.id)
              setOpen(false)
            }}
            className={cn(
              'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent',
              p.id === currentId && 'bg-brand/10',
            )}
          >
            <ProjectBadge name={p.name} color={p.color} logoUrl={p.logoUrl} size={18} />
            <span className="min-w-0 truncate">{p.name}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
