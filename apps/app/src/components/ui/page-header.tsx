import type { ReactNode } from 'react'
import { useNavigate, useLocation, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Заголовок страницы проекта со стрелкой «назад».
 *
 * Страницы вне полосы вкладок — горячие клавиши, ИИ, уведомления, команда —
 * открываются из меню профиля. Ни одна вкладка при этом не подсвечена, и уйти
 * с них было нечем: единственная стрелка жила в панели вкладок, вела всегда в
 * чат и на широком экране пряталась вовсе.
 *
 * Стрелка здесь же, в одном ряду с заголовком — как на странице профиля.
 */
export function PageHeader({
  icon,
  title,
  subtitle,
  trailing,
}: {
  icon?: ReactNode
  title: string
  subtitle?: string
  /** Кнопки справа от заголовка. */
  trailing?: ReactNode
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { companyId, id } = useParams()
  /**
   * Настоящая история, если она есть: человек пришёл откуда-то внутри
   * приложения и вернуться хочет именно туда.
   *
   * Если истории нет — прямая ссылка, новая вкладка, обновлённая страница, —
   * navigate(-1) вышвырнул бы из приложения на предыдущий сайт. React Router
   * помечает первую запись ключом 'default': по нему одно и отличаем.
   */
  const { key: locationKey } = useLocation()
  const back = () =>
    locationKey === 'default' && companyId && id ? navigate(`/c/${companyId}/p/${id}/tasks`) : navigate(-1)

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="ghost" size="icon" className="shrink-0" onClick={back} title={t('connect.back')}>
          <ArrowLeft className="size-4 rtl:-scale-x-100" />
        </Button>
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            {icon}
            {title}
          </h1>
          {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      {trailing}
    </div>
  )
}
