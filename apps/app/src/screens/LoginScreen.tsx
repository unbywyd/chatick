import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { API_URL, ApiError, api, consumeReturnTo, consumePendingInvite, getSessionToken, setSessionToken } from '@/lib/api'
import { Logo } from '@/components/Logo'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LanguageSelect } from '@/components/LanguageSelect'
import { desktop } from '@/hooks/useDesktop'
import { Button } from '@/components/ui/button'

/**
 * Вход из десктопа (SPEC §8.33). Google запрещает свой экран согласия внутри
 * встроенного окна, поэтому приложение открывает вход в системном браузере с
 * ?desktop=<код>. Код переживает уход на Google в sessionStorage — вернуться
 * он должен в ту же вкладку, где начинали.
 */
const DESKTOP_CODE_KEY = 'chatick.desktopLogin'
export const takeDesktopCode = () => {
  const code = sessionStorage.getItem(DESKTOP_CODE_KEY)
  sessionStorage.removeItem(DESKTOP_CODE_KEY)
  return code
}

export function LoginScreen() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const desktopCode = params.get('desktop')

  useEffect(() => {
    if (desktopCode) sessionStorage.setItem(DESKTOP_CODE_KEY, desktopCode)
  }, [desktopCode])

  useEffect(() => {
    // Уже вошли в браузере, а приложение просит подтвердить — отдаём токен
    // сразу, второй раз Google спрашивать незачем.
    if (!getSessionToken()) return
    if (desktopCode) navigate(`/auth?desktop=${desktopCode}`, { replace: true })
    // Сессия уже есть, а его всё равно занесло на вход — значит, он шёл по
    // ссылке и его развернули. Возвращаем к ней, а не на общий экран.
    else navigate(consumeReturnTo() ?? '/start', { replace: true })
  }, [navigate, desktopCode])

  // --- вход из десктопа ------------------------------------------------------
  const shell = desktop()
  const [waiting, setWaiting] = useState(false)
  // Номер попытки: по нему устаревший опрос понимает, что он больше не нужен.
  const attemptRef = useRef(0)

  // --- вход по коду на почту (SPEC §8.38) ------------------------------------
  // Второй способ рядом с Google: у корпоративной почты его часто нет, а
  // пароли мы не заводим — их пришлось бы хранить, восстанавливать и однажды
  // потерять. Владение почтой доказывает личность не хуже пароля.
  const [byCode, setByCode] = useState(false)
  const [otpEmail, setOtpEmail] = useState('')
  const [otpCode, setOtpCode] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [otpBusy, setOtpBusy] = useState(false)
  // Незнакомый адрес — это регистрация, а не тупик: сервер отвечает 422
  // «signup_required», и на том же экране появляются имя и согласие.
  const [signup, setSignup] = useState(false)
  const [otpName, setOtpName] = useState('')
  const [otpTerms, setOtpTerms] = useState(false)

  async function requestCode() {
    if (!otpEmail.includes('@')) return toast.error(t('login.otpBadEmail'))
    setOtpBusy(true)
    try {
      await api('/api/v1/auth/otp/request', { method: 'POST', body: JSON.stringify({ email: otpEmail.trim() }) })
      setOtpSent(true)
      toast.success(t('login.otpSent'))
    } catch (e) {
      const tooSoon = e instanceof ApiError && e.status === 429
      toast.error(tooSoon ? t('login.otpTooSoon') : t('login.failed'))
    } finally {
      setOtpBusy(false)
    }
  }

  async function submitCode() {
    // На шаге регистрации оба поля обязательны — проверяем до запроса, чтобы
    // не жечь код зря: верный код сгорает на сервере с первой же проверки.
    if (signup && (!otpName.trim() || !otpTerms)) {
      return toast.error(!otpName.trim() ? t('login.otpNameRequired') : t('login.otpTermsRequired'))
    }
    setOtpBusy(true)
    try {
      const { token } = await api<{ token: string }>('/api/v1/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({
          email: otpEmail.trim(),
          code: otpCode.trim(),
          ...(signup ? { name: otpName.trim(), acceptTerms: otpTerms, locale: i18n.language } : {}),
        }),
      })
      setSessionToken(token)
      // Вход мог начинаться из десктопа — тогда идём туда же, куда увёл бы
      // Google: подтвердить код приложению.
      if (desktopCode) navigate(`/auth?desktop=${desktopCode}`, { replace: true })
      // Вход по коду на почту — самый частый путь как раз для тех, кто пришёл
      // по ссылке с чужого устройства: возвращаем к ней, а не на общий экран.
      else navigate(consumeReturnTo() ?? '/start', { replace: true })
    } catch (e) {
      // 422 — не ошибка ввода, а «такого аккаунта нет, давайте заведём».
      // Код при этом ещё жив: сервер проверяет его ПОСЛЕ полей регистрации,
      // иначе к моменту ввода имени он бы уже сгорел.
      if (e instanceof ApiError && e.status === 422) {
        setSignup(true)
        toast.info(t('login.otpSignupNeeded'))
      } else {
        toast.error(t('login.otpWrong'))
      }
    } finally {
      setOtpBusy(false)
    }
  }

  /**
   * Открываем вход в браузере и ждём. Опрос — единственный способ узнать
   * результат: браузер о нашем существовании не знает.
   */
  async function signInFromDesktop() {
    // Повторное нажатие = начать заново. Прошлая попытка перестаёт слушать:
    // в браузере могла случиться ошибка, и человек вправе попробовать ещё
    // раз, не дожидаясь десяти минут и не перезапуская приложение.
    const attempt = ++attemptRef.current
    setWaiting(true)
    try {
      const { code, url } = await api<{ code: string; url: string }>('/api/v1/auth/desktop', { method: 'POST' })

      // Язык кладём до решётки: маршрутизация у нас хэшевая, и всё после «#»
      // детектор языка не читает. Вкладка в чужом браузере должна говорить
      // на языке приложения.
      const hashAt = url.indexOf('#')
      const base = hashAt === -1 ? url : url.slice(0, hashAt)
      const hash = hashAt === -1 ? '' : url.slice(hashAt)
      const sep = base.includes('?') ? '&' : '?'
      shell?.openExternal(`${base}${sep}lng=${i18n.language}${hash}`)

      const deadline = Date.now() + 10 * 60 * 1000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000))
        // Начали заново или отменили — эта попытка больше не решает.
        if (attemptRef.current !== attempt) return
        const r = await api<{ status: string; token?: string }>(`/api/v1/auth/desktop/poll?code=${code}`)
        if (r.status === 'approved' && r.token) {
          setSessionToken(r.token)
          navigate('/start', { replace: true })
          return
        }
        if (r.status === 'expired') break
      }
      if (attemptRef.current === attempt) toast.error(t('login.desktopExpired'))
    } catch {
      if (attemptRef.current === attempt) toast.error(t('login.failed'))
    } finally {
      if (attemptRef.current === attempt) setWaiting(false)
    }
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between px-6 py-4">
        <Logo />
        <div className="flex items-center gap-2">
          <LanguageSelect />
          <ThemeToggle />
        </div>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight">{t('login.title')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('login.subtitle')}</p>
        </div>
        {/* !byCode: выбор человека важнее того, где он сидит. Без этого
            десктопная ветка перехватывала всё, и вход по коду в приложении был
            недостижим — кнопка нажималась, а форма не появлялась. */}
        {shell && !byCode ? (
          <div className="flex flex-col items-center gap-3">
            {/* Кнопка не блокируется: нажать повторно — законный способ
                начать заново, если в браузере что-то пошло не так. Ждать
                десять минут или перезапускать приложение человек не должен. */}
            <button
              onClick={signInFromDesktop}
              className="flex items-center gap-3 rounded-full border bg-card px-6 py-3 text-sm font-medium transition-colors hover:bg-accent"
            >
              <GoogleIcon />
              {waiting ? t('login.googleRetry') : t('login.google')}
            </button>
            {waiting && (
              <div className="flex flex-col items-center gap-1">
                <p className="text-sm text-muted-foreground">{t('login.desktopWaiting')}</p>
                <button
                  onClick={() => {
                    // Опрос прекращается сам, увидев чужой номер попытки.
                    attemptRef.current++
                    setWaiting(false)
                  }}
                  className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {t('common.cancel')}
                </button>
              </div>
            )}
            {/* Вход по коду и в приложении.
                В десктопной ветке его не было вовсе — только Google. А ведь
                заводили его именно потому, что Google есть не у всех: Microsoft
                отклонила сборку с единственным входом через чужой сервис.
                Починка до приложения не доехала, и там осталась ровно та
                картина, из-за которой отказ и случился. */}
            <button
              onClick={() => setByCode(true)}
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {t('login.byCode')}
            </button>
          </div>
        ) : byCode ? (
          // Форма кода: сначала почта, после отправки — поле для шести цифр.
          <div className="flex w-full max-w-xs flex-col gap-3">
            <input
              type="email"
              autoFocus
              value={otpEmail}
              onChange={(e) => setOtpEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !otpSent && void requestCode()}
              placeholder={t('login.otpEmail')}
              disabled={otpSent}
              className="w-full rounded-full border bg-card px-5 py-3 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
            />

            {otpSent ? (
              <>
                <input
                  autoFocus
                  inputMode="numeric"
                  maxLength={6}
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => e.key === 'Enter' && otpCode.length === 6 && void submitCode()}
                  placeholder={t('login.otpCode')}
                  className="w-full rounded-full border bg-card px-5 py-3 text-center text-lg tracking-[0.4em] outline-none focus:ring-2 focus:ring-ring"
                />

                {/* Такого аккаунта нет — заводим его здесь же. Отдельный экран
                    регистрации означал бы, что человек вводит код дважды: он
                    сгорает с первой проверкой. */}
                {signup && (
                  <div className="flex flex-col gap-3 rounded-2xl border bg-card/60 p-3">
                    <p className="text-xs text-muted-foreground">{t('login.otpSignupHint')}</p>
                    <input
                      autoFocus
                      value={otpName}
                      onChange={(e) => setOtpName(e.target.value)}
                      placeholder={t('login.otpName')}
                      maxLength={120}
                      className="w-full rounded-full border bg-card px-5 py-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                    />
                    <label className="flex cursor-pointer items-start gap-2.5 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={otpTerms}
                        onChange={(e) => setOtpTerms(e.target.checked)}
                        className="mt-0.5 size-4 accent-brand"
                      />
                      <span>
                        <Trans
                          i18nKey="login.otpTerms"
                          components={{
                            terms: <a href="https://chatick.com/terms/" target="_blank" rel="noopener" className="underline underline-offset-2 hover:text-foreground" />,
                            privacy: <a href="https://chatick.com/privacy/" target="_blank" rel="noopener" className="underline underline-offset-2 hover:text-foreground" />,
                          }}
                        />
                      </span>
                    </label>
                  </div>
                )}

                <Button variant="brand" disabled={otpCode.length !== 6 || otpBusy} onClick={() => void submitCode()}>
                  {signup ? t('login.otpCreate') : t('login.otpEnter')}
                </Button>
                <button
                  onClick={() => {
                    setOtpSent(false)
                    setOtpCode('')
                    setSignup(false)
                  }}
                  className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {t('login.otpAnotherEmail')}
                </button>
              </>
            ) : (
              <>
                <Button variant="brand" disabled={otpBusy} onClick={() => void requestCode()}>
                  {t('login.otpSend')}
                </Button>
                {/* Что произойдёт дальше — до нажатия. Раньше человек с
                    незнакомым адресом упирался в молчание и решал, что кнопка
                    сломана; на этом и забраковали сертификацию. */}
                <p className="text-center text-xs text-muted-foreground">{t('login.otpNewHint')}</p>
              </>
            )}

            <button
              onClick={() => {
                setByCode(false)
                setOtpSent(false)
                setOtpCode('')
                setSignup(false)
              }}
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {t('login.backToGoogle')}
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4">
            <a
              // код десктопа едет через OAuth state: он вернётся с колбэка даже
              // если браузер откроет его в новой вкладке
              href={`${API_URL}/api/v1/auth/google${desktopCode ? `?desktop=${encodeURIComponent(desktopCode)}` : ''}`}
              className="flex items-center gap-3 rounded-full border bg-card px-6 py-3 text-sm font-medium transition-colors hover:bg-accent"
            >
              <GoogleIcon />
              {t('login.google')}
            </a>
            {/* Мелким: основной путь — Google, код нужен тем, у кого его нет */}
            <button
              onClick={() => setByCode(true)}
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {t('login.byCode')}
            </button>
          </div>
        )}
      </main>
    </div>
  )
}

// Приём токена из OAuth-редиректа: /#/auth?token=... | ?error=...
export function AuthCallback() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [handedOff, setHandedOff] = useState(false)

  useEffect(() => {
    const token = params.get('token')
    const error = params.get('error')
    if (!token && !getSessionToken()) {
      toast.error(t('login.failed') + (error ? ` (${error})` : ''))
      navigate('/login', { replace: true })
      return
    }
    if (token) setSessionToken(token)

    // Вход начинали из десктопа — отдаём подтверждение и оставляем вкладку
    // с понятным «можно закрывать», вместо того чтобы молча открыть рабочее
    // пространство во втором месте.
    const code = params.get('desktop') ?? takeDesktopCode()
    if (code) {
      api('/api/v1/auth/desktop/claim', { method: 'POST', body: JSON.stringify({ code }) })
        .then(() => setHandedOff(true))
        .catch(() => {
          // код протух или уже использован — обычный вход не ломаем
          toast.error(t('login.desktopExpired'))
          navigate('/start', { replace: true })
        })
      return
    }

    // Возвращаем туда, откуда пришли.
    //
    // Приглашение впереди адреса: его надо принять, иначе доступа к проекту,
    // ради которого человек и шёл, у него ещё нет.
    const invite = consumePendingInvite()
    if (invite) {
      navigate(`/invite/${invite}`, { replace: true })
      return
    }
    // Ссылка на задачу или файл, открытая без сессии: после входа человек
    // должен оказаться на ней, а не на общем списке проектов, откуда её ещё
    // надо найти.
    navigate(consumeReturnTo() ?? '/start', { replace: true })
  }, [params, navigate, t])

  if (!handedOff) return null
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      <Logo />
      <h1 className="mt-4 text-xl font-semibold">{t('login.desktopDone')}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{t('login.desktopDoneHint')}</p>
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.16-3.16A11 11 0 0 0 2.18 7.06L5.84 9.9c.87-2.6 3.3-4.52 6.16-4.52Z" />
    </svg>
  )
}
