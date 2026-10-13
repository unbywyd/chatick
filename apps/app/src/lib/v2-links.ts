/**
 * Старые адреса → адреса v2.
 *
 * В v2 всё живёт на экране компании: /c/<компания>, проект — только фильтр
 * (?p=), открытая задача — панель поверх списка (?t=). А ссылки, которые
 * приходят в приложение, по-прежнему старые: сервер пишет в уведомления
 * /c/<компания>/p/<проект>/tasks/<id>, трей и системные уведомления
 * пересылают их как есть, а меню трея в установленной оболочке зашито на
 * /settings/notifications и /start. Оболочку обновляет магазин, не мы, —
 * значит переводить надо здесь, в вебе, на входе.
 *
 * Чистые функции без React и без запросов: их проверяет
 * тест сервера (apps/api/src/lib/links-v2.test.ts), и по нему видно все случаи разом.
 */

export type LinkContext = {
  /**
   * Компания для адресов, где её нет вовсе (/inbox, /settings/…, /start):
   * та, что открыта в окне, или компания уведомления.
   */
  companyId?: string | null
  /** Компания проекта — для совсем старых /p/<id>, где компании в адресе нет. */
  companyOf?: (projectId: string) => string | null | undefined
}

import { v2Path } from '../v2/legacy'

const withQuery = (path: string, params: Record<string, string | null | undefined>): string => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v)
  const s = q.toString()
  return s ? `${path}?${s}` : path
}

/**
 * Раздел старого проекта → то же место в v2.
 *
 * Правило одно с сервером и переадресацией старых адресов (v2/legacy.ts,
 * v2Path). Отличие одно: задачу внутри приложения открываем панелью поверх
 * списка, как это делает сам v2, а не отдельной страницей.
 */
function fromProject(companyId: string, projectId: string, rest: string[], query: URLSearchParams): string {
  const base = `/c/${companyId}`
  const [section, id] = rest
  switch (section) {
    case 'tasks': {
      // Проект в фильтр не ставим — человек вернётся туда, где был.
      const task = id ?? query.get('task')
      return task ? withQuery(base, { t: task }) : withQuery(base, { p: projectId })
    }
    default: {
      const q = query.toString()
      return v2Path(companyId, projectId, `/${rest.join('/')}${q ? `?${q}` : ''}`)
    }
  }
}

/**
 * Перевести ссылку в адрес v2.
 *
 * Не узнали — возвращаем как есть: неизвестный адрес покажет «страница не
 * найдена», а не уведёт молча в чужое место.
 */
export function toV2Link(raw: string, ctx: LinkContext = {}): string {
  let link = String(raw ?? '').trim()
  // Полный адрес из письма: https://app.chatick.com/#/c/… — нам нужен хвост.
  const hash = link.indexOf('#/')
  if (hash >= 0) link = link.slice(hash + 1)
  if (!link.startsWith('/')) return link

  const qi = link.indexOf('?')
  const path = (qi >= 0 ? link.slice(0, qi) : link).replace(/\/+$/, '') || '/'
  const query = new URLSearchParams(qi >= 0 ? link.slice(qi + 1) : '')
  const seg = path.split('/').filter(Boolean)

  // /c/<компания>/p/<проект>/… — так сервер пишет ссылки и сейчас.
  if (seg[0] === 'c' && seg[1] && seg[2] === 'p' && seg[3]) return fromProject(seg[1], seg[3], seg.slice(4), query)

  // /p/<проект>/… — до того, как компания попала в адрес.
  if (seg[0] === 'p' && seg[1]) {
    const co = ctx.companyOf?.(seg[1])
    return co ? fromProject(co, seg[1], seg.slice(2), query) : link
  }

  // Уже v2 (или что-то своё под компанией) — не трогаем.
  if (seg[0] === 'c') return link

  const co = ctx.companyId
  if (!co) return link
  const base = `/c/${co}`
  if (path === '/inbox') return `${base}/notifications`
  if (path === '/settings/notifications') return `${base}/settings/notifications`
  if (path === '/settings/profile') return `${base}/settings/profile`
  if (path === '/start') return base
  // Хвосты без проекта: /tasks?task=<id>, /tasks/<id>, /notes?note=<id>.
  if (seg[0] === 'tasks') {
    const task = seg[1] ?? query.get('task')
    return task ? withQuery(base, { t: task }) : base
  }
  if (seg[0] === 'notes') {
    const note = seg[1] ?? query.get('note')
    return note ? `${base}/notes/n/${note}` : `${base}/notes`
  }
  return link
}

/**
 * Где сейчас окно: компания, проект и открытая задача.
 *
 * В v2 проект — фильтр ?p= на любом экране компании, задача — панель ?t=
 * или отдельная страница /task/<id>. Старые адреса (/c/…/p/<id>/…) ещё
 * живут, пока на них не повесили переадресацию, — их понимаем тоже.
 */
export function activeFromLocation(pathname: string, search: string): { companyId: string | null; projectId: string | null; taskId: string | null } {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const companyId = pathname.match(/^\/c\/([^/?#]+)/)?.[1] ?? null
  const v1 = pathname.match(/^\/c\/[^/]+\/p\/([^/]+)(?:\/tasks\/([^/]+))?/)
  const legacy = pathname.match(/^\/p\/([^/]+)/)
  const page = pathname.match(/^\/c\/[^/]+\/task\/([^/]+)/)?.[1]
  // Документ, файл, ресурс, версия: проект — прямо в адресе (/docs/d/<проект>/<id>).
  const item = pathname.match(/^\/c\/[^/]+\/(?:docs\/d|files\/f|resources\/r|versions\/v)\/([^/]+)/)?.[1]
  const projectId = v1?.[1] ?? legacy?.[1] ?? item ?? q.get('p') ?? null
  const taskId = q.get('t') ?? (page && page !== 'new' ? page : null) ?? v1?.[2] ?? null
  return { companyId, projectId, taskId }
}
