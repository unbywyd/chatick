import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useUi } from './ui'
import './i18n/settings'
import type { Notice } from './data'

/** Куда ведёт уведомление: задача — в панель, остальное — на свою страницу v2. */
type Target = { task: string } | { path: string } | { mobile: true }

/**
 * Раньше по клику открывалась только задача: упоминание в заметке,
 * напоминание, таймер, объявление молча помечались прочитанными, и человек
 * не понимал, что ему показали. Ссылку (`link`) сервер пишет в формате
 * первой версии — она запасной путь, когда тип не говорит, куда идти.
 */
export function noticeTarget(n: Notice): Target | null {
  const id = n.entityId
  const p = n.projectId
  const inProject = (path: string) => ({ path: p ? `${path}?p=${encodeURIComponent(p)}` : path })
  // Чат живёт только в мобильном приложении — в вебе его нет.
  if (n.event === 'chat_mention' || n.entityType === 'message') return { mobile: true }
  switch (n.entityType) {
    case 'task':
      if (id) return { task: id }
      break
    case 'note':
      if (id) return { path: `/notes/n/${id}` }
      break
    case 'document':
      if (id && p) return { path: `/docs/d/${p}/${id}` }
      return { path: '/docs' }
    case 'time':
      return { path: '/time' }
    case 'file':
      return inProject('/files')
    case 'resource':
      return inProject('/resources')
    case 'release':
      return inProject('/versions')
    case 'announcement':
      return { path: '/notifications' }
  }
  if (n.event === 'timer_running') return { path: '/time' }
  const link = n.link ?? ''
  const task = /\/tasks\/([^/?#]+)/.exec(link)?.[1] ?? /[?&]task=([^&#]+)/.exec(link)?.[1]
  if (task) return { task }
  const note = /\/notes\/([^/?#]+)/.exec(link)?.[1] ?? /[?&]note=([^&#]+)/.exec(link)?.[1]
  if (note) return { path: `/notes/n/${note}` }
  if (/\/time\b/.test(link)) return { path: '/time' }
  // «Мячи освобождены», проектные события без сущности — список задач проекта.
  if (p) return { path: `?p=${encodeURIComponent(p)}` }
  return null
}

/** Открыть уведомление. false — открывать нечего (уведомление только для чтения). */
export function useOpenNotice() {
  const { t } = useTranslation('v2')
  const { base, openTask, flash } = useUi()
  const navigate = useNavigate()
  return (n: Notice): boolean => {
    const to = noticeTarget(n)
    if (!to) return false
    if ('task' in to) openTask(to.task)
    else if ('mobile' in to) flash(t('notices.inMobile'))
    else navigate(`${base}${to.path}`)
    return true
  }
}
