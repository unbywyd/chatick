import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, setSessionToken } from '@/lib/api'

/**
 * Вход разработчика без кода — только в dev-сборке и только когда сервер
 * сам подтвердил, что вход открыт (копия базы, localhost, флаг DEV_LOGIN).
 *
 * В production-сборке компонента нет: экран входа подключает его под
 * import.meta.env.DEV, и Vite выбрасывает эту ветку целиком. Текст без
 * перевода намеренно: это инструмент разработчика, людям его не показывают.
 */
export function DevLogin() {
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
      const { token } = await api<{ token: string }>('/api/v1/auth/dev-login', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim() }),
      })
      setSessionToken(token)
      navigate('/start', { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void enter()
      }}
      className="flex w-full max-w-sm flex-col gap-2 rounded-xl border border-dashed border-amber-500/60 p-3 text-xs"
    >
      <span className="font-medium text-amber-600">Dev login · database copy</span>
      <div className="flex gap-2">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email of an existing user"
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1"
        />
        <button type="submit" disabled={busy || !email.trim()} className="rounded-md border px-3 py-1 hover:bg-accent disabled:opacity-50">
          Sign in as
        </button>
      </div>
      {error && <span className="text-destructive">{error}</span>}
    </form>
  )
}
