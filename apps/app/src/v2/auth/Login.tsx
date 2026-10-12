import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import { API_URL, ApiError, api, getSessionToken, setSessionToken } from '@/lib/api'
import { desktop } from '@/hooks/useDesktop'
import { takeDesktopCode } from '@/screens/LoginScreen'
import { AuthLayout, GoogleIcon } from './Frame'
import { AUTH, otpEmail, setNext, takeNext } from './paths'

/**
 * Вход из десктопа (SPEC §8.33): Google не пускает свой экран согласия во
 * встроенное окно, поэтому приложение открывает вход в браузере с
 * ?desktop=<код>. Ключ тот же, что у старого экрана: колбэк у них общий.
 */
const DESKTOP_CODE_KEY = 'chatick.desktopLogin'

/** После входа: десктоп ждёт подтверждения, иначе — туда, куда шли. */
function afterLogin(navigate: ReturnType<typeof useNavigate>, desktopCode: string | null) {
  if (desktopCode) navigate(`${AUTH.callback}?desktop=${encodeURIComponent(desktopCode)}`, { replace: true })
  else navigate(takeNext(), { replace: true })
}

const googleUrl = (desktopCode: string | null) =>
  `${API_URL}/api/v1/auth/google${desktopCode ? `?desktop=${encodeURIComponent(desktopCode)}` : ''}`

export function EmailStep() {
  const { t, i18n } = useTranslation('v2')
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const desktopCode = params.get('desktop') ?? sessionStorage.getItem(DESKTOP_CODE_KEY)
  const [email, setEmail] = useState(otpEmail.get)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [createFirst, setCreateFirst] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const ok = /.+@.+\..+/.test(email.trim())

  useEffect(() => {
    if (params.get('desktop')) sessionStorage.setItem(DESKTOP_CODE_KEY, params.get('desktop')!)
  }, [params])

  // Сессия уже есть — его привела сюда ссылка; возвращаем к ней, а не держим на входе.
  useEffect(() => {
    if (getSessionToken()) afterLogin(navigate, params.get('desktop'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function send() {
    if (!ok || busy) return
    setBusy(true)
    setErr('')
    const value = email.trim()
    try {
      await api('/api/v1/auth/otp/request', { method: 'POST', body: JSON.stringify({ email: value }) })
      otpEmail.set(value)
      navigate(AUTH.code)
    } catch (e) {
      // 429 — письмо ушло меньше минуты назад: код уже у человека, это успех.
      if (e instanceof ApiError && e.status === 429) {
        otpEmail.set(value)
        navigate(AUTH.code, { state: { already: true } })
      } else if (e instanceof ApiError && e.status === 400) setErr(t('auth.email.badEmail'))
      else setErr(t('auth.email.failed'))
    } finally {
      setBusy(false)
    }
  }

  // --- десктоп: вход в системном браузере и опрос ---------------------------
  const shell = desktop()
  const [waiting, setWaiting] = useState(false)
  const attempt = useRef(0)
  async function googleFromDesktop() {
    // Повторное нажатие — начать заново: прежний опрос увидит чужой номер и замолчит.
    const mine = ++attempt.current
    setWaiting(true)
    setErr('')
    try {
      const { code, url } = await api<{ code: string; url: string }>('/api/v1/auth/desktop', { method: 'POST' })
      // Язык — до решётки: всё после «#» детектор языка не читает.
      const at = url.indexOf('#')
      const base = at === -1 ? url : url.slice(0, at)
      const hash = at === -1 ? '' : url.slice(at)
      shell?.openExternal(`${base}${base.includes('?') ? '&' : '?'}lng=${i18n.language}${hash}`)
      const deadline = Date.now() + 10 * 60_000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000))
        if (attempt.current !== mine) return
        const r = await api<{ status: string; token?: string }>(`/api/v1/auth/desktop/poll?code=${code}`)
        if (r.status === 'approved' && r.token) {
          setSessionToken(r.token)
          navigate(takeNext(), { replace: true })
          return
        }
        if (r.status === 'expired') break
      }
      if (attempt.current === mine) setErr(t('auth.email.desktopExpired'))
    } catch {
      if (attempt.current === mine) setErr(t('auth.email.failed'))
    } finally {
      if (attempt.current === mine) setWaiting(false)
    }
  }

  return (
    <AuthLayout>
      <h1>{t('auth.email.title')}</h1>
      <p className="l">{t('auth.email.lead')}</p>
      <label className="lab" htmlFor="au-email">
        {t('auth.email.label')}
      </label>
      <label className="fld">
        <input
          id="au-email"
          ref={input}
          type="email"
          autoComplete="email"
          dir="ltr"
          autoFocus
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            setErr('')
          }}
          onKeyDown={(e) => e.key === 'Enter' && void send()}
          placeholder={t('auth.email.ph')}
        />
      </label>
      <div style={{ height: 12 }} />
      {err && <div className="err" style={{ marginTop: 0 }}>{err}</div>}
      {createFirst && <div className="note">{t('auth.email.createFirst')}</div>}
      <button className={'btn pr' + (ok && !busy ? '' : ' dis')} disabled={!ok || busy} onClick={() => void send()}>
        {t('auth.email.send')}
      </button>
      <div className="or">{t('auth.email.or')}</div>
      {shell ? (
        <>
          <button className="btn gh" onClick={() => void googleFromDesktop()}>
            <GoogleIcon />
            {waiting ? t('auth.email.googleRetry') : t('auth.email.google')}
          </button>
          {waiting && (
            <p className="sm" style={{ marginTop: 10 }}>
              {t('auth.email.googleWait')}{' '}
              <button
                onClick={() => {
                  attempt.current++
                  setWaiting(false)
                }}
              >
                {t('auth.email.cancel')}
              </button>
            </p>
          )}
        </>
      ) : (
        <a className="btn gh" href={googleUrl(desktopCode)}>
          <GoogleIcon />
          {t('auth.email.google')}
        </a>
      )}
      <p className="sm">
        {t('auth.email.noCompany')}{' '}
        <button
          onClick={() => {
            // Компанию заводят под своей учётной записью — сначала вход, потом сразу форма.
            setNext(AUTH.newco)
            setCreateFirst(true)
            input.current?.focus()
          }}
        >
          {t('auth.email.create')}
        </button>{' '}
        · {t('auth.email.inviteHint')}
      </p>
      <p className="sm" style={{ marginTop: 6 }}>
        {t('auth.email.newHint')}
      </p>
      {/* Вход разработчика: только dev-сборка и копия базы — сервер сам подтверждает. */}
      {import.meta.env.DEV && <DevLogin />}
    </AuthLayout>
  )
}

export function CodeStep() {
  const { t, i18n } = useTranslation('v2')
  const navigate = useNavigate()
  const location = useLocation()
  const email = otpEmail.get()
  const [code, setCode] = useState('')
  const [bad, setBad] = useState<'' | 'bad' | 'many'>('')
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState(Boolean((location.state as { already?: boolean } | null)?.already))
  // Незнакомый адрес — регистрация на том же шаге: код сгорает с первой
  // проверкой, отдельный экран заставил бы вводить его дважды.
  const [signup, setSignup] = useState(false)
  const [name, setName] = useState('')
  const [terms, setTerms] = useState(false)
  const [formErr, setFormErr] = useState('')
  const [wait, setWait] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!email) navigate(AUTH.login, { replace: true })
    // Поле спрятано под клетками — фокус ставим сами, autoFocus на нём ненадёжен.
    else input.current?.focus()
  }, [email, navigate])

  useEffect(() => {
    if (wait <= 0) return
    const id = window.setTimeout(() => setWait((w) => w - 1), 1000)
    return () => window.clearTimeout(id)
  }, [wait])

  async function verify(value = code) {
    if (value.length !== 6 || busy) return
    if (signup && (!name.trim() || !terms)) {
      setFormErr(!name.trim() ? t('auth.code.nameRequired') : t('auth.code.termsRequired'))
      return
    }
    setBusy(true)
    setBad('')
    setFormErr('')
    try {
      const { token } = await api<{ token: string }>('/api/v1/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({ email, code: value, ...(signup ? { name: name.trim(), acceptTerms: terms, locale: i18n.language } : {}) }),
      })
      setSessionToken(token)
      afterLogin(navigate, takeDesktopCode())
    } catch (e) {
      // 422 — не ошибка: аккаунта нет, код ещё жив (сервер проверяет его после полей).
      if (e instanceof ApiError && e.status === 422) setSignup(true)
      else if (e instanceof ApiError && e.status === 429) setBad('many')
      else setBad('bad')
    } finally {
      setBusy(false)
    }
  }

  async function resend() {
    if (wait > 0) return
    try {
      await api('/api/v1/auth/otp/request', { method: 'POST', body: JSON.stringify({ email }) })
      setWait(59)
      setBad('')
      setCode('')
      input.current?.focus()
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        const sec = Number((e.body as { retryInSec?: number } | undefined)?.retryInSec) || 59
        setWait(sec)
      }
    }
  }

  const ready = code.length === 6 && !busy && (!signup || (name.trim() && terms))
  return (
    <AuthLayout>
      <h1>{t('auth.code.title')}</h1>
      <p className="l">
        <Trans t={t} i18nKey="auth.code.lead" values={{ email }} components={{ b: <b dir="ltr" /> }} />
      </p>
      {info && <div className="note">{t('auth.code.already')}</div>}
      <label className="lab" htmlFor="au-code">
        {t('auth.code.label')}
      </label>
      <label style={{ display: 'block', cursor: 'text', position: 'relative' }}>
        <input
          id="au-code"
          ref={input}
          className="hidden"
          value={code}
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 6)
            setCode(v)
            setBad('')
            setInfo(false)
            // Шестая цифра — сразу проверяем: ещё одна кнопка между человеком и входом лишняя.
            if (v.length === 6 && !signup) void verify(v)
          }}
          onKeyDown={(e) => e.key === 'Enter' && void verify()}
        />
        <div className="code" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} className={bad ? 'bad' : i === code.length ? 'cur' : ''}>
              {code.charAt(i)}
            </span>
          ))}
        </div>
      </label>
      {bad && <div className="err">{bad === 'many' ? t('auth.code.tooMany') : t('auth.code.bad')}</div>}
      {signup && (
        <div className="signup">
          <div className="note" style={{ margin: 0 }}>
            {t('auth.code.signup')}
          </div>
          <label className="fld">
            <input
              value={name}
              autoFocus
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('auth.code.name')}
              aria-label={t('auth.code.name')}
              className="bidi"
            />
          </label>
          <label className="terms">
            <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
            <span>
              <Trans
                t={t}
                i18nKey="auth.code.terms"
                components={{
                  terms: <a href="https://chatick.com/terms/" target="_blank" rel="noopener" />,
                  privacy: <a href="https://chatick.com/privacy/" target="_blank" rel="noopener" />,
                }}
              />
            </span>
          </label>
          {formErr && <div className="err" style={{ margin: 0 }}>{formErr}</div>}
        </div>
      )}
      <button className={'btn pr' + (ready ? '' : ' dis')} disabled={!ready} onClick={() => void verify()}>
        {signup ? t('auth.code.create') : t('auth.code.enter')}
      </button>
      <p className="sm">
        {t('auth.code.none')}{' '}
        <button onClick={() => void resend()} disabled={wait > 0}>
          {wait > 0 ? t('auth.code.resent', { t: `0:${String(wait).padStart(2, '0')}` }) : t('auth.code.resend')}
        </button>{' '}
        · <button onClick={() => navigate(AUTH.login)}>{t('auth.code.other')}</button>
      </p>
    </AuthLayout>
  )
}

/**
 * Вход разработчика без кода — только dev-сборка и только когда сервер сам
 * подтвердил, что вход открыт (копия базы, localhost, флаг DEV_LOGIN).
 * Текст без перевода намеренно: людям этот блок не показывают.
 */
function DevLogin() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    api('/api/v1/auth/dev-login')
      .then(() => setOpen(true))
      .catch(() => setOpen(false))
  }, [])
  if (!open) return null
  async function enter() {
    setBusy(true)
    setError('')
    try {
      const { token } = await api<{ token: string }>('/api/v1/auth/dev-login', { method: 'POST', body: JSON.stringify({ email: email.trim() }) })
      setSessionToken(token)
      navigate(takeNext(), { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="dev"
      onSubmit={(e) => {
        e.preventDefault()
        void enter()
      }}
    >
      <b>Dev login · database copy</b>
      <div>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email of an existing user" dir="ltr" aria-label="Dev login email" />
        <button type="submit" disabled={busy || !email.trim()}>
          Sign in as
        </button>
      </div>
      {error && <span className="err">{error}</span>}
    </form>
  )
}

/** Приём токена из OAuth-редиректа Google: /auth?token=… | ?error=… */
export function AuthCallbackV2() {
  const { t } = useTranslation('v2')
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [handedOff, setHandedOff] = useState(false)
  const [failed, setFailed] = useState('')

  useEffect(() => {
    const token = params.get('token')
    if (!token && !getSessionToken()) {
      setFailed(params.get('error') ?? 'no_token')
      return
    }
    if (token) setSessionToken(token)
    // Вход начинали из десктопа — подтверждаем ему и оставляем вкладку с
    // «можно закрывать», а не открываем рабочее место во втором окне.
    const code = params.get('desktop') ?? takeDesktopCode()
    if (code) {
      api('/api/v1/auth/desktop/claim', { method: 'POST', body: JSON.stringify({ code }) })
        .then(() => setHandedOff(true))
        .catch(() => navigate('/start', { replace: true }))
      return
    }
    navigate(takeNext(), { replace: true })
  }, [params, navigate])

  if (failed)
    return (
      <AuthLayout>
        <h1>{t('auth.email.failed')}</h1>
        <p className="l" dir="ltr">
          {failed}
        </p>
        <button className="btn pr" onClick={() => navigate(AUTH.login, { replace: true })}>
          {t('auth.email.title')}
        </button>
      </AuthLayout>
    )
  if (!handedOff) return null
  return (
    <AuthLayout>
      <div className="done">
        <div className="big">
          <svg className="ic" viewBox="0 0 24 24">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </div>
        <h1>{t('auth.email.desktopDone')}</h1>
        <p className="l">{t('auth.email.desktopDoneHint')}</p>
      </div>
    </AuthLayout>
  )
}
