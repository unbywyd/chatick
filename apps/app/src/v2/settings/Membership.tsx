import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { keys, useProjects, type CompanyProject } from '../data'
import { useUi } from '../ui'
import { ProjectLogo } from '../ProjectLogo'
import { shortProject } from '../util'
import { Confirm, useFail } from './parts'
import '../i18n/project'

/**
 * Где я состою: выйти из проекта или покинуть компанию самому. Сервер не
 * отпустит единственного админа компании и создателя проекта — его ответ
 * показываем как есть.
 */
export function Membership() {
  const { t } = useTranslation('v2')
  const { company, companyId, flash } = useUi()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const fail = useFail()
  const projects = useProjects(companyId)
  const mine = (projects.data ?? []).filter((p) => p.myRole)
  const [ask, setAsk] = useState<{ kind: 'company' } | { kind: 'project'; p: CompanyProject } | null>(null)
  const leaveProject = useMutation({
    mutationFn: (p: CompanyProject) => api(`/api/v1/projects/${p.id}/leave`, { method: 'POST' }),
    onSuccess: (_d, p) => {
      setAsk(null)
      flash(t('mship.leftProject', { name: shortProject(p.name) }))
      void qc.invalidateQueries({ queryKey: keys.projects(companyId) })
    },
    onError: fail,
  })
  const leaveCompany = useMutation({
    mutationFn: () => api(`/api/v1/companies/${companyId}/leave`, { method: 'POST' }),
    onSuccess: () => {
      localStorage.removeItem('chatick_v2_company')
      void qc.invalidateQueries({ queryKey: keys.companies })
      navigate('/start', { replace: true })
    },
    onError: fail,
  })
  return (
    <section className="card sec">
      <h2>{t('mship.title')}</h2>
      <p className="d">{t('mship.sub')}</p>
      {mine.map((p) => (
        <div className="row" key={p.id}>
          <span className="l mship-p">
            <ProjectLogo project={p} />
            <span className="bidi">{shortProject(p.name)}</span>
          </span>
          {ask?.kind === 'project' && ask.p.id === p.id ? (
            <Confirm text={t('mship.leaveProjectAsk', { name: shortProject(p.name) })} yes={t('mship.leave')} busy={leaveProject.isPending} onYes={() => leaveProject.mutate(p)} onNo={() => setAsk(null)} />
          ) : (
            <button className="btn sm" style={{ justifySelf: 'start' }} onClick={() => setAsk({ kind: 'project', p })}>
              {t('mship.leave')}
            </button>
          )}
        </div>
      ))}
      <div className="row">
        <span className="l">
          {t('mship.company', { name: company.name })}
          <small>{t('mship.companyHint')}</small>
        </span>
        {ask?.kind === 'company' ? (
          <Confirm text={t('mship.leaveCompanyAsk', { name: company.name })} yes={t('mship.leaveCompany')} busy={leaveCompany.isPending} onYes={() => leaveCompany.mutate()} onNo={() => setAsk(null)} />
        ) : (
          <button className="btn sm red" style={{ justifySelf: 'start' }} onClick={() => setAsk({ kind: 'company' })}>
            {t('mship.leaveCompany')}
          </button>
        )}
      </div>
    </section>
  )
}
