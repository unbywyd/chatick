import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { BarChart3, CalendarRange, Clock, Download, Plus, Search, Trash2, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DatePicker } from '@/components/ui/date-picker'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { useConfirm } from '@/components/ui/confirm'
import {
  dayOffset,
  formatDuration,
  formatTimeOfDay,
  parseTimeOfDay,
  resolveEnd,
  withTimeOfDay,
} from '@/lib/time-parse'

// Учёт времени (SPEC §8.32). Три вкладки: текущая неделя, история с экспортом,
// статистика. Записи сгруппированы по дням, новые сверху — как в Clockify.

type Entry = {
  id: string
  userId: string
  user: { id: string; name: string; avatarUrl: string | null } | null
  task: { id: string; number: string; title: string } | null
  description: string
  startedAt: string
  endedAt: string | null
  running: boolean
  minutes: number | null
  autoStopped: boolean
}
type Member = { user: { id: string; name: string; email: string; avatarUrl: string | null } }
type TaskLite = { id: string; number: string; title: string }
type Summary = {
  byUser: { userId: string; name: string; avatarUrl: string | null; minutes: number; entries: number }[]
  byTask: { taskId: string | null; number: string | null; title: string | null; minutes: number; entries: number }[]
  byDay: { day: string; minutes: number }[]
  totalMinutes: number
  canSeeOthers: boolean
}

type Tab = 'week' | 'history' | 'stats'

/** Понедельник текущей недели — неделя считается с него во всех трёх языках. */
function weekStart(): string {
  const d = new Date()
  const day = (d.getDay() + 6) % 7 // 0 = понедельник
  d.setDate(d.getDate() - day)
  d.setHours(0, 0, 0, 0)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function TimeTab({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('week')

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <Clock className="size-5" />
          {t('time.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('time.subtitle')}</p>
      </div>

      <div className="flex gap-1 border-b">
        {(
          [
            ['week', CalendarRange],
            ['history', Search],
            ['stats', BarChart3],
          ] as const
        ).map(([key, Icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors',
              tab === key ? 'border-brand text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-3.5" />
            {t(`time.tab.${key}`)}
          </button>
        ))}
      </div>

      {tab === 'week' && <WeekView projectId={projectId} />}
      {tab === 'history' && <HistoryView projectId={projectId} />}
      {tab === 'stats' && <StatsView projectId={projectId} />}
    </div>
  )
}

// --- Неделя ------------------------------------------------------------------

function WeekView({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const [adding, setAdding] = useState(false)
  const from = useMemo(weekStart, [])

  const entries = useQuery({
    queryKey: ['time-entries', projectId, from],
    queryFn: () => api<{ items: Entry[]; canSeeOthers: boolean }>(`/api/v1/time?from=${from}`, {}, 'project'),
  })

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t('time.weekHint')}</p>
        <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
          <Plus className="size-3.5" />
          {t('time.addManual')}
        </Button>
      </div>

      {adding && <ManualEntryForm projectId={projectId} onDone={() => setAdding(false)} />}

      <EntryList projectId={projectId} items={entries.data?.items ?? []} loading={entries.isLoading} />
    </div>
  )
}

// --- История -----------------------------------------------------------------

function HistoryView({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [userId, setUserId] = useState('')
  const [q, setQ] = useState('')

  const members = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => api<Member[]>(`/api/v1/projects/${projectId}/members`),
  })

  const query = useMemo(() => {
    const p = new URLSearchParams()
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    if (userId) p.set('userId', userId)
    if (q.trim()) p.set('q', q.trim())
    p.set('limit', '500')
    return p.toString()
  }, [from, to, userId, q])

  const entries = useQuery({
    queryKey: ['time-entries', projectId, 'history', query],
    queryFn: () => api<{ items: Entry[]; canSeeOthers: boolean }>(`/api/v1/time?${query}`, {}, 'project'),
  })

  /** Быстрые периоды: их выбирают чаще, чем набирают даты руками. */
  const preset = (days: number) => {
    const end = new Date()
    const start = new Date()
    start.setDate(start.getDate() - days)
    setFrom(isoDay(start))
    setTo(isoDay(end))
  }

  const exportCsv = () => {
    const items = entries.data?.items ?? []
    if (!items.length) {
      toast.error(t('time.nothingToExport'))
      return
    }
    const rows = [
      ['Date', 'Start', 'End', 'Duration (h)', 'Person', 'Task', 'Description'],
      ...items.map((e) => {
        const s = new Date(e.startedAt)
        const end = e.endedAt ? new Date(e.endedAt) : null
        return [
          isoDay(s),
          formatTimeOfDay(s.getHours() * 60 + s.getMinutes()),
          end ? formatTimeOfDay(end.getHours() * 60 + end.getMinutes()) : '',
          e.minutes != null ? (e.minutes / 60).toFixed(2) : '',
          e.user?.name ?? '',
          e.task ? `${e.task.number} ${e.task.title}` : '',
          e.description,
        ]
      }),
    ]
    // разделитель — точка с запятой: Excel в русской локали иначе не разбивает
    const csv = rows.map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(';')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `time-${from || 'all'}_${to || 'now'}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const total = (entries.data?.items ?? []).reduce((sum, e) => sum + (e.minutes ?? 0), 0)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('time.searchPlaceholder')} className="h-9 ps-8" />
        </div>
        <DatePicker value={from} onChange={setFrom} className="w-36" />
        <DatePicker value={to} onChange={setTo} className="w-36" />
        <Select value={userId || 'all'} onValueChange={(v) => setUserId(v === 'all' ? '' : v)}>
          <SelectTrigger className="w-auto min-w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('time.everyone')}</SelectItem>
            {(members.data ?? []).map((m) => (
              <SelectItem key={m.user.id} value={m.user.id}>
                {m.user.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={exportCsv}>
          <Download className="size-3.5" />
          {t('time.export')}
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {(
          [
            [7, 'week'],
            [30, 'month'],
            [90, 'quarter'],
            [180, 'halfYear'],
            [365, 'year'],
          ] as const
        ).map(([days, key]) => (
          <button
            key={key}
            onClick={() => preset(days)}
            className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {t(`time.period.${key}`)}
          </button>
        ))}
        {(from || to || userId || q) && (
          <button
            onClick={() => {
              setFrom('')
              setTo('')
              setUserId('')
              setQ('')
            }}
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" />
            {t('journal.clearFilters')}
          </button>
        )}
      </div>

      <p className="text-sm">
        <span className="text-muted-foreground">{t('time.total')}: </span>
        <span className="font-mono font-semibold tabular-nums">{formatDuration(total)}</span>
      </p>

      <EntryList projectId={projectId} items={entries.data?.items ?? []} loading={entries.isLoading} />
    </div>
  )
}

// --- Статистика ---------------------------------------------------------------

function StatsView({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const [from, setFrom] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 30)
    return isoDay(d)
  })
  const [to, setTo] = useState(() => isoDay(new Date()))

  const summary = useQuery({
    queryKey: ['time-summary', projectId, from, to],
    queryFn: () => api<Summary>(`/api/v1/time/summary?from=${from}&to=${to}`, {}, 'project'),
  })

  const s = summary.data
  const maxUser = Math.max(1, ...(s?.byUser ?? []).map((u) => u.minutes))
  const maxDay = Math.max(1, ...(s?.byDay ?? []).map((d) => d.minutes))

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <DatePicker value={from} onChange={setFrom} className="w-36" />
        <DatePicker value={to} onChange={setTo} className="w-36" />
        <span className="ms-auto text-sm">
          <span className="text-muted-foreground">{t('time.total')}: </span>
          <span className="font-mono font-semibold tabular-nums">{formatDuration(s?.totalMinutes ?? 0)}</span>
        </span>
      </div>

      {/* По дням — простые столбики: показывают ритм работы без библиотеки графиков */}
      <section className="rounded-lg border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">{t('time.byDay')}</h2>
        {(s?.byDay ?? []).length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">{t('time.noData')}</p>
        ) : (
          <div className="flex h-32 items-end gap-1">
            {(s?.byDay ?? []).map((d) => (
              <div key={d.day} className="group relative flex-1" title={`${d.day} — ${formatDuration(d.minutes)}`}>
                <div
                  className="w-full rounded-t bg-brand/70 transition-colors group-hover:bg-brand"
                  style={{ height: `${Math.max(2, (d.minutes / maxDay) * 100)}%` }}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-lg border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">{t('time.byPerson')}</h2>
        {(s?.byUser ?? []).length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">{t('time.noData')}</p>
        ) : (
          <ul className="space-y-2">
            {(s?.byUser ?? []).map((u) => (
              <li key={u.userId} className="flex items-center gap-3">
                <Avatar name={u.name} src={u.avatarUrl} size={24} />
                <span className="w-32 shrink-0 truncate text-sm">{u.name}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                  <span className="block h-full rounded-full bg-brand" style={{ width: `${(u.minutes / maxUser) * 100}%` }} />
                </span>
                <span className="w-16 shrink-0 text-end font-mono text-sm tabular-nums">{formatDuration(u.minutes)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">{t('time.byTask')}</h2>
        {(s?.byTask ?? []).length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">{t('time.noData')}</p>
        ) : (
          <ul className="space-y-1.5">
            {(s?.byTask ?? []).map((task) => (
              <li key={task.taskId ?? 'none'} className="flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {task.taskId ? (
                    <>
                      <span className="font-mono text-xs text-muted-foreground">{task.number}</span> {task.title}
                    </>
                  ) : (
                    <span className="text-muted-foreground">{t('time.withoutTask')}</span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{task.entries}×</span>
                <span className="w-16 shrink-0 text-end font-mono tabular-nums">{formatDuration(task.minutes)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

// --- Список записей по дням ---------------------------------------------------

function EntryList({ projectId, items, loading }: { projectId: string; items: Entry[]; loading: boolean }) {
  const { t, i18n } = useTranslation()

  // группируем по дню начала: день — единица, которой человек мыслит
  const days = useMemo(() => {
    const map = new Map<string, Entry[]>()
    for (const e of items) {
      const key = isoDay(new Date(e.startedAt))
      map.set(key, [...(map.get(key) ?? []), e])
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [items])

  if (loading) return <p className="py-6 text-center text-sm text-muted-foreground">…</p>
  if (!items.length) return <p className="py-10 text-center text-sm text-muted-foreground">{t('time.empty')}</p>

  return (
    <div className="space-y-4">
      {days.map(([day, list]) => {
        const total = list.reduce((sum, e) => sum + (e.minutes ?? 0), 0)
        return (
          <div key={day}>
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">
                {new Date(`${day}T00:00:00`).toLocaleDateString(i18n.language, {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                })}
              </h3>
              <span className="font-mono text-sm tabular-nums text-muted-foreground">{formatDuration(total)}</span>
            </div>
            <ul className="divide-y rounded-lg border bg-card">
              {list.map((e) => (
                <EntryRow key={e.id} projectId={projectId} entry={e} />
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

function EntryRow({ projectId, entry }: { projectId: string; entry: Entry }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()

  const onErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['time-entries', projectId] })
    qc.invalidateQueries({ queryKey: ['time-running', projectId] })
    qc.invalidateQueries({ queryKey: ['time-summary', projectId] })
  }

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/v1/time/${entry.id}`, { method: 'PATCH', body: JSON.stringify(body) }, 'project'),
    onSuccess: refresh,
    onError: onErr,
  })
  const remove = useMutation({
    mutationFn: () => api(`/api/v1/time/${entry.id}`, { method: 'DELETE' }, 'project'),
    onSuccess: refresh,
    onError: onErr,
  })

  const start = new Date(entry.startedAt)
  const end = entry.endedAt ? new Date(entry.endedAt) : null
  const offset = end ? dayOffset(start, end) : 0

  return (
    <li className="group flex items-center gap-3 px-3 py-2">
      {entry.user && <Avatar name={entry.user.name} src={entry.user.avatarUrl} size={22} />}

      <div className="min-w-0 flex-1">
        <input
          defaultValue={entry.description}
          onBlur={(e) => {
            if (e.target.value !== entry.description) patch.mutate({ description: e.target.value })
          }}
          placeholder={t('time.descriptionPlaceholder')}
          className="w-full truncate bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {entry.task && (
          <span className="text-xs text-muted-foreground">
            <span className="font-mono">{entry.task.number}</span> {entry.task.title}
          </span>
        )}
      </div>

      {/* время правится на месте: 9, 930, 9:30 */}
      <TimeCell
        value={start}
        onCommit={(minutes) => patch.mutate({ startedAt: withTimeOfDay(start, minutes).toISOString() })}
      />
      <span className="text-xs text-muted-foreground">–</span>
      {end ? (
        <span className="relative">
          <TimeCell value={end} onCommit={(minutes) => patch.mutate({ endedAt: resolveEnd(start, minutes).toISOString() })} />
          {offset > 0 && (
            <span className="absolute -end-3 -top-1 text-[9px] text-brand" title={t('time.nextDay')}>
              +{offset}
            </span>
          )}
        </span>
      ) : (
        <span className="w-12 text-center text-xs text-brand">{t('time.running')}</span>
      )}

      <span className="w-14 shrink-0 text-end font-mono text-sm tabular-nums">
        {entry.minutes != null ? formatDuration(entry.minutes) : '—'}
      </span>

      {entry.autoStopped && (
        <span className="shrink-0 text-[10px] text-amber-500" title={t('time.autoStoppedHint')}>
          {t('time.autoStopped')}
        </span>
      )}

      <button
        onClick={async () => {
          if (await confirm({ title: t('time.deleteConfirm'), destructive: true, confirmLabel: t('files.delete') }))
            remove.mutate()
        }}
        className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
      >
        <Trash2 className="size-3.5" />
      </button>
    </li>
  )
}

/** Ячейка времени: показывает «09:30», принимает «9», «930», «9:30». */
function TimeCell({ value, onCommit }: { value: Date; onCommit: (minutes: number) => void }) {
  const shown = formatTimeOfDay(value.getHours() * 60 + value.getMinutes())
  const [draft, setDraft] = useState<string | null>(null)

  return (
    <input
      value={draft ?? shown}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => {
        if (draft === null) return
        const minutes = parseTimeOfDay(draft)
        setDraft(null)
        if (minutes !== null && formatTimeOfDay(minutes) !== shown) onCommit(minutes)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setDraft(null)
          e.currentTarget.blur()
        }
      }}
      className="w-12 shrink-0 rounded bg-transparent text-center font-mono text-sm tabular-nums outline-none hover:bg-accent focus:bg-accent"
    />
  )
}

/** Запись задним числом — работал, а таймер не включил. */
function ManualEntryForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [day, setDay] = useState(() => isoDay(new Date()))
  const [fromText, setFromText] = useState('')
  const [toText, setToText] = useState('')
  const [description, setDescription] = useState('')
  const [taskId, setTaskId] = useState('')

  const tasksQ = useQuery({
    queryKey: ['tasks', projectId],
    queryFn: () => api<TaskLite[]>('/api/v1/tasks', {}, 'project'),
  })

  const create = useMutation({
    mutationFn: () => {
      const startMinutes = parseTimeOfDay(fromText)
      const endMinutes = parseTimeOfDay(toText)
      if (startMinutes === null || endMinutes === null) throw new Error(t('time.badTime'))
      const base = new Date(`${day}T00:00:00`)
      const startedAt = withTimeOfDay(base, startMinutes)
      const endedAt = resolveEnd(startedAt, endMinutes)
      return api(
        '/api/v1/time',
        {
          method: 'POST',
          body: JSON.stringify({
            startedAt: startedAt.toISOString(),
            endedAt: endedAt.toISOString(),
            description,
            taskId: taskId || null,
          }),
        },
        'project',
      )
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['time-entries', projectId] })
      onDone()
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3">
      <DatePicker value={day} onChange={setDay} className="w-36" clearable={false} />
      <Input value={fromText} onChange={(e) => setFromText(e.target.value)} placeholder="9:00" className="h-9 w-20" />
      <Input value={toText} onChange={(e) => setToText(e.target.value)} placeholder="17:30" className="h-9 w-20" />
      <Input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t('time.descriptionPlaceholder')}
        className="h-9 min-w-40 flex-1"
      />
      <Select value={taskId || 'none'} onValueChange={(v) => setTaskId(v === 'none' ? '' : v)}>
        <SelectTrigger className="w-auto min-w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{t('time.noTask')}</SelectItem>
          {(tasksQ.data ?? []).map((task) => (
            <SelectItem key={task.id} value={task.id}>
              {task.number} · {task.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="brand" size="sm" onClick={() => create.mutate()} disabled={create.isPending}>
        {t('common.save')}
      </Button>
      <Button variant="ghost" size="sm" onClick={onDone}>
        {t('common.cancel')}
      </Button>
    </div>
  )
}
