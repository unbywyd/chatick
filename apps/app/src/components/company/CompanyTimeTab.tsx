import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Download } from 'lucide-react'
import { api } from '@/lib/api'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
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
}
type Report = { people: Person[]; totalMinutes: number }
type Member = { user: { id: string; name: string; email: string; avatarUrl: string | null } }

export function CompanyTimeTab({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const [period, setPeriod] = useState<Period>(() => resolvePreset('lastMonth'))
  const [userId, setUserId] = useState('')

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

  const people = report.data?.people ?? []

  const exportCsv = () => {
    if (!people.length) {
      toast.error(t('time.nothingToExport'))
      return
    }
    // строка на «человек × проект»: так отчёт кладут в расчёт зарплаты
    const rows = [
      ['Person', 'Project', 'Hours', 'Minutes'],
      ...people.flatMap((p) =>
        p.projects.map((pr) => [p.name, pr.name, (pr.minutes / 60).toFixed(2), String(pr.minutes)]),
      ),
      [],
      ['TOTAL', '', ((report.data?.totalMinutes ?? 0) / 60).toFixed(2), String(report.data?.totalMinutes ?? 0)],
    ]
    // точка с запятой: Excel в русской локали не разбивает запятые
    const csv = rows.map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(';')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `hours-${period.from || 'all'}_${period.to || 'now'}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const maxMinutes = Math.max(1, ...people.map((p) => p.minutes))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <PeriodPicker value={period} onChange={setPeriod} className="w-52" />
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
        <Button variant="outline" size="sm" onClick={exportCsv}>
          <Download className="size-3.5" />
          {t('time.export')}
        </Button>
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
              </div>

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
