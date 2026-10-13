import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import type { Company } from './data'
import './i18n/list'

/**
 * Компания переехала на свою инфраструктуру (platform_settings 'companies.moved').
 * Люди остаются у нас: говорим, куда ушла работа, благодарим и зовём
 * попробовать новый подход — уже со своей компанией.
 *
 * С deleteAt данные компании пока лежат здесь витриной — сравнить. Говорим,
 * когда их удалят и что правки отсюда в их систему не попадут.
 */
export function MovedBanner({ company }: { company: Company }) {
  const { t, i18n } = useTranslation('v2')
  if (!company.moved) return null
  const url = company.moved.url
  const host = url ? url.replace(/^https?:\/\//, '').replace(/\/$/, '') : null
  const at = company.moved.deleteAt
  // Дата без времени — полдень, чтобы пояс не сдвинул её на соседний день.
  const date = at
    ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(at) ? `${at}T12:00:00` : at).toLocaleDateString(i18n.language, { day: 'numeric', month: 'long' })
    : null
  return (
    <section className="moved" role="status">
      <div className="moved-in">
        <div className="moved-t">
          <b>{t('moved.title')}</b>
          <span>{t('moved.thanks', { company: company.name })}</span>
          {date && (
            <span className="moved-keep">
              {t('moved.keep', { date })}
              {host && ` ${t('moved.noSync', { host })}`}
            </span>
          )}
          {url && (
            <a className="moved-go" href={url} target="_blank" rel="noopener noreferrer">
              {t('moved.open', { host })} ↗
            </a>
          )}
        </div>
        <div className="moved-try">
          <span>{t('moved.tryText')}</span>
          <Link className="btn" to="/new-company">
            {t('moved.try')}
          </Link>
        </div>
      </div>
    </section>
  )
}
