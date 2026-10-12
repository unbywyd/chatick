import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { SOCKET_EVENT, type CompanyRole, type Person, type ProjectRef, type SocketMessage } from '../data'
import { fmtHm } from '../util'

/**
 * Данные «Часов» (v2). Всё по компании и по сессии:
 *  - записи — GET /api/v1/time/company/:id/entries (свои у участника, любые у руководства);
 *  - свод «человек × проект» — GET /api/v1/time/company/:id (обрезан по периоду, для расчётов);
 *  - правка своих записей — /api/v1/my/time/*.
 */

export type Entry = {
  id: string
  userId: string
  user: Person
  projectId: string | null
  project: ProjectRef | null
  task: { id: string; number: string; title: string } | null
  description: string
  startedAt: string
  endedAt: string | null
  running: boolean
  minutes: number | null
  autoStopped: boolean
}

export type ReportPerson = {
  userId: string
  name: string
  avatarUrl: string | null
  minutes: number
  projects: { id: string | null; name: string; minutes: number; color: string | null; logoUrl: string | null; noProject?: true }[]
}
export type ReportProject = { id: string | null; name: string; color: string | null; logoUrl: string | null; minutes: number; noProject?: true }
export type Report = { people: ReportPerson[]; projects: ReportProject[]; totalMinutes: number }

export type Member = { role: CompanyRole; user: { id: string; name: string; email: string; avatarUrl: string | null } }

export type Per = 'day' | 'week' | 'month' | 'custom'
/** Фильтр проекта: всё, конкретный проект или «без проекта». */
export type PF = 'all' | 'none' | string

export const tkeys = {
  entries: (companyId: string, q: string) => ['v2', 'time', 'entries', companyId, q] as const,
  report: (companyId: string, q: string) => ['v2', 'time', 'report', companyId, q] as const,
  members: (companyId: string) => ['v2', 'time', 'members', companyId] as const,
  config: (companyId: string) => ['v2', 'time', 'config', companyId] as const,
}

// --- даты: ключ дня 'YYYY-MM-DD' в местном поясе ---------------------------

const pad = (n: number) => String(n).padStart(2, '0')
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const parseDay = (k: string) => {
  const [y, m, d] = k.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d)
}
export const addDays = (k: string, n: number) => {
  const d = parseDay(k)
  d.setDate(d.getDate() + n)
  return dayKey(d)
}
export const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
export const todayKey = () => dayKey(new Date())

/** «09:30» → минуты; вне суток или не по формату — null. */
export function toMin(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((t || '').trim())
  return m && +m[1]! < 24 && +m[2]! < 60 ? +m[1]! * 60 + +m[2]! : null
}
/** Дата + время в местном поясе → Date. */
export function at(day: string, time: string): Date | null {
  const m = toMin(time)
  if (m == null || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const d = parseDay(day)
  d.setMinutes(m)
  return d
}
/** «1:30» или «2» (часы) → минуты. */
export function parseDur(t: string): number | null {
  const s = (t || '').trim()
  const a = /^(\d{1,3}):(\d{2})$/.exec(s)
  if (a) return +a[1]! * 60 + +a[2]!
  const b = /^(\d{1,3})$/.exec(s)
  return b ? +b[1]! * 60 : null
}

/** Границы периода [с, по] — ключи дней. Неделя начинается с дня из настроек компании. */
export function rangeOf(per: Per, anchor: string, cFrom: string, cTo: string, weekStart: number): [string, string] {
  if (per === 'day') return [anchor, anchor]
  if (per === 'week') {
    const wd = (parseDay(anchor).getDay() - weekStart + 7) % 7
    const s = addDays(anchor, -wd)
    return [s, addDays(s, 6)]
  }
  if (per === 'month') {
    const d = parseDay(anchor)
    return [dayKey(new Date(d.getFullYear(), d.getMonth(), 1)), dayKey(new Date(d.getFullYear(), d.getMonth() + 1, 0))]
  }
  return cFrom <= cTo ? [cFrom, cTo] : [cTo, cFrom]
}

/** Период для сервера: местные сутки целиком, в ISO — пояс человека, а не сервера. */
export function rangeQuery(r: [string, string]) {
  const from = parseDay(r[0])
  const to = parseDay(r[1])
  to.setHours(23, 59, 59, 999)
  return `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`
}

export const minutesOf = (e: Entry, now: number) =>
  Math.max(0, Math.round(((e.endedAt ? new Date(e.endedAt).getTime() : now) - new Date(e.startedAt).getTime()) / 60_000))

export const hm = (min: number) => fmtHm(Math.round(min))

// --- запросы ---------------------------------------------------------------

export function useEntries(companyId: string, r: [string, string], opts: { userId?: string; pf?: PF; enabled?: boolean }) {
  const q = [rangeQuery(r), opts.userId ? `userId=${encodeURIComponent(opts.userId)}` : '', opts.pf && opts.pf !== 'all' ? `projectId=${encodeURIComponent(opts.pf)}` : '']
    .filter(Boolean)
    .join('&')
  return useQuery({
    queryKey: tkeys.entries(companyId, q),
    queryFn: () => api<{ items: Entry[]; truncated: boolean }>(`/api/v1/time/company/${encodeURIComponent(companyId)}/entries?${q}`),
    enabled: opts.enabled !== false,
    placeholderData: (prev) => prev,
  })
}

export function useReport(companyId: string, r: [string, string], pf: PF, enabled: boolean) {
  const q = [rangeQuery(r), pf !== 'all' ? `projectId=${encodeURIComponent(pf)}` : ''].filter(Boolean).join('&')
  return useQuery({
    queryKey: tkeys.report(companyId, q),
    queryFn: () => api<Report>(`/api/v1/time/company/${encodeURIComponent(companyId)}?${q}`),
    enabled,
    placeholderData: (prev) => prev,
  })
}

export function useMembers(companyId: string, enabled: boolean) {
  return useQuery({
    queryKey: tkeys.members(companyId),
    queryFn: () => api<Member[]>(`/api/v1/companies/${encodeURIComponent(companyId)}/members`),
    enabled,
    staleTime: 5 * 60_000,
  })
}

/** Первый день недели компании: в Израиле неделя начинается с воскресенья. */
export function useWeekStart(companyId: string) {
  const q = useQuery({
    queryKey: tkeys.config(companyId),
    queryFn: () => api<{ config: { weekStart: number } }>(`/api/v1/companies/${encodeURIComponent(companyId)}/time-config`),
    staleTime: 10 * 60_000,
  })
  return q.data?.config.weekStart ?? 1
}

/** Часы меняются и из трея, и из шапки — сокет «time» перечитывает экран. */
export function useTimeSocket() {
  const qc = useQueryClient()
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<SocketMessage>).detail?.event === 'time') void qc.invalidateQueries({ queryKey: ['v2', 'time'] })
    }
    window.addEventListener(SOCKET_EVENT, on)
    return () => window.removeEventListener(SOCKET_EVENT, on)
  }, [qc])
}

/** Текущее время, тикающее раз в полминуты: идущая запись растёт на глазах. */
export function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])
  return now
}
