import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Building2, Camera, Trash2 } from 'lucide-react'
import { api, API_URL, getSessionToken } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// Имя и логотип компании (SPEC §8.40).
//
// Логотип показывается в шапке вместо нашего, поэтому загружается здесь же:
// просить человека «разместить картинку где-нибудь и прислать ссылку» — не
// решение. Имя переименовывалось только через SQL, хотя видит его вся команда.

export function CompanyProfile({
  companyId,
  name: initialName,
  logoUrl,
  isAdmin,
}: {
  companyId: string
  name: string
  logoUrl: string | null
  isAdmin: boolean
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [name, setName] = useState(initialName)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = () => qc.invalidateQueries({ queryKey: ['companies'] })

  const rename = useMutation({
    mutationFn: () =>
      api(`/api/v1/companies/${companyId}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) }),
    onSuccess: () => {
      refresh()
      toast.success(t('projectForm.saved'))
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const upload = async (file: File) => {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      // Своим fetch, а не через api(): там всегда JSON, а здесь multipart.
      const res = await fetch(`${API_URL}/api/v1/companies/${companyId}/logo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getSessionToken()}` },
        body: fd,
      })
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText)
      refresh()
      toast.success(t('companyProfile.logoUpdated'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  const removeLogo = useMutation({
    mutationFn: () => api(`/api/v1/companies/${companyId}/logo`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh()
      toast.success(t('companyProfile.logoRemoved'))
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  return (
    <section className="rounded-xl border bg-card p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Building2 className="size-4 text-muted-foreground" />
        {t('companyProfile.title')}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">{t('companyProfile.subtitle')}</p>

      <div className="mt-4 flex items-start gap-4">
        {/* Логотип с кнопкой поверх — как аватар в профиле: одинаковый жест
            в похожих местах учить не нужно. */}
        <div className="relative shrink-0">
          <span className="grid size-16 place-items-center overflow-hidden rounded-xl border bg-secondary">
            {logoUrl ? (
              <img src={logoUrl} alt="" className="no-zoom size-full object-cover" />
            ) : (
              <Building2 className="size-6 text-muted-foreground" />
            )}
          </span>
          {isAdmin && (
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              title={t('companyProfile.changeLogo')}
              className="absolute -bottom-1 -end-1 grid size-6 place-items-center rounded-full border bg-background text-muted-foreground transition-colors hover:text-foreground"
            >
              <Camera className="size-3.5" />
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              if (e.target.files?.[0]) void upload(e.target.files[0])
              // Сбрасываем значение: иначе тот же файл повторно не выберется.
              e.target.value = ''
            }}
          />
        </div>

        <div className="min-w-0 flex-1">
          <label className="mb-1.5 block text-xs font-medium">{t('companyProfile.name')}</label>
          <Input
            value={name}
            disabled={!isAdmin}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && name.trim() !== initialName && rename.mutate()}
            maxLength={120}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('companyProfile.nameHint')}</p>

          {isAdmin && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="brand"
                size="sm"
                disabled={!name.trim() || name.trim() === initialName || rename.isPending}
                onClick={() => rename.mutate()}
              >
                {t('projectForm.save')}
              </Button>
              {logoUrl && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={removeLogo.isPending}
                  onClick={() => removeLogo.mutate()}
                >
                  <Trash2 className="size-3.5" />
                  {t('companyProfile.removeLogo')}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
