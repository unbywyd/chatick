import { useEffect, useRef } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { API_URL, ApiError, api, getSessionToken, logout, setPendingInvite } from '@/lib/api'
import { keys, type CompanyRole } from '../data'
import { letterOf, personColor } from '../util'
import { ProjectLogo } from '../ProjectLogo'
import { AuthLayout, GoogleIcon, useMeIf } from './Frame'
import { AUTH, otpEmail } from './paths'

type InvitePreview = {
  email: string
  role: CompanyRole
  company: { id: string; name: string; logoUrl: string | null; people: number; projects: number }
  inviter: { id: string; name: string } | null
  project: { id: string; name: string; color: string | null; logoUrl: string | null } | null
}

/**
 * Приглашение по ссылке из письма.
 *
 * До входа показываем, куда и кто зовёт (GET /auth/invite/:token — без
 * сессии, по секретному токену). После входа — принимаем и ведём прямо в
 * компанию, а если звали в проект — сразу с ним в фильтре.
 */
export function InviteV2() {
  const { t } = useTranslation('v2')
  const { token = '' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const signedIn = Boolean(getSessionToken())
  const me = useMeIf(signedIn)
  const started = useRef(false)

  const preview = useQuery({
    queryKey: ['v2', 'auth', 'invite', token],
    queryFn: () => api<InvitePreview>(`/api/v1/auth/invite/${encodeURIComponent(token)}`),
    retry: false,
  })
  const inv = preview.data

  const accept = useMutation({
    mutationFn: () => api<{ ok: true; company: { id: string } }>(`/api/v1/companies/invites/${encodeURIComponent(token)}/accept`, { method: 'POST' }),
    onSuccess: ({ company }) => {
      void qc.invalidateQueries({ queryKey: keys.companies })
      void qc.invalidateQueries({ queryKey: ['companies'] })
      localStorage.setItem('chatick_v2_company', company.id)
      navigate(`/c/${company.id}${inv?.project ? `?p=${encodeURIComponent(inv.project.id)}` : ''}`, { replace: true })
    },
  })

  const myEmail = me.data?.email?.toLowerCase() ?? ''
  const sameEmail = Boolean(inv && myEmail && inv.email.toLowerCase() === myEmail)

  // Вернулись сюда сразу после входа (?go=1) — принимаем сами: человек уже
  // нажал «Принять» до входа, второй раз спрашивать незачем.
  useEffect(() => {
    if (started.current || !signedIn || params.get('go') !== '1' || !sameEmail) return
    started.current = true
    accept.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, sameEmail, params])

  /** Принять, ещё не войдя: запоминаем приглашение и уходим на вход. */
  const viaGoogle = () => {
    setPendingInvite(token)
    window.location.href = `${API_URL}/api/v1/auth/google`
  }
  const viaEmail = async () => {
    setPendingInvite(token)
    if (!inv) return navigate(AUTH.login)
    otpEmail.set(inv.email)
    try {
      await api('/api/v1/auth/otp/request', { method: 'POST', body: JSON.stringify({ email: inv.email }) })
      navigate(AUTH.code)
    } catch (e) {
      // 429: код уже в почте — тот же успех.
      if (e instanceof ApiError && e.status === 429) navigate(AUTH.code, { state: { already: true } })
      else navigate(AUTH.login)
    }
  }
  const otherEmail = () => {
    logout()
    setPendingInvite(token)
    navigate(AUTH.login)
  }

  if (preview.isLoading)
    return (
      <AuthLayout>
        <div className="wait">{t('common.loading')}</div>
      </AuthLayout>
    )

  if (!inv)
    return (
      <AuthLayout>
        <h1>{t('auth.invite.notFound')}</h1>
        <p className="l">{t('auth.invite.notFoundLead')}</p>
        <button className="btn pr" onClick={() => navigate(signedIn ? AUTH.companies : AUTH.login)}>
          {t('auth.invite.toApp')}
        </button>
      </AuthLayout>
    )

  const role = t(`auth.roles.${inv.role}`)
  const acceptErr = accept.error instanceof ApiError && accept.error.status === 403 ? 'email' : accept.error ? 'other' : ''
  return (
    <AuthLayout>
      <h1 className="bidi">{t('auth.invite.title', { company: inv.company.name })}</h1>
      <p className="l">{inv.project ? t('auth.invite.leadProject') : t('auth.invite.lead')}</p>
      <div className="inv">
        <div className="inv-h">
          <span className="co" style={{ background: personColor(inv.company.id) }}>
            {inv.company.logoUrl ? <img src={inv.company.logoUrl} alt="" /> : letterOf(inv.company.name)}
          </span>
          <div>
            <b className="bidi">{inv.company.name}</b>
            <small>
              {t('auth.invite.people', { count: inv.company.people })} · {t('auth.invite.projects', { count: inv.company.projects })}
            </small>
          </div>
        </div>
        <div className="inv-r">
          {inv.inviter ? (
            <>
              <span className="av" style={{ background: personColor(inv.inviter.id) }}>
                {letterOf(inv.inviter.name)}
              </span>
              <span>
                <Trans t={t} i18nKey="auth.invite.by" values={{ name: inv.inviter.name, role }} components={{ b: <b className="bidi" /> }} />
              </span>
            </>
          ) : (
            <span>{t('auth.invite.role', { role })}</span>
          )}
        </div>
        <div className="inv-r">
          {inv.project ? (
            <>
              <ProjectLogo project={inv.project} />
              <span>
                <Trans t={t} i18nKey="auth.invite.toProject" values={{ project: inv.project.name, email: inv.email }} components={{ b: <b /> }} />
              </span>
            </>
          ) : (
            <span>
              <Trans t={t} i18nKey="auth.invite.forEmail" values={{ email: inv.email }} components={{ b: <b /> }} />
            </span>
          )}
        </div>
      </div>

      {!signedIn ? (
        <>
          <button className="btn gh" onClick={viaGoogle} style={{ marginBottom: 10 }}>
            <GoogleIcon />
            {t('auth.invite.google')}
          </button>
          <button className="btn pr" onClick={() => void viaEmail()}>
            {t('auth.invite.email')}
          </button>
        </>
      ) : !me.data ? (
        <div className="wait">{t('common.loading')}</div>
      ) : sameEmail && acceptErr !== 'email' ? (
        <>
          <p className="note">
            <Trans t={t} i18nKey="auth.invite.signedAs" values={{ email: me.data.email }} components={{ b: <b /> }} />
          </p>
          {acceptErr && <div className="err">{t('auth.invite.failed')}</div>}
          <button className={'btn pr' + (accept.isPending ? ' dis' : '')} disabled={accept.isPending} onClick={() => accept.mutate()}>
            {accept.isPending ? t('auth.invite.joining') : t('auth.invite.accept')}
          </button>
        </>
      ) : (
        <>
          <p className="note">
            <Trans t={t} i18nKey="auth.invite.wrongEmail" values={{ email: inv.email, me: me.data.email }} components={{ b: <b /> }} />
          </p>
          <button className="btn pr" onClick={otherEmail}>
            {t('auth.invite.other')}
          </button>
        </>
      )}
      <p className="sm">{t('auth.invite.note')}</p>
    </AuthLayout>
  )
}
