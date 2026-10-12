import { useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ApiError, api, getSessionToken, logout, type ProjectListItem } from '@/lib/api'
import { ConnectScreen } from '@/screens/ConnectScreen'
import { useCompanies } from '../data'
import { letterOf, personColor, shortProject } from '../util'
import { ProjectLogo } from '../ProjectLogo'
import { AuthLayout, useMeIf } from './Frame'
import { AUTH, setNext } from './paths'

type Pick = { kind: 'company'; id: string } | { kind: 'project' } | { kind: 'all' }
type Proj = { id: string; name: string; color: string | null; logoUrl: string | null; companyId: string }

/**
 * Согласие для Claude (MCP по адресу, OAuth): Claude прислал человека сюда с
 * ?oauth=<id>, после «Разрешить» сервер даёт адрес возврата в Claude.
 *
 * Сервер выдаёт доступ ОБЛАСТЬЮ — один проект, одна компания или всё
 * (routes/oauth.ts → approve), а права внутри неё — права самого человека.
 * Поэтому галочек «что разрешено» из макета здесь нет: сервер их не знает,
 * и экран обещал бы то, чего нет. Выбор проектов — один, не несколько: так
 * устроена область на сервере.
 *
 * Без ?oauth= это старый экран подключения по коду — его отдаём как есть.
 */
export function ConsentV2() {
  const [params] = useSearchParams()
  const oauthId = params.get('oauth') ?? ''
  const signedIn = Boolean(getSessionToken())
  useEffect(() => {
    if (oauthId && !signedIn) setNext(AUTH.consent(oauthId))
  }, [oauthId, signedIn])
  if (!oauthId) return <ConnectScreen />
  if (!signedIn) return <Navigate to={AUTH.login} replace />
  return <Consent oauthId={oauthId} />
}

function Consent({ oauthId }: { oauthId: string }) {
  const { t } = useTranslation('v2')
  const navigate = useNavigate()
  const me = useMeIf(true)
  const companies = useCompanies()
  const list = companies.data ?? []

  const request = useQuery({
    queryKey: ['v2', 'auth', 'oauth', oauthId],
    queryFn: () => api<{ client: { name: string } }>(`/api/v1/auth/oauth/${encodeURIComponent(oauthId)}`),
    retry: false,
  })
  const client = request.data?.client.name ?? 'Claude'

  // Проекты всех компаний человека: сервер вернёт только те, что он видит.
  const ids = list.map((c) => c.id)
  const projects = useQuery({
    queryKey: ['v2', 'auth', 'consent-projects', ids.join(',')],
    enabled: ids.length > 0,
    queryFn: async () => {
      const lists = await Promise.all(
        ids.map((id) =>
          api<ProjectListItem[] | { projects?: ProjectListItem[] }>(`/api/v1/projects?companyId=${encodeURIComponent(id)}`)
            .then((r) => (Array.isArray(r) ? r : (r.projects ?? [])))
            .then((r) => r.filter((p) => !p.archived).map<Proj>((p) => ({ id: p.id, name: p.name, color: p.color ?? null, logoUrl: p.logoUrl ?? null, companyId: id })))
            .catch(() => [] as Proj[]),
        ),
      )
      return lists.flat()
    },
  })

  const [pick, setPick] = useState<Pick | null>(null)
  const [project, setProject] = useState<Proj | null>(null)
  const [q, setQ] = useState('')
  const [pop, setPop] = useState(false)
  const [result, setResult] = useState<'allowed' | 'denied' | null>(null)

  // По умолчанию — компания, открытая последней: обычно ради неё и подключают.
  const last = localStorage.getItem('chatick_v2_company')
  const defaultCompany = list.find((c) => c.id === last) ?? list[0]
  const cur: Pick | null = pick ?? (defaultCompany ? { kind: 'company', id: defaultCompany.id } : null)

  const sugg = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (projects.data ?? []).filter((p) => p.id !== project?.id && (!s || p.name.toLowerCase().includes(s))).slice(0, 8)
  }, [projects.data, q, project])
  const companyName = (id: string) => list.find((c) => c.id === id)?.name ?? ''

  const body = () =>
    cur?.kind === 'all' ? { all: true } : cur?.kind === 'company' ? { companyId: cur.id } : { projectId: project?.id }
  const allow = useMutation({
    mutationFn: () => api<{ redirect: string }>(`/api/v1/auth/oauth/${encodeURIComponent(oauthId)}/approve`, { method: 'POST', body: JSON.stringify(body()) }),
    onSuccess: (r) => {
      setResult('allowed')
      // Обратно в Claude: он ждёт код на своём адресе.
      window.location.href = r.redirect
    },
  })
  const deny = useMutation({
    mutationFn: () => api<{ redirect: string }>(`/api/v1/auth/oauth/${encodeURIComponent(oauthId)}/deny`, { method: 'POST' }),
    onSuccess: (r) => {
      setResult('denied')
      window.location.href = r.redirect
    },
  })

  const add = (p: Proj) => {
    setProject(p)
    setQ('')
    setPop(false)
  }

  if (request.isLoading)
    return (
      <AuthLayout>
        <div className="wait">{t('common.loading')}</div>
      </AuthLayout>
    )

  if (request.isError || (allow.error instanceof ApiError && allow.error.status === 404))
    return (
      <AuthLayout>
        <h1>{t('auth.consent.expired')}</h1>
        <p className="l">{t('auth.consent.expiredLead')}</p>
        <button className="btn gh" onClick={() => navigate('/start')}>
          {t('auth.invite.toApp')}
        </button>
      </AuthLayout>
    )

  if (result)
    return (
      <AuthLayout>
        <div className="done">
          <div className={'big' + (result === 'denied' ? ' no' : '')}>
            <svg className="ic" viewBox="0 0 24 24">
              <path d={result === 'allowed' ? 'M5 12.5l4.5 4.5L19 7.5' : 'M6 6l12 12M18 6L6 18'} />
            </svg>
          </div>
          <h1>{result === 'allowed' ? t('auth.consent.done', { client }) : t('auth.consent.denied')}</h1>
          <p className="l">{result === 'allowed' ? t('auth.consent.doneLead') : t('auth.consent.deniedLead')}</p>
          {result === 'allowed' && defaultCompany && (
            <a className="btn gh" href={`#/c/${defaultCompany.id}/settings/ai`}>
              {t('auth.consent.connections')}
            </a>
          )}
        </div>
      </AuthLayout>
    )

  const options: { key: string; on: boolean; name: string; note: string; pick: Pick }[] = [
    ...list.map((c) => ({
      key: 'c' + c.id,
      on: cur?.kind === 'company' && cur.id === c.id,
      name: t('auth.consent.company', { name: c.name }),
      note: t('auth.consent.companyNote'),
      pick: { kind: 'company', id: c.id } as Pick,
    })),
    { key: 'p', on: cur?.kind === 'project', name: t('auth.consent.project'), note: t('auth.consent.projectNote'), pick: { kind: 'project' } },
    // «Всё» при одной компании почти не отличается от неё самой — лишний выбор только путает.
    ...(list.length > 1 ? [{ key: 'a', on: cur?.kind === 'all', name: t('auth.consent.all'), note: t('auth.consent.allNote'), pick: { kind: 'all' } as Pick }] : []),
  ]
  const ready = Boolean(cur) && (cur?.kind !== 'project' || project) && !allow.isPending
  const name = me.data?.name ?? ''

  return (
    <AuthLayout>
      <div className="cs-top" aria-hidden="true">
        <span className="cs-app" style={{ background: '#C96442' }}>
          {letterOf(client)}
        </span>
        <span className="dots">
          <i />
          <i />
          <i />
        </span>
        <span className="cs-app" style={{ background: '#1F2B1B', color: '#D4F36B' }}>
          Ch
        </span>
      </div>
      <h1>{t('auth.consent.title', { client })}</h1>
      <p className="l">{t('auth.consent.lead')}</p>
      <div className="acct">
        <span className="av" style={{ background: personColor(me.data?.id) }}>
          {letterOf(name)}
        </span>
        <div>
          <b className="bidi">{name}</b>
          <small dir="ltr">{me.data?.email}</small>
        </div>
        <button
          onClick={() => {
            logout()
            setNext(AUTH.consent(oauthId))
            navigate(AUTH.login)
          }}
        >
          {t('auth.consent.switch')}
        </button>
      </div>
      <span className="lab">{t('auth.consent.access')}</span>
      <div className="acc" role="radiogroup" aria-label={t('auth.consent.access')}>
        {options.map((o) => (
          <button key={o.key} role="radio" aria-checked={o.on} className={o.on ? 'on' : ''} onClick={() => setPick(o.pick)}>
            <span className="rd" />
            <span>
              <b className="bidi">{o.name}</b>
              <small>{o.note}</small>
            </span>
          </button>
        ))}
      </div>
      {cur?.kind === 'project' && (
        <div className="tok">
          <div className="tok-f">
            {project && (
              <span className="tk">
                <ProjectLogo project={project} size="xs" />
                <span className="bidi">{shortProject(project.name)}</span>
                <button onClick={() => setProject(null)} aria-label={t('auth.consent.remove', { name: project.name })}>
                  ×
                </button>
              </span>
            )}
            {!project && (
              <input
                value={q}
                autoFocus
                onChange={(e) => {
                  setQ(e.target.value)
                  setPop(true)
                }}
                onFocus={() => setPop(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && sugg[0]) add(sugg[0])
                  if (e.key === 'Escape') setPop(false)
                }}
                placeholder={t('auth.consent.pick')}
                aria-label={t('auth.consent.pick')}
              />
            )}
          </div>
          {pop && !project && (
            <div className="tok-pop" role="listbox">
              {sugg.map((p, i) => (
                <button key={p.id} role="option" aria-selected={i === 0 && Boolean(q)} className={i === 0 && q ? 'hi' : ''} onClick={() => add(p)}>
                  <ProjectLogo project={p} />
                  <span className="bidi">{shortProject(p.name)}</span>
                  {list.length > 1 && <small className="bidi">{companyName(p.companyId)}</small>}
                </button>
              ))}
              {!sugg.length && <div className="none">{q.trim() ? t('auth.consent.none', { q: q.trim() }) : t('common.loading')}</div>}
            </div>
          )}
        </div>
      )}
      <p className="sm" style={{ marginTop: 14, marginBottom: 18 }}>
        {t('auth.consent.rights')}
      </p>
      {allow.isError && <div className="err">{t('auth.consent.failed')}</div>}
      <div className="row2">
        <button className="btn gh" disabled={deny.isPending} onClick={() => deny.mutate()}>
          {t('auth.consent.cancel')}
        </button>
        <button className={'btn acc' + (ready ? '' : ' dis')} disabled={!ready} onClick={() => allow.mutate()}>
          {t('auth.consent.allow')}
        </button>
      </div>
      <p className="sm">{t('auth.consent.revoke')}</p>
    </AuthLayout>
  )
}
