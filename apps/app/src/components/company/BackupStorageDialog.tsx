import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { HardDrive, X, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

// Хранилище для бэкапов (SPEC §8.48).
//
// Отдельное от файлового, со своими ключами и endpoint — не просто «другой
// бакет». Копию имеет смысл держать в другом аккаунте, а лучше у другого
// провайдера: лежащая в том же аккаунте, она недоступна ровно тогда, когда
// нужна — при его блокировке, потере ключей или чужом доступе.
//
// Выключено — архивы пишутся в файловое хранилище компании.

type Config = {
  separate: boolean
  endpoint: string
  region: string
  bucket: string
  hasKeys: boolean
}

export function BackupStorageDialog({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const q = useQuery({
    queryKey: ['backup-storage', companyId],
    queryFn: () => api<Config>(`/api/v1/companies/${companyId}/backup-storage`),
  })

  const [separate, setSeparate] = useState(false)
  const [endpoint, setEndpoint] = useState('')
  const [region, setRegion] = useState('auto')
  const [bucket, setBucket] = useState('')
  const [accessKey, setAccessKey] = useState('')
  const [secretKey, setSecretKey] = useState('')

  useEffect(() => {
    if (!q.data) return
    setSeparate(q.data.separate)
    setEndpoint(q.data.endpoint)
    setRegion(q.data.region || 'auto')
    setBucket(q.data.bucket)
  }, [q.data])

  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/companies/${companyId}/backup-storage`, {
        method: 'PUT',
        body: JSON.stringify(
          separate
            ? {
                separate,
                endpoint,
                region,
                bucket,
                accessKey: accessKey || undefined,
                secretKey: secretKey || undefined,
              }
            : { separate: false },
        ),
      }),
    onSuccess: () => {
      toast.success(t('storage.saved'))
      setAccessKey('')
      setSecretKey('')
      qc.invalidateQueries({ queryKey: ['backup-storage', companyId] })
      qc.invalidateQueries({ queryKey: ['auto-backup', companyId] })
      onClose()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="flex items-center gap-2 text-base font-bold">
            <HardDrive className="size-4" />
            {t('backup.storageSetupTitle')}
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="space-y-4 p-4">
          <label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border border-dashed p-3">
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t('backup.separateStorage')}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{t('backup.separateStorageHint')}</span>
            </span>
            <Switch checked={separate} onCheckedChange={setSeparate} className="mt-0.5 shrink-0" />
          </label>

          {separate && (
            <>
              <Field label={t('storage.endpoint')} value={endpoint} onChange={setEndpoint} placeholder="https://<account>.r2.cloudflarestorage.com" />
              <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
                <Field label={t('storage.bucket')} value={bucket} onChange={setBucket} placeholder="my-backups" />
                <Field label={t('storage.region')} value={region} onChange={setRegion} placeholder="auto" />
              </div>
              <Field label={t('storage.accessKey')} value={accessKey} onChange={setAccessKey} placeholder={q.data?.hasKeys ? t('storage.keyKeep') : ''} />
              <Field
                label={t('storage.secretKey')}
                value={secretKey}
                onChange={setSecretKey}
                type="password"
                placeholder={q.data?.hasKeys ? t('storage.keyKeep') : ''}
              />
              <p className="text-xs text-muted-foreground">{t('backup.testHint')}</p>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t p-4">
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="brand" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="size-3.5 animate-spin" />}
            {t('projectForm.save')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium">{label}</label>
      {/* dir=ltr: адреса и ключи латиницей, в иврите иначе разворачиваются */}
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} type={type} dir="ltr" />
    </div>
  )
}
