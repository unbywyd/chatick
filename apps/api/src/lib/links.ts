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
 * Адрес в веб-клиенте v2 по «хвосту» адреса проекта первой версии.
 *
 * Вызывающие по-прежнему говорят на языке вкладок проекта («/tasks/<id>»,
 * «/notes?note=<id>», «/releases/<id>») — так сформулированы уведомления,
 * письма, мост и внешний API. Здесь хвост переводится в экран v2: задача —
 * своя страница, файл, ресурс, версия и документ — адрес с проектом, остальное
 * — список задач проекта (?p=). Чата в вебе v2 нет: он в мобильном приложении.
 *
 * Тот же перевод — в клиенте (apps/app/src/v2/legacy.ts): им открываются
 * старые ссылки из уже отправленных писем. Тест сверяет обе копии.
 */
export function v2Path(companyId: string, projectId: string, tail = ''): string {
  const c = `/c/${companyId}`
  const p = encodeURIComponent(projectId)
  const t = tail && !tail.startsWith('/') && !tail.startsWith('?') ? `/${tail}` : tail
  const [path = '', query = ''] = t.split('?')
  const qs = new URLSearchParams(query)
  const [tab = '', id] = path.split('/').filter(Boolean)
  const task = qs.get('task')
  if (task && (tab === 'tasks' || !tab)) return `${c}/task/${task}`
  switch (tab) {
    case 'tasks':
      return id ? `${c}/task/${id}` : `${c}?p=${p}`
    case 'notes': {
      const n = id ?? qs.get('note')
      return n ? `${c}/notes/n/${n}` : `${c}/notes?p=${p}`
    }
    case 'documents':
    case 'docs':
      return id ? `${c}/docs/d/${projectId}/${id}` : `${c}/docs?p=${p}`
    case 'files':
      return id ? `${c}/files/f/${projectId}/${id}` : `${c}/files?p=${p}`
    case 'resources':
      return id ? `${c}/resources/r/${projectId}/${id}` : `${c}/resources?p=${p}`
    case 'releases':
      return id ? `${c}/versions/v/${projectId}/${id}` : `${c}/versions?p=${p}`
    case 'time':
      return `${c}/time`
    case 'history':
      return `${c}/history?p=${p}`
    case 'team':
      return `${c}/company`
    case 'notifications':
      // Вкладка проекта «Уведомления» была настройкой — в v2 настройка одна.
      return `${c}/settings/notifications`
    default:
      // '', chat, ai, worklog, shortcuts — экранов нет, ведём к задачам проекта
      return `${c}?p=${p}`
  }
}

/**
 * Путь внутри приложения для сущности или вкладки проекта — уже в адресах v2.
 *
 * Компанию принимаем параметром, а не ищем сами: у вызывающего она почти
 * всегда уже под рукой, а лишний запрос в цикле уведомлений заметен.
 */
export function projectPath(companyId: string, projectId: string, tail = ''): string {
  return v2Path(companyId, projectId, tail)
}

/** То же, но полным адресом — для писем и внешнего API. */
export function projectUrl(appUrl: string, companyId: string, projectId: string, tail = ''): string {
  return `${appUrl.replace(/\/$/, '')}/#${projectPath(companyId, projectId, tail)}`
}
