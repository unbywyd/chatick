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
// Запрет узкий и намеренно узкий: он про СОСТАВ — кто входит в компанию и
// проекты. Добавить, убрать, пригласить нельзя.
//
// Роли и права под запрет НЕ попадают. Внешняя система решает, кто у неё
// работает, но кем человек будет у нас — админом проекта или участником, с
// каким доступом к ресурсам — она не знает и знать не может: этих понятий в
// ней нет. Запрети мы и это, админ компании не смог бы назначить руководителя
// проекта, и настройка стала бы невыносимой.
//
// Не косметика в интерфейсе: кнопки прячутся, но ручки остаются, а к ним
// ходят и мост ИИ, и curl.

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
