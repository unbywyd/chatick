import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Languages } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// Язык компании (SPEC §8.39).
//
// Это НЕ язык интерфейса — его каждый выбирает себе сам в своём профиле.
// Здесь язык писем тем, у кого своих настроек ещё нет: приглашённому, которого
// в системе пока не существует, и человеку, заведённому через API компании.
//
// Без этого письма уходили на языке приглашающего: русский админ израильской
// фирмы звал израильтянина, и тот получал письмо по-русски.

const LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'ru', label: 'Русский' },
  { code: 'he', label: 'עברית' },
] as const

export function CompanyLocale({
  companyId,
  current,
  isAdmin,
}: {
  companyId: string
  current: string
  isAdmin: boolean
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [locale, setLocale] = useState(current || 'en')

  const save = useMutation({
    mutationFn: (next: string) =>
      api(`/api/v1/companies/${companyId}`, { method: 'PATCH', body: JSON.stringify({ locale: next }) }),
    onSuccess: (_d, next) => {
      setLocale(next)
      qc.invalidateQueries({ queryKey: ['companies'] })
      toast.success(t('companyLocale.saved'))
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  return (
    <section className="rounded-xl border bg-card p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Languages className="size-4 text-muted-foreground" />
        {t('companyLocale.title')}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">{t('companyLocale.subtitle')}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        {LOCALES.map((l) => (
          <button
            key={l.code}
            disabled={!isAdmin || save.isPending}
            onClick={() => l.code !== locale && save.mutate(l.code)}
            className={cn(
              'rounded-full border px-4 py-2 text-sm transition-colors',
              locale === l.code ? 'border-brand bg-brand/10 font-medium' : 'text-muted-foreground hover:bg-accent',
              !isAdmin && 'cursor-default opacity-60',
            )}
          >
            {l.label}
          </button>
        ))}
      </div>

      {!isAdmin && <p className="mt-2 text-xs text-muted-foreground">{t('companyLocale.adminOnly')}</p>}
    </section>
  )
}
