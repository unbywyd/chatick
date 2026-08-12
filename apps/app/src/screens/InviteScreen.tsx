import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Building2, CheckCircle2, XCircle } from 'lucide-react'
import { api, getSessionToken, setPendingInvite, type Company } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Logo } from '@/components/Logo'
import { LanguageSelect } from '@/components/LanguageSelect'
import { ThemeToggle } from '@/components/ThemeToggle'

// Приём приглашения по ссылке из письма: /#/invite/:token
// Без этого экрана ссылка вела в никуда (пустая страница).

export function InviteScreen() {
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)

  const accept = useMutation({
    mutationFn: () => api<{ ok: true; company: Company }>(`/api/v1/companies/invites/${token}/accept`, { method: 'POST' }),
    onSuccess: ({ company }) => {
      qc.invalidateQueries({ queryKey: ['companies'] })
      navigate(`/start/${company.id}`, { replace: true })
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  })

  useEffect(() => {
    if (!token || started.current) return
    started.current = true
    // не залогинен — запомним инвайт и вернёмся сюда после входа
    if (!getSessionToken()) {
      setPendingInvite(token)
      navigate('/login', { replace: true })
      return
    }
    accept.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <Logo />
        <div className="flex items-center gap-2">
          <LanguageSelect />
          <ThemeToggle />
        </div>
      </header>

      <main className="grid flex-1 place-items-center px-6">
        <div className="w-full max-w-sm text-center">
          {error ? (
            <>
              <XCircle className="mx-auto size-10 text-destructive" />
              <h1 className="mt-3 text-lg font-semibold">{t('invite.failedTitle')}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" className="mt-4" onClick={() => navigate('/start', { replace: true })}>
                {t('invite.goToApp')}
              </Button>
            </>
          ) : accept.isSuccess ? (
            <>
              <CheckCircle2 className="mx-auto size-10 text-brand-ink" />
              <h1 className="mt-3 text-lg font-semibold">{t('invite.accepted')}</h1>
            </>
          ) : (
            <>
              <Building2 className="mx-auto size-10 animate-pulse text-muted-foreground" />
              <h1 className="mt-3 text-lg font-semibold">{t('invite.joining')}</h1>
            </>
          )}
        </div>
      </main>
    </div>
  )
}
