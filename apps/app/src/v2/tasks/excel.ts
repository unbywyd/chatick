import * as XLSX from 'xlsx'
import type { BallItem, CompanyProject } from '../data'

/**
 * Задачи в Excel и обратно (v2).
 *
 * Выгружается то, что на экране, — с учётом вкладки, проекта и поиска.
 * Загрузка заводит НОВЫЕ задачи: статус в v2 — это ход мяча, его из файла не
 * берём; задача приходит открытой, на того, кто указан в «Исполнителе».
 * Заголовки колонок — английские ключи, но читаем и русские, и иврит: файл
 * часто заполняют вручную.
 */

const COLS = ['Number', 'Title', 'Description', 'Project', 'Assignee', 'Priority', 'Due', 'EstimateMinutes'] as const
const day = (d: string | null) => (d ? new Date(d).toISOString().slice(0, 10) : '')

export function exportBall(items: BallItem[], name: string) {
  const rows = items.map((i) => ({
    Number: i.number,
    Title: i.title,
    Description: '',
    Project: i.project?.name ?? '',
    Assignee: i.holder?.name ?? '',
    Priority: i.priority,
    Due: day(i.dueDate),
    EstimateMinutes: i.estimateMinutes ?? '',
  }))
  const ws = XLSX.utils.json_to_sheet(rows, { header: COLS as unknown as string[] })
  ws['!cols'] = [{ wch: 10 }, { wch: 48 }, { wch: 30 }, { wch: 24 }, { wch: 18 }, { wch: 10 }, { wch: 12 }, { wch: 14 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Tasks')
  const safe = name.replace(/[^\p{L}\p{N}\-]+/gu, '_').slice(0, 40) || 'tasks'
  XLSX.writeFile(wb, `${safe}-${new Date().toISOString().slice(0, 10)}.xlsx`)
}

export function downloadTemplate() {
  const example = [{ Number: '', Title: 'Example task', Description: 'What to do and how to tell it is done', Project: '', Assignee: '', Priority: 'normal', Due: '2026-12-31', EstimateMinutes: '60' }]
  const ws = XLSX.utils.json_to_sheet(example, { header: COLS as unknown as string[] })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Tasks')
  XLSX.writeFile(wb, 'chatick-tasks-template.xlsx')
}

export type ImportRow = {
  title: string
  description: string
  projectId: string | null
  /** Проект назван, но такого нет — строку покажем и пропустим. */
  projectName: string
  assigneeId: string | null
  assigneeName: string
  priority: 'low' | 'normal' | 'high' | 'urgent'
  dueDate: string | null
  estimateMinutes: number | null
}

const s = (v: unknown) => String(v ?? '').trim()
const PRIO = new Set(['low', 'normal', 'high', 'urgent'])

/** .xlsx → строки новых задач. Проект без названия в файле — выбранный на экране. */
export async function parseImport(
  file: File,
  projects: CompanyProject[],
  people: { id: string; name: string; email?: string }[],
  fallbackProject: string | null,
): Promise<{ rows: ImportRow[]; skipped: number }> {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
  const sheet = wb.Sheets[wb.SheetNames[0]!]
  if (!sheet) return { rows: [], skipped: 0 }
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
  const pick = (r: Record<string, unknown>, keys: string[]) => {
    for (const k of Object.keys(r)) if (keys.some((w) => k.trim().toLowerCase() === w.toLowerCase())) return r[k]
    return ''
  }
  const lc = (x: string) => x.toLowerCase()
  const projectOf = (name: string) => {
    if (!name) return fallbackProject
    return projects.find((p) => lc(p.name) === lc(name) || lc(p.name).startsWith(lc(name)))?.id ?? null
  }
  const personOf = (name: string) => (name ? (people.find((p) => lc(p.name) === lc(name) || (p.email && lc(p.email) === lc(name)))?.id ?? null) : null)
  const dateOf = (v: unknown): string | null => {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : new Date(`${v.toISOString().slice(0, 10)}T12:00:00`).toISOString()
    const x = s(v)
    if (!x) return null
    const d = new Date(x.length <= 10 ? `${x}T12:00:00` : x)
    return isNaN(d.getTime()) ? null : d.toISOString()
  }
  let skipped = 0
  const rows: ImportRow[] = []
  for (const r of json) {
    const title = s(pick(r, ['Title', 'Название', 'Задача', 'כותרת', 'משימה']))
    if (!title) {
      skipped++
      continue
    }
    const projectName = s(pick(r, ['Project', 'Проект', 'פרויקט']))
    const assigneeName = s(pick(r, ['Assignee', 'Исполнитель', 'Кому', 'אחראי']))
    const prio = lc(s(pick(r, ['Priority', 'Важность', 'Приоритет', 'עדיפות'])))
    const est = s(pick(r, ['EstimateMinutes', 'Estimate', 'Оценка', 'Минут', 'הערכה']))
    rows.push({
      title: title.slice(0, 300),
      description: s(pick(r, ['Description', 'Описание', 'תיאור'])).slice(0, 10_000),
      projectId: projectOf(projectName),
      projectName,
      assigneeId: personOf(assigneeName),
      assigneeName,
      priority: (PRIO.has(prio) ? prio : 'normal') as ImportRow['priority'],
      dueDate: dateOf(pick(r, ['Due', 'DueDate', 'Срок', 'Дедлайн', 'מועד', 'יעד'])),
      estimateMinutes: est && !isNaN(Number(est)) ? Math.max(0, Math.round(Number(est))) : null,
    })
  }
  return { rows, skipped }
}
