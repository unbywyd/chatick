import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { ArrowLeft, Camera, User } from 'lucide-react'
import { api, API_URL, getSessionToken } from '@/lib/api'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'

/**
 * Свой профиль — имя и фото.
 *
 * Раньше правилось только из выпадающего меню в шапке: поле имени соседствовало
 * с выходом из аккаунта, и промахнуться было легко. Плюс у меню нет адреса —
 * значит некуда вести из трея, где аватар видно постоянно.
 *
 * Почта показана, но не правится: она — способ войти, и менять её надо с
 * подтверждением на оба адреса. Отдельная работа, и делать её вполсилы нельзя.
 */
type Me = { id: string; name: string; email: string; avatarUrl: string | null }

export function ProfileScreen() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)

  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/v1/auth/me') })
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)

  // Поле заполняем, когда профиль приехал, — и только тогда: иначе набранное
  // затирается при каждом фоновом обновлении.
  useEffect(() => {
    if (me.data && !name) setName(me.data.name)
  }, [me.data, name])

  const refreshMe = () => qc.invalidateQueries({ queryKey: ['me'] })

  const saveName = async () => {
    const next = name.trim()
    if (!next || next === me.data?.name) return
    setBusy(true)
    try {
      await api('/api/v1/auth/me', { method: 'PATCH', body: JSON.stringify({ name: next }) })
      toast.success(t('profile.saved'))
      refreshMe()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const upload = async (file: File) => {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      // Сессионный токен, а не проектный: профиль — не проектная сущность, и на
      // этом экране проект вообще не выбран.
      const res = await fetch(`${API_URL}/api/v1/auth/me/avatar`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getSessionToken()}` },
        body: fd,
      })
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText)
      toast.success(t('profile.photoUpdated'))
      refreshMe()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  const dirty = Boolean(me.data && name.trim() && name.trim() !== me.data.name)

  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} title={t('connect.back')}>
          <ArrowLeft className="size-4 rtl:-scale-x-100" />
        </Button>
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <User className="size-5" />
          {t('profile.title')}
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{t('profile.subtitle')}</p>

      <section className="mt-6 space-y-5 rounded-xl border bg-card p-4">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            title={t('profile.changePhoto')}
            className="group relative shrink-0 rounded-full disabled:opacity-60"
          >
            <Avatar name={me.data?.name ?? ''} src={me.data?.avatarUrl ?? null} size={72} />
            {/* Подсказка поверх: без неё непонятно, что по фото можно нажать. */}
            <span className="absolute inset-0 grid place-items-center rounded-full bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
              <Camera className="size-5 text-white" />
            </span>
          </button>
          <div className="min-w-0">
            <p className="text-sm font-medium">{t('profile.photo')}</p>
            <p className="text-xs text-muted-foreground">{t('profile.photoHint')}</p>
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            // Сбрасываем значение: иначе тот же файл второй раз не выберется —
            // браузер считает, что ничего не изменилось.
            e.target.value = ''
            if (f) void upload(f)
          }}
        />

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-muted-foreground">{t('profile.name')}</label>
          <div className="flex gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && dirty && void saveName()}
              maxLength={120}
              className="w-full max-w-sm rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <Button variant="brand" disabled={!dirty || busy} onClick={() => void saveName()}>
              {t('projectForm.save')}
            </Button>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-muted-foreground">{t('profile.email')}</label>
          {/* Почта — способ войти. Менять её надо с подтверждением на оба
              адреса, иначе опечатка отрезает человека от аккаунта. Пока
              показываем как есть. */}
          <p className="text-sm">{me.data?.email ?? '—'}</p>
        </div>
      </section>
    </div>
  )
}
