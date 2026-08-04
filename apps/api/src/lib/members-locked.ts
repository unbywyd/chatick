import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companies, projects } from '../db/schema.js'

// Состав команды приходит только из внешней системы (SPEC §8.42).
//
// У компании со своей системой люди заводятся, переводятся и увольняются там,
// и она — источник правды. Если тех же людей можно добавлять и удалять ещё и
// у нас, два списка неизбежно разъезжаются: уволенный остаётся в проекте и
// продолжает читать переписку, потому что его убрали «не в той системе».
//
// Поэтому запрет именно на запись: видеть команду можно всем, кому и раньше,
// а менять — только через API компании. Не косметика в интерфейсе: кнопки
// прячутся, но ручки остаются, а к ним ходят и мост ИИ, и curl.

/** Ответ ручке, у которой правка состава запрещена настройкой компании. */
export const MEMBERS_LOCKED = {
  error: 'Team is managed by your external system. Add or remove people there.',
} as const

/** Правка состава запрещена в этой компании? */
export async function membersLockedForCompany(companyId: string): Promise<boolean> {
  const c = await db.query.companies.findFirst({
    where: eq(companies.id, companyId),
    columns: { membersViaApiOnly: true },
  })
  return !!c?.membersViaApiOnly
}

/**
 * То же по проекту. Настройка живёт на компании: держать её на каждом проекте
 * значило бы, что где-то её забыли включить — и там состав снова разъедется.
 */
export async function membersLockedForProject(projectId: string): Promise<boolean> {
  const p = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    columns: { companyId: true },
  })
  if (!p?.companyId) return false
  return membersLockedForCompany(p.companyId)
}
