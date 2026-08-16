import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Switch } from '@/components/ui/switch'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'

/**
 * Суточная сводка непрочитанного на почту (SPEC §8.22).
 *
 * Настройка ЛИЧНАЯ и одна на всё: в user_notification_prefs ключ — только
 * userId, ни проекта, ни компании там нет. Поэтому живёт рядом с системными
 * всплывашками, а не на странице проекта, где выглядела как настройка этого
 * проекта: выключив её в одном, человек находил её выключенной и во всех
 * остальных и решал, что интерфейс врёт.
 *
 * На странице компании ей тоже не место — там она читалась бы как «сводка
 * для сотрудников», а меняет только свою почту.
 */
export function DigestSettings() {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const prefs = useQuery({
    queryKey: ['inbox-prefs'],
    queryFn: () => api<{ dailyDigest: boolean; digestHourUtc: number }>('/api/v1/inbox/prefs'),
  })

  const save = useMutation({
    mutationFn: (b: { dailyDigest: boolean; digestHourUtc: number }) =>
      api('/api/v1/inbox/prefs', { method: 'PUT', body: JSON.stringify(b) }),
    onSuccess: () => {
      toast.success(t('notif.saved'))
      qc.invalidateQueries({ queryKey: ['inbox-prefs'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const daily = prefs.data?.dailyDigest ?? true
  const hour = prefs.data?.digestHourUtc ?? 9

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{t('notif.digest')}</h2>
          <p className="text-xs text-muted-foreground">{t('notif.digestHint')}</p>
        </div>
        <Switch checked={daily} onCheckedChange={(v) => save.mutate({ dailyDigest: v, digestHourUtc: hour })} />
      </div>
      {daily && (
        <label className="flex items-center gap-2 text-sm">
          {t('notif.atHour')}
          <Select
            value={String(hour)}
            onValueChange={(v) => save.mutate({ dailyDigest: true, digestHourUtc: Number(v) })}
          >
            <SelectTrigger className="w-auto min-w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 24 }, (_, h) => (
                <SelectItem key={h} value={String(h)}>
                  {String(h).padStart(2, '0')}:00 UTC
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      )}
    </section>
  )
}
