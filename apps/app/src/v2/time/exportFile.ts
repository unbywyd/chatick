import * as XLSX from 'xlsx'
import { dayKey, hhmm, type Entry, type ReportPerson } from './timeData'

/**
 * Сборка файлов выгрузки — тот же подход, что в старом отчёте компании
 * (components/company/CompanyTimeTab.tsx): настоящий .xlsx, часы — числом.
 * CSV Excel разбирает сам по своей локали и превращает «5.50» в дату.
 *
 * Архив «файл на каждого» — zip из той же библиотеки (XLSX.CFB умеет писать
 * zip; новых зависимостей не нужно). Имена файлов в архиве — только латиница:
 * CFB не ставит флаг UTF-8, и «Дана.xlsx» в архиве превращается в кашу.
 */

export type Cell = string | number
export type Table = { name: string; file: string; rows: Cell[][] }
export type Cols = { person: string; date: string; start: string; endDate: string; end: string; hours: string; project: string; taskNo: string; task: string; note: string; total: string }

/** Часы числом, а не строкой: по столбцу должны считаться суммы. */
export const hoursNum = (min: number) => Number((min / 60).toFixed(2))

export function entryRows(list: Entry[], cols: Cols, lng: string, noProject: string, withPerson: boolean): Cell[][] {
  const date = (d: Date) => d.toLocaleDateString(lng, { day: '2-digit', month: '2-digit', year: 'numeric' })
  const head = [cols.date, cols.start, cols.endDate, cols.end, cols.hours, cols.project, cols.taskNo, cols.task, cols.note]
  const rows: Cell[][] = [withPerson ? [cols.person, ...head] : head]
  for (const e of list) {
    if (!e.endedAt) continue
    const s = new Date(e.startedAt)
    const f = new Date(e.endedAt)
    const min = Math.round((f.getTime() - s.getTime()) / 60_000)
    const r: Cell[] = [
      date(s),
      hhmm(s),
      dayKey(f) === dayKey(s) ? '' : date(f),
      hhmm(f),
      hoursNum(min),
      e.project?.name ?? noProject,
      e.task?.number ?? '',
      e.task?.title ?? '',
      e.description ?? '',
    ]
    rows.push(withPerson ? [e.user?.name ?? '', ...r] : r)
  }
  return rows
}

/** Итоги: человек × проект, часы числом, последний столбец — всего. */
export function totalRows(people: ReportPerson[], cols: Cols, noProject: string): Cell[][] {
  const projs: { id: string | null; name: string }[] = []
  for (const p of people) for (const pr of p.projects) if (!projs.some((x) => x.id === pr.id)) projs.push({ id: pr.id, name: pr.id ? pr.name : noProject })
  // «Без проекта» — последним столбцом, как на экране.
  projs.sort((a, b) => Number(a.id === null) - Number(b.id === null))
  const rows: Cell[][] = [[cols.person, ...projs.map((p) => p.name), cols.total]]
  for (const p of people) {
    rows.push([p.name, ...projs.map((pr) => hoursNum(p.projects.find((x) => x.id === pr.id)?.minutes ?? 0)), hoursNum(p.minutes)])
  }
  return rows
}

/** Свод по записям — для своих часов и одного человека, где свода с сервера нет. */
export function personFromEntries(userId: string, name: string, list: Entry[]): ReportPerson {
  const by = new Map<string, ReportPerson['projects'][number]>()
  let total = 0
  for (const e of list) {
    if (!e.endedAt || e.userId !== userId) continue
    const m = Math.round((new Date(e.endedAt).getTime() - new Date(e.startedAt).getTime()) / 60_000)
    total += m
    const k = e.projectId ?? ''
    const cur = by.get(k) ?? { id: e.projectId, name: e.project?.name ?? '', minutes: 0, color: e.project?.color ?? null, logoUrl: e.project?.logoUrl ?? null }
    cur.minutes += m
    by.set(k, cur)
  }
  return { userId, name, avatarUrl: null, minutes: total, projects: [...by.values()].sort((a, b) => b.minutes - a.minutes) }
}

const widthsOf = (rows: Cell[][]) =>
  (rows[0] ?? []).map((_, i) => ({ wch: Math.min(48, Math.max(8, ...rows.slice(0, 200).map((r) => String(r[i] ?? '').length + 2))) }))

const sheetOf = (rows: Cell[][]) => {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!cols'] = widthsOf(rows)
  return ws
}

/** Имя листа: до 31 знака, без []:*?/\ и без повторов — иначе Excel не откроет книгу. */
function sheetName(name: string, used: Set<string>) {
  const base = name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet'
  let n = base
  for (let i = 2; used.has(n.toLowerCase()); i++) n = `${base.slice(0, 28)} ${i}`
  used.add(n.toLowerCase())
  return n
}

const csvOf = (rows: Cell[][]) =>
  '﻿' + rows.map((r) => r.map((c) => (typeof c === 'number' ? String(c) : /[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n')

function save(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 5000)
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** Одна таблица — один файл. */
export function saveOne(t: Table, fmt: 'xlsx' | 'csv') {
  if (fmt === 'csv') return save(csvOf(t.rows), `${t.file}.csv`, 'text/csv;charset=utf-8')
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheetOf(t.rows), sheetName(t.name, new Set()))
  save(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer, `${t.file}.xlsx`, XLSX_MIME)
}

/** Одна книга, лист на человека. */
export function saveSheets(tables: Table[], file: string) {
  const wb = XLSX.utils.book_new()
  const used = new Set<string>()
  for (const t of tables) XLSX.utils.book_append_sheet(wb, sheetOf(t.rows), sheetName(t.name, used))
  save(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer, `${file}.xlsx`, XLSX_MIME)
}

/** Архив: файл на каждого. */
export function saveZip(tables: Table[], fmt: 'xlsx' | 'csv', file: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CFB = (XLSX as any).CFB
  const zip = CFB.utils.cfb_new({ root: 'R' })
  const used = new Set<string>()
  for (const t of tables) {
    let n = t.file
    for (let i = 2; used.has(n); i++) n = `${t.file}-${i}`
    used.add(n)
    if (fmt === 'csv') CFB.utils.cfb_add(zip, `${n}.csv`, new TextEncoder().encode(csvOf(t.rows)))
    else {
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, sheetOf(t.rows), sheetName(t.name, new Set()))
      CFB.utils.cfb_add(zip, `${n}.xlsx`, new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer))
    }
  }
  save(new Uint8Array(CFB.write(zip, { fileType: 'zip', type: 'array' })), `${file}.zip`, 'application/zip')
}

/** Латиница для имени файла: из почты или имени; иначе — номер. */
export function asciiName(...cands: (string | null | undefined)[]): string {
  for (const c of cands) {
    const s = (c ?? '')
      .split('@')[0]!
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (s) return s
  }
  return ''
}

/** Колонки ровной ширины для превью в окне выгрузки. */
export function previewText(rows: Cell[][], maxRows = 3): string {
  const r = rows.slice(0, maxRows).map((row) => row.slice(0, 7).map((c) => String(c)))
  const w = (r[0] ?? []).map((_, i) => Math.min(16, Math.max(...r.map((x) => (x[i] ?? '').length))))
  return r.map((x) => x.map((c, i) => (c.length > 16 ? c.slice(0, 15) + '…' : c).padEnd(w[i]! + 2)).join('').trimEnd()).join('\n')
}
