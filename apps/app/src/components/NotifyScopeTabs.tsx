import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { cn } from '@/lib/utils'

/**
 * Переключатель «мои настройки ↔ настройки проекта».
 *
 * Обе страницы называются «Уведомления», и попав на любую из них, человек не
 * понимал, что перед ним: из меню он проваливался в проект и решал, что
 * настраивает себя. Пути между ними тоже не было — только назад через меню.
 *
 * Табы отвечают на оба вопроса сразу: где я сейчас (выделенная вкладка) и как
 * попасть в другое место (соседняя). Ссылки, а не кнопки: это разные адреса,
 * и их открывают в новой вкладке, копируют и присылают друг другу.
 */
const KEY = 'chatick:lastProjectNotifyPath'

/**
 * Адрес последней открытой страницы уведомлений проекта.
 *
 * Личные настройки живут вне проекта и сами по себе не знают, откуда пришли.
 * Без этого вкладка «этот проект» пропадала бы, стоило перейти в свои
 * настройки, — и обратно человек уже не возвращался.
 *
 * sessionStorage, а не localStorage: ссылка на проект, закрытый неделю назад,
 * ведёт в никуда и путает больше, чем помогает.
 */
export function rememberProjectNotifyPath(path: string) {
  try {
    sessionStorage.setItem(KEY, path)
  } catch {
    // Приватный режим и запрет хранилища: вкладки просто не будет.
  }
}

export function lastProjectNotifyPath(): string | undefined {
  try {
    return sessionStorage.getItem(KEY) ?? undefined
  } catch {
    return undefined
  }
}

export function NotifyScopeTabs({
  active,
  projectPath,
  remember,
}: {
  active: 'mine' | 'project'
  /** Адрес страницы уведомлений проекта; без него вкладка проекта не рисуется. */
  projectPath?: string
  /** Запомнить этот адрес, чтобы из личных настроек было куда вернуться. */
  remember?: string
}) {
  const { t } = useTranslation()

  useEffect(() => {
    if (remember) rememberProjectNotifyPath(remember)
  }, [remember])

  const tab = (key: 'mine' | 'project', to: string) => (
    <Link
      key={key}
      to={to}
      className={cn(
        '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
        active === key
          ? 'border-brand font-medium text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {t(`notif.scope.${key}`)}
    </Link>
  )

  return (
    <nav className="flex flex-wrap gap-1 border-b">
      {tab('mine', '/settings/notifications')}
      {/* Вкладки проекта нет, когда мы не в проекте: вести некуда, а серая
          неактивная вкладка обещала бы страницу, которой сейчас не существует. */}
      {projectPath && tab('project', projectPath)}
    </nav>
  )
}
