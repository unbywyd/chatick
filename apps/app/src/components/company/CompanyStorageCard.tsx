import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { HardDrive, Check } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { StorageSettings } from '@/components/files/StorageSettings'

// Хранилище компании (SPEC §8.47).
//
// Настройка была на проекте: компания с десятком проектов вводила одни и те же
// ключи десять раз, а часть проектов оседала в одном бакете, часть в другом.
// Уровень проекта убран — хранилище у компании одно на все проекты.
//
// Карточка со статусом, а форма — в модалке: полей много, а заходят сюда раз в
// жизни, и держать их развёрнутыми среди обычных настроек незачем.

export function CompanyStorageCard({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const q = useQuery({
    queryKey: ['storage-config', companyId],
    queryFn: () => api<{ provider: 'platform' | 'custom'; bucket: string }>(`/api/v1/companies/${companyId}/storage`),
  })

  const custom = q.data?.provider === 'custom'



  return (
    <section className="rounded-xl border bg-card p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <HardDrive className="size-4 text-muted-foreground" />
        {t('companyStorage.title')}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">{t('companyStorage.subtitle')}</p>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {custom ? t('companyStorage.own') : t('companyStorage.platform')}
          </p>
          {custom && q.data?.bucket && (
            <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground" dir="ltr">
              <Check className="size-3.5 shrink-0 text-emerald-500" />
              {q.data.bucket}
            </p>
          )}
          {!custom && <p className="mt-0.5 text-xs text-muted-foreground">{t('companyStorage.platformHint')}</p>}
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          {custom ? t('companyStorage.change') : t('companyStorage.setup')}
        </Button>
      </div>

      {open && <StorageSettings companyId={companyId} onClose={() => setOpen(false)} />}
    </section>
  )
}
