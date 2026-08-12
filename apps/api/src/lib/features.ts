import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { projectFeatures } from '../db/schema.js'

/**
 * Дополнительные возможности проекта, включаемые вручную.
 *
 * Не каждому проекту нужны версии: в проекте без релизов лишняя вкладка —
 * шум. Поэтому по умолчанию выключено, включает владелец или админ.
 *
 * Проверять надо ВЕЗДЕ, где к функции есть доступ, — не только в интерфейсе.
 * Спрятанная вкладка не защищает ручку: мост и прямой запрос обходят её, не
 * заметив.
 */

export type ProjectFeature = 'releases'

export async function isFeatureEnabled(projectId: string, feature: ProjectFeature): Promise<boolean> {
  const row = await db.query.projectFeatures.findFirst({
    where: and(eq(projectFeatures.projectId, projectId), eq(projectFeatures.feature, feature)),
  })
  return Boolean(row)
}

/** Список включённого — интерфейсу, чтобы решить, какие вкладки показывать. */
export async function enabledFeatures(projectId: string): Promise<ProjectFeature[]> {
  const rows = await db.query.projectFeatures.findMany({ where: eq(projectFeatures.projectId, projectId) })
  return rows.map((r) => r.feature as ProjectFeature)
}

export async function setFeature(
  projectId: string,
  feature: ProjectFeature,
  enabled: boolean,
  userId: string,
): Promise<void> {
  if (enabled) {
    // Повторное включение — не ошибка: интерфейс может прислать то же
    // состояние, и падать на этом незачем.
    await db.insert(projectFeatures).values({ projectId, feature, enabledById: userId }).onConflictDoNothing()
    return
  }
  // Выключение НЕ удаляет данные: версии остаются в базе, просто перестают
  // показываться. Иначе случайный клик по тумблеру стирал бы историю релизов.
  await db
    .delete(projectFeatures)
    .where(and(eq(projectFeatures.projectId, projectId), eq(projectFeatures.feature, feature)))
}
