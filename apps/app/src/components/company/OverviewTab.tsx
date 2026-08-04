import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Clock, Download, FolderKanban, MessageSquare, Users } from 'lucide-react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { PeriodPicker, resolvePreset, type Period } from '@/components/ui/period-picker'
import { Avatar } from '@/components/ui/avatar'
import { ProjectBadge } from '@/components/ui/project-badge'
import { ChartBox } from '@/components/ui/chart-box'
import { formatDuration } from '@/lib/time-parse'

// Обзор компании (SPEC §8.33): то, чего не видно в списке проектов —
// распределение нагрузки между проектами и людьми и ритм последних недель.

type ProjectStat = {
  id: string
  name: string
  color: string
  logoUrl: string | null
  tasksTotal: number
  tasksDone: number
  overdue: number
  progress: number
  members: number
  minutes: number
  messages: number
}
type Overview = {
  projects: ProjectStat[]
  totals: {
    projects: number
    people: number
    tasksTotal: number
    tasksDone: number
    overdue: number
    minutes: number
    messages: number
  }
  weeks: { week: string; minutes: number }[]
  topPeople: { userId: string; name: string; avatarUrl: string | null; minutes: number }[]
}

const CHART_STYLE = {
  background: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  fontSize: '0.75rem',
}

export function OverviewTab({
  companyId,
  onOpenProject,
  onOpenReport,
}: {
  companyId: string
  onOpenProject?: (id: string) => void
  /** отчёт по человеку за тот же период — на вкладке «Часы» */
  onOpenReport?: (userId: string, period: Period) => void
}) {
  const { t, i18n } = useTranslation()

  // По умолчанию — текущий месяц: за него смотрят и по нему платят.
  const [period, setPeriod] = useState<Period>(() => resolvePreset('thisMonth'))

  const q = useQuery({
    queryKey: ['company-overview', companyId, period.from, period.to],
    queryFn: () =>
      api<Overview>(
        `/api/v1/companies/${companyId}/overview?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`,
      ),
  })

  const d = q.data
  const totals = d?.totals

  if (q.isLoading) return <p className="py-16 text-center text-sm text-muted-foreground">…</p>
  if (!d || !d.projects.length) {
    return <p className="py-16 text-center text-sm text-muted-foreground">{t('overview.empty')}</p>
  }

  const doneShare = totals?.tasksTotal ? Math.round((totals.tasksDone / totals.tasksTotal) * 100) : 0

  return (
    <div className="space-y-5">
      {/* Период сверху: цифры без указания срока читаются как «за всё время»,
          а смотрят обычно за месяц. */}
      <div className="flex justify-end">
        <PeriodPicker value={period} onChange={setPeriod} className="w-52" />
      </div>

      {/* Цифры, за которыми приходят в первую очередь */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric icon={Clock} label={t('overview.hours')} value={formatDuration(totals?.minutes ?? 0)} />
        <Metric
          icon={CheckCircle2}
          label={t('overview.tasks')}
          value={`${totals?.tasksDone ?? 0} / ${totals?.tasksTotal ?? 0}`}
          hint={`${doneShare}%`}
        />
        <Metric
          icon={AlertTriangle}
          label={t('overview.overdue')}
          value={String(totals?.overdue ?? 0)}
          // просрочка — единственное, что здесь стоит подсвечивать тревожно
          tone={totals?.overdue ? 'warn' : undefined}
        />
        <Metric icon={Users} label={t('overview.people')} value={String(totals?.people ?? 0)} />
      </div>

      {/* Ритм: по неделям видно, набирает компания обороты или затухает */}
      <section className="rounded-lg border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">{t('overview.rhythm')}</h2>
        {d.weeks.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('time.noData')}</p>
        ) : (
          <ChartBox height={180}>
            <AreaChart data={d.weeks} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="rhythm" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--brand)" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="var(--brand)" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-border" />
              <XAxis
                dataKey="week"
                tickFormatter={(w: string) => `${w.slice(8)}.${w.slice(5, 7)}`}
                tickLine={false}
                axisLine={false}
                className="text-[10px]"
                stroke="currentColor"
                opacity={0.5}
              />
              <YAxis
                tickFormatter={(m: number) => String(Math.round(m / 60))}
                tickLine={false}
                axisLine={false}
                width={32}
                allowDecimals={false}
                className="text-[10px]"
                stroke="currentColor"
                opacity={0.5}
              />
              <Tooltip
                contentStyle={CHART_STYLE}
                labelFormatter={(w) =>
                  t('overview.weekOf', {
                    date: new Date(`${String(w)}T00:00:00`).toLocaleDateString(i18n.language, {
                      day: 'numeric',
                      month: 'long',
                    }),
                  })
                }
                formatter={(m) => [formatDuration(Number(m)), t('time.total')]}
              />
              <Area type="monotone" dataKey="minutes" stroke="var(--brand)" strokeWidth={2} fill="url(#rhythm)" />
            </AreaChart>
          </ChartBox>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Куда уходит время: столбики в цветах проектов — узнаются с одного взгляда */}
        <section className="rounded-lg border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold">{t('overview.byProject')}</h2>
          <ChartBox height={Math.max(160, d.projects.length * 44)}>
            <BarChart data={d.projects} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid horizontal={false} strokeDasharray="3 3" className="stroke-border" />
              <XAxis
                type="number"
                tickFormatter={(m: number) => String(Math.round(m / 60))}
                tickLine={false}
                axisLine={false}
                className="text-[10px]"
                stroke="currentColor"
                opacity={0.5}
              />
              <YAxis
                type="category"
                dataKey="name"
                width={130}
                tickLine={false}
                axisLine={false}
                className="text-[10px]"
                stroke="currentColor"
                opacity={0.7}
              />
              <Tooltip
                cursor={{ fill: 'currentColor', opacity: 0.06 }}
                contentStyle={CHART_STYLE}
                formatter={(m) => [formatDuration(Number(m)), t('time.total')]}
              />
              <Bar dataKey="minutes" radius={[0, 4, 4, 0]} maxBarSize={28}>
                {d.projects.map((p) => (
                  <Cell key={p.id} fill={p.color || 'var(--brand)'} />
                ))}
              </Bar>
            </BarChart>
          </ChartBox>
        </section>

        {/* Кто тянет: распределение нагрузки между людьми */}
        <section className="rounded-lg border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold">{t('overview.byPerson')}</h2>
          {!d.topPeople.length ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('time.noData')}</p>
          ) : (
            <ul className="space-y-2">
              {d.topPeople.map((p) => {
                const max = Math.max(1, ...d.topPeople.map((x) => x.minutes))
                return (
                  <li key={p.userId} className="flex items-center gap-3">
                    <Avatar name={p.name} src={p.avatarUrl} size={24} />
                    <span className="w-32 shrink-0 truncate text-sm">{p.name}</span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                      <span className="block h-full rounded-full bg-brand" style={{ width: `${(p.minutes / max) * 100}%` }} />
                    </span>
                    <span className="w-16 shrink-0 text-end font-mono text-sm tabular-nums">
                      {formatDuration(p.minutes)}
                    </span>
                    {/* Отчёт за тот же период, что на экране: собирать его
                        заново на другой вкладке — лишняя работа. */}
                    {onOpenReport && (
                      <button
                        onClick={() => onOpenReport(p.userId, period)}
                        title={t('overview.reportFor', { name: p.name })}
                        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <Download className="size-3.5" />
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>

      {/* Проекты таблицей: прогресс, просрочка, часы и активность рядом */}
      <section className="rounded-lg border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">{t('overview.projects')}</h2>
        <ul className="space-y-2">
          {d.projects.map((p) => (
            // Строка кликается целиком: на обзоре видно, где что происходит,
            // и уходить за этим в список проектов — лишний шаг.
            <li
              key={p.id}
              onClick={() => onOpenProject?.(p.id)}
              className={cn(
                '-mx-2 flex items-center gap-3 rounded-md px-2 py-1 transition-colors',
                onOpenProject && 'cursor-pointer hover:bg-accent',
              )}
            >
              <ProjectBadge name={p.name} color={p.color} logoUrl={p.logoUrl} size={28} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium">{p.name}</span>
                  {p.overdue > 0 && (
                    <span className="shrink-0 text-[10px] text-amber-500">
                      {t('overview.overdueShort', { count: p.overdue })}
                    </span>
                  )}
                </div>
                <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-secondary">
                  <span className="block h-full rounded-full bg-brand/70" style={{ width: `${p.progress}%` }} />
                </span>
              </div>
              <span className="w-14 shrink-0 text-end text-xs tabular-nums text-muted-foreground">
                {p.tasksDone}/{p.tasksTotal}
              </span>
              <span className="hidden w-16 shrink-0 items-center justify-end gap-1 text-xs tabular-nums text-muted-foreground sm:flex">
                <Users className="size-3" />
                {p.members}
              </span>
              <span className="hidden w-20 shrink-0 items-center justify-end gap-1 text-xs tabular-nums text-muted-foreground sm:flex">
                <MessageSquare className="size-3" />
                {p.messages}
              </span>
              <span className="w-16 shrink-0 text-end font-mono text-sm tabular-nums">{formatDuration(p.minutes)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function Metric({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: typeof Clock
  label: string
  value: string
  hint?: string
  tone?: 'warn'
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className={cn('size-3.5', tone === 'warn' && 'text-amber-500')} />
        {label}
      </p>
      <p className={cn('mt-1 font-mono text-xl font-semibold tabular-nums', tone === 'warn' && 'text-amber-500')}>
        {value}
        {hint && <span className="ms-2 font-sans text-xs font-normal text-muted-foreground">{hint}</span>}
      </p>
    </div>
  )
}

/** Иконка проекта в шапке вкладки — на случай пустой компании. */
export const OverviewIcon = FolderKanban
