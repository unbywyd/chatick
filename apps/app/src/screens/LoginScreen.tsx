import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { API_URL, consumePendingInvite, getSessionToken, setSessionToken } from '@/lib/api'
import { Logo } from '@/components/Logo'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LanguageSelect } from '@/components/LanguageSelect'

export function LoginScreen() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  useEffect(() => {
    if (getSessionToken()) navigate('/start', { replace: true })
  }, [navigate])

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
        <a
          href={`${API_URL}/api/v1/auth/google`}
          className="flex items-center gap-3 rounded-full border bg-card px-6 py-3 text-sm font-medium transition-colors hover:bg-accent"
        >
          <GoogleIcon />
          {t('login.google')}
        </a>
      </main>
    </div>
  )
}

// Приём токена из OAuth-редиректа: /#/auth?token=... | ?error=...
export function AuthCallback() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { t } = useTranslation()

  useEffect(() => {
    const token = params.get('token')
    const error = params.get('error')
    if (token) {
      setSessionToken(token)
      // пришёл по ссылке-приглашению и был отправлен на вход — возвращаем его туда
      const invite = consumePendingInvite()
      navigate(invite ? `/invite/${invite}` : '/start', { replace: true })
    } else {
      toast.error(t('login.failed') + (error ? ` (${error})` : ''))
      navigate('/login', { replace: true })
    }
  }, [params, navigate, t])

  return null
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
