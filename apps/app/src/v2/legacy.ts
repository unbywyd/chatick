/**
 * Старые адреса первой версии → адреса v2.
 *
 * Ссылки старого вида живут годами: в письмах, закладках, мессенджерах,
 * внешних системах, нативном меню десктопа. Экраны первой версии убраны, и
 * без перевода такая ссылка вела бы в «страницу не найдено».
 *
 * Модуль без зависимостей нарочно: тот же перевод есть на сервере
 * (apps/api/src/lib/links.ts, v2Path), и тест сервера сверяет обе копии на
 * одних примерах — разойтись им незаметно не дадут.
 */

/** Адрес v2 по «хвосту» адреса проекта первой версии. Копия серверной v2Path. */
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
 * Полный старый адрес → адрес v2. null — адрес не из первой версии.
 * `lastCompany` — для адресов без компании (/inbox, /settings/…).
 */
export function legacyTarget(pathname: string, search: string, lastCompany: string | null): string | null {
  const proj = /^\/c\/([^/]+)\/p\/([^/]+)(\/.*)?$/.exec(pathname)
  if (proj) return v2Path(proj[1]!, proj[2]!, (proj[3] ?? '') + search)

  const start = /^\/start\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname)
  if (start) {
    const tab = start[2]
    const rest = tab === 'team' ? '/company' : tab === 'settings' ? '/settings/company' : tab === 'time' ? '/time' : ''
    return `/c/${start[1]}${rest}`
  }

  const where = (rest: string) => (lastCompany ? `/c/${lastCompany}${rest}` : '/start')
  if (pathname === '/inbox') return where('/notifications')
  if (pathname === '/settings/notifications') return where('/settings/notifications')
  if (pathname === '/settings/profile') return where('/settings/profile')
  if (pathname === '/onboarding') return '/start'
  return null
}
