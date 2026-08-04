import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { projects } from '../db/schema.js'

// Ссылки на проект (SPEC §8.45).
//
// Адрес проекта включает компанию: /c/<companyId>/p/<projectId>. Без неё
// интерфейс не знал, какая компания открыта, пока проект не загрузится, и
// подставлял первую из списка — человек видел в шапке чужую компанию, а при
// недоступном проекте ещё и «проекта больше нет».
//
// Собирается здесь, а не по месту: ссылки строятся в письмах, уведомлениях,
// напоминаниях и внешнем API, и формат, размазанный по десятку файлов, при
// следующем изменении разойдётся.

/** Компания проекта. null, если проекта нет. */
export async function companyOf(projectId: string): Promise<string | null> {
  const p = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    columns: { companyId: true },
  })
  return p?.companyId ?? null
}

/**
 * Путь внутри приложения: `/c/<company>/p/<project>/<tail>`.
 *
 * Компанию принимаем параметром, а не ищем сами: у вызывающего она почти
 * всегда уже под рукой, а лишний запрос в цикле уведомлений заметен.
 */
export function projectPath(companyId: string, projectId: string, tail = ''): string {
  const suffix = tail ? (tail.startsWith('/') || tail.startsWith('?') ? tail : `/${tail}`) : ''
  return `/c/${companyId}/p/${projectId}${suffix}`
}

/** То же, но полным адресом — для писем и внешнего API. */
export function projectUrl(appUrl: string, companyId: string, projectId: string, tail = ''): string {
  return `${appUrl.replace(/\/$/, '')}/#${projectPath(companyId, projectId, tail)}`
}
