import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api, setSessionToken } from '@/lib/api'
import { Logo } from '@/components/Logo'

// Вход по одноразовой ссылке из внешней системы (SPEC-INTEGRATION §5).
//
// Человек уже вошёл у заказчика, тот выдал ссылку через свой ключ компании —
// просить его войти второй раз незачем. Страница меняет токен на сессию и
// уводит по назначению.
//
// Одна страница на все такие случаи: переход из их системы, ссылка в письме,
// мобильное приложение. Заводить отдельный обмен под каждый сценарий значило
// бы размножать одну и ту же проверку.

export function EnterScreen() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [failed, setFailed] = useState(false)
  // В StrictMode эффект выполняется дважды, а токен одноразовый: второй вызов
  // получил бы «ссылка уже использована» на живой ссылке.
  const done = useRef(false)

  useEffect(() => {
    if (done.current) return
    done.current = true

    const token = params.get('token')
    if (!token) return setFailed(true)

    void (async () => {
      try {
        const res = await api<{ token: string; to: string | null }>('/api/v1/auth/enter', {
          method: 'POST',
          body: JSON.stringify({ token }),
        })
        setSessionToken(res.token)
        // Токен в адресе больше не нужен: replace, чтобы он не осел в истории
        // браузера — там его прочитает кто угодно, кто откроет вкладки.
        navigate(res.to || '/start', { replace: true })
      } catch {
        setFailed(true)
      }
    })()
  }, [params, navigate])

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <Logo />
      {failed ? (
        <>
          <p className="text-sm text-muted-foreground">{t('enter.failed')}</p>
          <button
            onClick={() => navigate('/login', { replace: true })}
            className="rounded-full border bg-card px-5 py-2 text-sm transition-colors hover:bg-accent"
          >
            {t('enter.toLogin')}
          </button>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t('enter.working')}</p>
      )}
    </div>
  )
}
