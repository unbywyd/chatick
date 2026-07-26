import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Download, Search } from 'lucide-react'
import { api } from '@/lib/api'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { PeriodPicker, resolvePreset, type Period } from '@/components/ui/period-picker'
import { formatDuration } from '@/lib/time-parse'

// Часы по всей компании (SPEC §8.32): кто сколько отработал и на каких
// проектах. Нужно для расчётов с людьми, поэтому строки — «человек × проект»
// и выгружаются одной кнопкой.

type Person = {
  userId: string
  name: string
  avatarUrl: string | null
  minutes: number
  projects: { id: string; name: string; minutes: number }[]
  days: { day: string; minutes: number }[]
  /** рабочих дней в периоде — по ним, а не по календарным, считается среднее */
  daysWorked: number
  avgPerDay: number
}
type Report = { people: Person[]; totalMinutes: number }

/** BOM: без него Excel открывает CSV с кириллицей как мусор. */
const BOM = '\ufeff'
type Member = { user: { id: string; name: string; email: string; avatarUrl: string | null } }

export function CompanyTimeTab({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const [period, setPeriod] = useState<Period>(() => resolvePreset('lastMonth'))
  const [userId, setUserId] = useState('')
  const [q, setQ] = useState('')

  const members = useQuery({
    queryKey: ['company-members', companyId],
    queryFn: () => api<{ members: Member[] }>(`/api/v1/companies/${companyId}/members`),
  })

  const query = useMemo(() => {
    const p = new URLSearchParams()
    if (period.from) p.set('from', period.from)
    if (period.to) p.set('to', period.to)
    if (userId) p.set('userId', userId)
    return p.toString()
  }, [period, userId])

  const report = useQuery({
    queryKey: ['company-time', companyId, query],
    queryFn: () => api<Report>(`/api/v1/time/company/${companyId}?${query}`, {}, 'project'),
  })

  const all = report.data?.people ?? []
  // поиск по имени: на двадцати сотрудниках список уже не проглядеть глазами
  const people = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return needle ? all.filter((p) => p.name.toLowerCase().includes(needle)) : all
  }, [all, q])

  /** Точка с запятой: Excel в русской локали не разбивает запятые. */
  const download = (rows: string[][], name: string) => {
    const csv = rows.map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(';')).join('\n')
    const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${name}-${period.from || 'all'}_${period.to || 'now'}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  /** Свод: человек × проект. По нему считают, кому сколько заплатить. */
  const exportSummary = () => {
    if (!people.length) {
      toast.error(t('time.nothingToExport'))
      return
    }
    download(
      [
        ['Person', 'Project', 'Hours', 'Minutes', 'Days worked', 'Avg per day (h)'],
        ...people.flatMap((p) =>
          p.projects.map((pr, i) => [
            p.name,
            pr.name,
            (pr.minutes / 60).toFixed(2),
            String(pr.minutes),
            // дни и среднее относятся к человеку, а не к проекту — ставим их
            // только в первой строке, иначе сумма по столбцу соврёт
            i === 0 ? String(p.daysWorked) : '',
            i === 0 ? (p.avgPerDay / 60).toFixed(2) : '',
          ]),
        ),
        [],
        ['TOTAL', '', ((report.data?.totalMinutes ?? 0) / 60).toFixed(2), String(report.data?.totalMinutes ?? 0), '', ''],
      ],
      'hours',
    )
  }

  /** Подневная: то, чем сверяют табель. */
  const exportDaily = () => {
    if (!people.length) {
      toast.error(t('time.nothingToExport'))
      return
    }
    download(
      [
        ['Person', 'Date', 'Hours', 'Minutes'],
        ...people.flatMap((p) => p.days.map((d) => [p.name, d.day, (d.minutes / 60).toFixed(2), String(d.minutes)])),
      ],
      'hours-daily',
    )
  }

  /** Выгрузка по одному человеку: чаще всего платят именно поштучно. */
  const exportPerson = (p: Person) => {
    download(
      [
        ['Person', 'Date', 'Hours', 'Minutes'],
        ...p.days.map((d) => [p.name, d.day, (d.minutes / 60).toFixed(2), String(d.minutes)]),
        [],
        ['Projects', '', '', ''],
        ...p.projects.map((pr) => [pr.name, '', (pr.minutes / 60).toFixed(2), String(pr.minutes)]),
        [],
        ['TOTAL', '', (p.minutes / 60).toFixed(2), String(p.minutes)],
        ['Days worked', '', String(p.daysWorked), ''],
        ['Avg per day', '', (p.avgPerDay / 60).toFixed(2), String(p.avgPerDay)],
      ],
      `hours-${p.name.replace(/\s+/g, '-').toLowerCase()}`,
    )
  }

  const maxMinutes = Math.max(1, ...people.map((p) => p.minutes))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <PeriodPicker value={period} onChange={setPeriod} className="w-52" />
        <div className="relative w-48">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('people.search')} className="h-9 ps-8" />
        </div>
        <Select value={userId || 'all'} onValueChange={(v) => setUserId(v === 'all' ? '' : v)}>
          <SelectTrigger className="w-auto min-w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('time.everyone')}</SelectItem>
            {(members.data?.members ?? []).map((m) => (
              <SelectItem key={m.user.id} value={m.user.id}>
                {m.user.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Download className="size-3.5" />
              {t('time.export')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={exportSummary}>{t('time.exportSummary')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={exportDaily}>{t('time.exportDaily')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="ms-auto text-sm">
          <span className="text-muted-foreground">{t('time.total')}: </span>
          <span className="font-mono text-base font-semibold tabular-nums">
            {formatDuration(report.data?.totalMinutes ?? 0)}
          </span>
        </span>
      </div>

      {report.isLoading ? (
        <p className="py-10 text-center text-sm text-muted-foreground">…</p>
      ) : !people.length ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('time.noData')}</p>
      ) : (
        <ul className="space-y-2">
          {people.map((p) => (
            <li key={p.userId} className="rounded-lg border bg-card p-3">
              <div className="flex items-center gap-3">
                <Avatar name={p.name} src={p.avatarUrl} size={28} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                <span className="h-2 w-32 overflow-hidden rounded-full bg-secondary">
                  <span className="block h-full rounded-full bg-brand" style={{ width: `${(p.minutes / maxMinutes) * 100}%` }} />
                </span>
                <span className="w-20 shrink-0 text-end font-mono text-base tabular-nums">{formatDuration(p.minutes)}</span>
                <button
                  onClick={() => exportPerson(p)}
                  title={t('time.exportPerson')}
                  className="shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Download className="size-3.5" />
                </button>
              </div>

              {/* дни и средняя выработка: по ним сверяют табель */}
              <p className="mt-1 text-xs text-muted-foreground">
                {t('time.daysWorked', { count: p.daysWorked })} · {t('time.avgPerDay')} {formatDuration(p.avgPerDay)}
              </p>

              {/* разбивка по проектам: на какой проект списывать часы */}
              <ul className="mt-2 space-y-0.5 border-s ps-3 text-xs">
                {p.projects.map((pr) => (
                  <li key={pr.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{pr.name}</span>
                    <span className="font-mono tabular-nums text-muted-foreground">{formatDuration(pr.minutes)}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
