import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { HardDrive, X } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'

// Настройка хранилища проекта (SPEC §8.10): platform (наш, лимит) | custom (свой S3/R2).
type StorageConfig = {
  provider: 'platform' | 'custom'
  endpoint: string
  region: string
  bucket: string
  publicUrl: string
  hasKeys: boolean
}

/**
 * Настройка хранилища проекта ИЛИ компании.
 *
 * Одна форма на оба уровня: поля и проверка соединения совпадают, а вторая
 * копия неминуемо разошлась бы с первой — например, забыла бы, что пустые
 * ключи означают «оставить прежние».
 */
export function StorageSettings({
  projectId,
  companyId,
  onClose,
}: {
  projectId?: string
  companyId?: string
  onClose: () => void
}) {
  // Компания — если задана: настройка проекта её переопределяет, а не наоборот.
  const base = companyId ? `/api/v1/companies/${companyId}/storage` : `/api/v1/projects/${projectId}/storage`
  const scopeKey = companyId ?? projectId ?? ''
  const { t } = useTranslation()
  const qc = useQueryClient()
  const onErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

  const q = useQuery({
    queryKey: ['storage-config', scopeKey],
    queryFn: () => api<StorageConfig>(base),
  })

  const [provider, setProvider] = useState<'platform' | 'custom'>('platform')
  const [endpoint, setEndpoint] = useState('')
  const [region, setRegion] = useState('auto')
  const [bucket, setBucket] = useState('')
  const [publicUrl, setPublicUrl] = useState('')
  const [accessKey, setAccessKey] = useState('')
  const [secretKey, setSecretKey] = useState('')

  useEffect(() => {
    if (!q.data) return
    setProvider(q.data.provider)
    setEndpoint(q.data.endpoint)
    setRegion(q.data.region || 'auto')
    setBucket(q.data.bucket)
    setPublicUrl(q.data.publicUrl)
  }, [q.data])

  const save = useMutation({
    mutationFn: () =>
      api(base, {
        method: 'PUT',
        body: JSON.stringify(
          provider === 'platform'
            ? { provider }
            : { provider, endpoint, region, bucket, publicUrl, accessKey: accessKey || undefined, secretKey: secretKey || undefined },
        ),
      }),
    onSuccess: () => {
      toast.success(t('storage.saved'))
      setAccessKey('')
      setSecretKey('')
      qc.invalidateQueries({ queryKey: ['storage-config', scopeKey] })
      qc.invalidateQueries({ queryKey: ['files', projectId] })
      onClose()
    },
    onError: onErr,
  })

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <HardDrive className="size-5" />
            {t('storage.title')}
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        {/* Выбор провайдера */}
        <div className="mb-4 grid grid-cols-2 gap-2">
          {(['platform', 'custom'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setProvider(p)}
              className={`rounded-lg border p-3 text-start text-sm transition-colors ${provider === p ? 'border-brand bg-accent' : 'hover:bg-secondary'}`}
            >
              <div className="font-medium">{t(`storage.provider.${p}.label`)}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t(`storage.provider.${p}.hint`)}</div>
            </button>
          ))}
        </div>

        {provider === 'custom' && (
          <div className="space-y-3">
            <Field label={t('storage.endpoint')} value={endpoint} onChange={setEndpoint} placeholder="https://<account>.r2.cloudflarestorage.com" />
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('storage.region')} value={region} onChange={setRegion} placeholder="auto" />
              <Field label={t('storage.bucket')} value={bucket} onChange={setBucket} placeholder="my-bucket" />
            </div>
            <Field label={t('storage.publicUrl')} value={publicUrl} onChange={setPublicUrl} placeholder="https://cdn.example.com (optional)" />
            <Field
              label={t('storage.accessKey')}
              value={accessKey}
              onChange={setAccessKey}
              placeholder={q.data?.hasKeys ? t('storage.keyKeep') : ''}
            />
            <Field label={t('storage.secretKey')} value={secretKey} onChange={setSecretKey} type="password" placeholder={q.data?.hasKeys ? t('storage.keyKeep') : ''} />
            <p className="text-xs text-muted-foreground">{t('storage.keyNote')}</p>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('confirm.cancel')}
          </Button>
          <Button variant="brand" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? t('storage.testing') : t('storage.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
    </label>
  )
}
