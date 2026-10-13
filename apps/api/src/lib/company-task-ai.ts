import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { projects } from '../db/schema.js'

/**
 * «ИИ при создании задачи» — настройка компании.
 *
 * Флаги improveTasks и generateTaskNotes исторически лежат в aiConfig каждого
 * проекта, и создание задачи читает их оттуда. В v2 ИИ настраивается только
 * на уровне компании, поэтому компания здесь — это все её проекты сразу:
 * включили — включилось во всех, новый проект перенимает то же самое.
 * Отдельной колонки у компании нет нарочно: две копии одной настройки
 * разъехались бы при первой правке через старый экран или MCP.
 */
export type TaskAi = { improveTasks: boolean; generateTaskNotes: boolean }

const parse = (raw: string | null) => {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Включено у компании, если включено хотя бы в одном живом проекте. */
export async function companyTaskAi(companyId: string): Promise<TaskAi> {
  const rows = await db
    .select({ aiConfig: projects.aiConfig })
    .from(projects)
    .where(and(eq(projects.companyId, companyId), isNull(projects.archivedAt)))
  const out: TaskAi = { improveTasks: false, generateTaskNotes: false }
  for (const r of rows) {
    const c = parse(r.aiConfig)
    if (c.improveTasks) out.improveTasks = true
    if (c.generateTaskNotes) out.generateTaskNotes = true
  }
  return out
}

/** Поставить флаги во всех проектах компании, архивные тоже — вернутся из архива с тем же. */
export async function setCompanyTaskAi(companyId: string, patch: Partial<TaskAi>): Promise<TaskAi> {
  const rows = await db.select({ id: projects.id, aiConfig: projects.aiConfig }).from(projects).where(eq(projects.companyId, companyId))
  for (const r of rows) {
    await db
      .update(projects)
      .set({ aiConfig: JSON.stringify({ ...parse(r.aiConfig), ...patch }) })
      .where(eq(projects.id, r.id))
  }
  return companyTaskAi(companyId)
}
