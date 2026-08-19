import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companyMembers, projectMembers, projects } from '../db/schema.js'

/**
 * Должность и зона ответственности: компания задаёт, проект переопределяет.
 *
 * Должность человека не меняется от проекта к проекту — он бэкендер и там, и
 * тут. Заводить её в каждом проекте заново значит получить десять мест, где
 * она разойдётся, и девять, где её забудут.
 *
 * Наследование, а не копия при добавлении в проект (как у notify-config):
 * меняя должность у компании, ждут, что она изменится везде, а не только в
 * проектах, заведённых после. Проект, которому нужно иначе — «здесь он ведёт
 * ещё и релизы», — пишет своё и с этого момента живёт сам.
 *
 * Пустая строка означает «не задано» и в проекте, и в компании: проверка
 * одинакова с обеих сторон, и «не задано» нельзя перепутать с «задано пусто».
 */

export type Profile = { jobTitle: string; responsibility: string }

/** Пустое поле проекта берёт значение компании; заполненное — сильнее. */
export function mergeProfile(project: Partial<Profile> | null, company: Partial<Profile> | null): Profile {
  return {
    jobTitle: project?.jobTitle?.trim() || company?.jobTitle?.trim() || '',
    responsibility: project?.responsibility?.trim() || company?.responsibility?.trim() || '',
  }
}

/**
 * Разрешённые профили участников проекта: id пользователя → должность.
 *
 * Одним запросом на всех, а не по человеку: команда проекта рисуется списком,
 * и запрос на строку превратил бы её открытие в десяток походов в базу.
 */
export async function profilesForProject(projectId: string): Promise<Map<string, Profile>> {
  const members = await db
    .select({
      userId: projectMembers.userId,
      jobTitle: projectMembers.jobTitle,
      responsibility: projectMembers.responsibility,
    })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId))

  const out = new Map<string, Profile>()
  if (!members.length) return out

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    columns: { companyId: true },
  })
  if (!project) {
    // Проекта нет — наследовать не от кого, отдаём как есть.
    for (const m of members) out.set(m.userId, mergeProfile(m, null))
    return out
  }

  const company = await db
    .select({
      userId: companyMembers.userId,
      jobTitle: companyMembers.jobTitle,
      responsibility: companyMembers.responsibility,
    })
    .from(companyMembers)
    .where(
      and(
        eq(companyMembers.companyId, project.companyId),
        inArray(
          companyMembers.userId,
          members.map((m) => m.userId),
        ),
      ),
    )
  const byUser = new Map(company.map((c) => [c.userId, c]))

  for (const m of members) out.set(m.userId, mergeProfile(m, byUser.get(m.userId) ?? null))
  return out
}

/** Разрешённый профиль одного человека в проекте. */
export async function profileInProject(projectId: string, userId: string): Promise<Profile> {
  const [pm] = await db
    .select({ jobTitle: projectMembers.jobTitle, responsibility: projectMembers.responsibility })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    columns: { companyId: true },
  })
  if (!project) return mergeProfile(pm ?? null, null)

  const [cm] = await db
    .select({ jobTitle: companyMembers.jobTitle, responsibility: companyMembers.responsibility })
    .from(companyMembers)
    .where(and(eq(companyMembers.companyId, project.companyId), eq(companyMembers.userId, userId)))

  return mergeProfile(pm ?? null, cm ?? null)
}
