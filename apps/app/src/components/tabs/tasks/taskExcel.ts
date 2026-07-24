import * as XLSX from 'xlsx'
import type { Task, TaskGroup, Member, Status, Priority } from './types'
import { STATUSES, PRIORITIES } from './types'

// Импорт/экспорт задач через Excel (.xlsx).

const fmtMins = (m: number | null) => (m == null ? '' : String(m))
const fmtDate = (d: string | null) => (d ? new Date(d).toISOString().slice(0, 10) : '')

// Заголовки колонок (стабильные ключи для импорта, независимо от языка)
const COLS = ['Number', 'Title', 'Description', 'Status', 'Priority', 'Assignee', 'Due', 'EstimateMinutes', 'Sprint'] as const

export function exportTasksToExcel(tasks: Task[], groups: TaskGroup[], projectName: string) {
  const groupName = (id: string | null) => (id ? (groups.find((g) => g.id === id)?.name ?? '') : '')
  const rows = tasks.map((t) => ({
    Number: t.number,
    Title: t.title,
    Description: t.description,
    Status: t.status,
    Priority: t.priority,
    Assignee: t.assignee?.name ?? '',
    Due: fmtDate(t.dueDate),
    EstimateMinutes: fmtMins(t.estimateMinutes),
    Sprint: groupName(t.groupId),
  }))
  const ws = XLSX.utils.json_to_sheet(rows, { header: COLS as unknown as string[] })
  ws['!cols'] = [{ wch: 10 }, { wch: 40 }, { wch: 50 }, { wch: 12 }, { wch: 10 }, { wch: 18 }, { wch: 12 }, { wch: 14 }, { wch: 16 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Tasks')
  const safe = projectName.replace(/[^\w\-]+/g, '_').slice(0, 40) || 'project'
  XLSX.writeFile(wb, `${safe}-tasks-${new Date().toISOString().slice(0, 10)}.xlsx`)
}

// Шаблон для импорта (пустой файл с заголовками + одна пример-строка)
export function downloadImportTemplate() {
  const example = [{ Number: '', Title: 'Example task', Description: '', Status: 'todo', Priority: 'normal', Assignee: '', Due: '2026-01-31', EstimateMinutes: '60', Sprint: '' }]
  const ws = XLSX.utils.json_to_sheet(example, { header: COLS as unknown as string[] })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Tasks')
  XLSX.writeFile(wb, 'tasks-import-template.xlsx')
}

export type ParsedTaskRow = {
  title: string
  description: string
  status: Status
  priority: Priority
  assigneeId: string | null
  groupId: string | null
  dueDate: string | null
  estimateMinutes: number | null
  raw: Record<string, unknown>
}

const norm = (v: unknown) => String(v ?? '').trim()

/** Разбирает .xlsx → строки задач, маппит статусы/приоритеты/исполнителя/спринт. */
export async function parseTasksFromExcel(
  file: File,
  members: Member[],
  groups: TaskGroup[],
): Promise<{ rows: ParsedTaskRow[]; skipped: number }> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const sheet = wb.Sheets[wb.SheetNames[0]!]
  if (!sheet) return { rows: [], skipped: 0 }
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })

  // сопоставление заголовков без учёта регистра/языка ключевых колонок
  const pick = (r: Record<string, unknown>, keys: string[]) => {
    for (const k of Object.keys(r)) {
      if (keys.some((want) => k.trim().toLowerCase() === want.toLowerCase())) return r[k]
    }
    return ''
  }
  const memberByName = (name: string) => {
    const n = name.toLowerCase()
    return members.find((m) => (m.user.name || '').toLowerCase() === n || m.user.email.toLowerCase() === n)?.user.id ?? null
  }
  const groupByName = (name: string) => {
    const n = name.toLowerCase()
    return groups.find((g) => g.name.toLowerCase() === n)?.id ?? null
  }
  const mapStatus = (v: string): Status => {
    const s = v.toLowerCase().replace(/\s+/g, '_')
    return (STATUSES as readonly string[]).includes(s) ? (s as Status) : 'todo'
  }
  const mapPriority = (v: string): Priority => {
    const p = v.toLowerCase()
    return (PRIORITIES as readonly string[]).includes(p) ? (p as Priority) : 'normal'
  }
  const parseDate = (v: unknown): string | null => {
    const s = norm(v)
    if (!s) return null
    // Excel может отдать число (serial) — XLSX уже конвертит при cellDates, но подстрахуемся
    const d = new Date(s.length <= 10 ? s + 'T12:00:00' : s)
    return isNaN(d.getTime()) ? null : d.toISOString()
  }

  let skipped = 0
  const rows: ParsedTaskRow[] = []
  for (const r of json) {
    const title = norm(pick(r, ['Title', 'Название', 'כותרת']))
    if (!title) {
      skipped++
      continue
    }
    const estRaw = norm(pick(r, ['EstimateMinutes', 'Estimate', 'Оценка', 'Минут']))
    rows.push({
      title: title.slice(0, 300),
      description: norm(pick(r, ['Description', 'Описание', 'תיאור'])).slice(0, 10_000),
      status: mapStatus(norm(pick(r, ['Status', 'Статус', 'סטטוס']))),
      priority: mapPriority(norm(pick(r, ['Priority', 'Приоритет', 'עדיפות']))),
      assigneeId: memberByName(norm(pick(r, ['Assignee', 'Исполнитель', 'אחראי']))),
      groupId: groupByName(norm(pick(r, ['Sprint', 'Спринт', 'ספרינט', 'Group']))),
      dueDate: parseDate(pick(r, ['Due', 'DueDate', 'Срок', 'Дедлайн', 'יעד'])),
      estimateMinutes: estRaw && !isNaN(Number(estRaw)) ? Math.max(0, Math.round(Number(estRaw))) : null,
      raw: r,
    })
  }
  return { rows, skipped }
}
