import { useTranslation } from 'react-i18next'
import { ProjectLogo } from '../ProjectLogo'
import { shortProject } from '../util'
import { hm, type Report } from './timeData'

/**
 * Свод часов по проектам: сколько всего, сколько людей и какая доля от всех
 * часов компании за период. Без проекта — отдельной строкой внизу.
 */
export function ProjectSummary({ report, loading }: { report: Report | undefined; loading: boolean }) {
  const { t } = useTranslation('v2')
  if (loading && !report) return <div className="none">…</div>
  const total = report?.totalMinutes ?? 0
  const rows = [...(report?.projects ?? [])].sort((a, b) => Number(a.id === null) - Number(b.id === null) || b.minutes - a.minutes)
  const peopleIn = (id: string | null) => (report?.people ?? []).filter((p) => p.projects.some((x) => x.id === id && x.minutes > 0)).length
  if (!rows.length) return <div className="none">{t('time.byEmpty')}</div>
  return (
    <div className="psum">
      <div className="psum-r psum-h">
        <span>{t('time.byCol.project')}</span>
        <span>{t('time.byCol.people')}</span>
        <span>{t('time.byCol.share')}</span>
        <span>{t('time.byCol.hours')}</span>
      </div>
      {rows.map((p) => {
        const share = total ? p.minutes / total : 0
        return (
          <div key={p.id ?? 'none'} className="psum-r">
            <span className="psum-p">
              {p.id ? <ProjectLogo project={{ id: p.id, name: p.name, color: p.color, logoUrl: p.logoUrl }} /> : <span className="logo sm" style={{ background: 'var(--soft)' }} />}
              <span className="bidi">{p.id ? shortProject(p.name) : t('time.noProject')}</span>
            </span>
            <span>{peopleIn(p.id)}</span>
            <span className="psum-bar">
              <i style={{ width: `${Math.max(2, Math.round(share * 100))}%` }} />
              <small>{Math.round(share * 100)}%</small>
            </span>
            <b>{hm(p.minutes)}</b>
          </div>
        )
      })}
      <div className="psum-r psum-t">
        <span>{t('time.byTotal')}</span>
        <span />
        <span />
        <b>{hm(total)}</b>
      </div>
    </div>
  )
}
