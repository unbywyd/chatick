import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ApiError, api, getSessionToken } from '@/lib/api'
import { keys, useCompanies } from '../data'
import { AuthLayout } from './Frame'
import { AUTH, setNext } from './paths'

/**
 * Новая компания. Создатель — её админ; людей и проекты заводят уже внутри,
 * в управлении компанией. Своя компания у человека одна (сервер отвечает 409),
 * участвовать можно в скольких угодно.
 *
 * Из макета убраны «адрес chatick.com/…» и «размер команды»: ни того, ни
 * другого сервер не хранит.
 */
export function NewCompanyV2() {
  const signedIn = Boolean(getSessionToken())
  useEffect(() => {
    if (!signedIn) setNext(AUTH.newco)
  }, [signedIn])
  if (!signedIn) return <Navigate to={AUTH.login} replace />
  return <Form />
}

function Form() {
  const { t } = useTranslation('v2')
  const navigate = useNavigate()
  const qc = useQueryClient()
  const companies = useCompanies()
  const [name, setName] = useState('')

  const create = useMutation({
    mutationFn: () => api<{ id: string }>('/api/v1/companies', { method: 'POST', body: JSON.stringify({ name: name.trim() }) }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: keys.companies })
      void qc.invalidateQueries({ queryKey: ['companies'] })
      localStorage.setItem('chatick_v2_company', c.id)
      // Пустая компания — первые шаги: проект с языком и приглашения списком.
      navigate(`/c/${c.id}/welcome`, { replace: true })
    },
  })
  // Своя уже есть — говорим сразу, а не после нажатия: сервер всё равно ответит 409.
  const owned = companies.data?.find((c) => c.isOwner)
  const own = owned
    ? owned.name
    : create.error instanceof ApiError && create.error.status === 409
      ? ((create.error.body as { company?: string } | undefined)?.company ?? '')
      : null
  const ok = name.trim().length > 0 && !create.isPending

  return (
    <AuthLayout>
      <h1>{t('auth.newco.title')}</h1>
      <p className="l">{t('auth.newco.lead')}</p>
      {!owned && (
        <>
          <label className="lab" htmlFor="au-co">
            {t('auth.newco.label')}
          </label>
          <label className="fld">
            <input
              id="au-co"
              className="bidi"
              autoFocus
              maxLength={120}
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                create.reset()
              }}
              onKeyDown={(e) => e.key === 'Enter' && ok && create.mutate()}
              placeholder={t('auth.newco.ph')}
            />
          </label>
        </>
      )}
      <div style={{ height: 22 }} />
      {own !== null ? (
        <>
          <div className="note">{t('auth.newco.own', { name: own })}</div>
          <button className="btn pr" onClick={() => navigate(AUTH.companies)}>
            {t('auth.newco.open')}
          </button>
        </>
      ) : (
        <>
          {create.isError && <div className="err">{t('auth.newco.failed')}</div>}
          <button className={'btn pr' + (ok ? '' : ' dis')} disabled={!ok} onClick={() => create.mutate()}>
            {t('auth.newco.create')}
          </button>
        </>
      )}
      {!owned && (companies.data?.length ?? 0) > 0 && (
        <p className="sm">
          <button onClick={() => navigate(AUTH.companies)}>{t('auth.newco.back')}</button>
        </p>
      )}
    </AuthLayout>
  )
}
