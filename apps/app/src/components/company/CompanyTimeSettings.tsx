import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Clock } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Combobox } from '@/components/ui/combobox'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { COUNTRIES, countryByCode, allTimezones, timezoneOffset } from '@/lib/countries'
import { DEFAULT_TIME_CONFIG, type TimeConfig } from '@/lib/time-config'

// Настройки учёта времени компании (SPEC §8.36).
//
// Раньше жили у каждого проекта. Часовой пояс, распорядок дня и правила
// забытого таймера — свойства организации: задавая их заново в каждом проекте,
// компания получала десять способов разойтись, и «эта неделя» в двух отчётах
// начиналась в разные дни.

/** Минуты от полуночи → «09:00» для поля времени. */
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const fromHHMM = (s: string) => {
  const [h, m] = s.split(':').map(Number)
  return Number.isFinite(h) && Number.isFinite(m) ? h! * 60 + m! : null
}

export function CompanyTimeSettings({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  // Черновик отдельно от загруженного: правки не должны исчезать при фоновом
  // обновлении, а кнопка «Сохранить» — понимать, менялось ли что-то.
  const [draft, setDraft] = useState<TimeConfig | null>(null)

  const cfgQ = useQuery({
    queryKey: ['company-time-config', companyId],
    queryFn: () => api<{ config: TimeConfig; canEdit: boolean }>(`/api/v1/companies/${companyId}/time-config`),
  })

  const save = useMutation({
    mutationFn: (v: TimeConfig) =>
      api(`/api/v1/companies/${companyId}/time-config`, { method: 'PATCH', body: JSON.stringify(v) }),
    onSuccess: () => {
      toast.success(t('projectForm.saved'))
      setDraft(null)
      qc.invalidateQueries({ queryKey: ['company-time-config', companyId] })
      // Пояс и первый день недели режут сутки в отчётах — их надо перечитать.
      qc.invalidateQueries({ queryKey: ['company-time'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  // Список зон длинный и не меняется — собираем один раз на монтирование.
  const timezoneOptions = useMemo(
    () => allTimezones().map((tz) => ({ value: tz, label: tz.replace(/_/g, ' '), hint: timezoneOffset(tz) })),
    [],
  )

  const canEdit = cfgQ.data?.canEdit ?? false
  const time = draft ?? { ...DEFAULT_TIME_CONFIG, ...(cfgQ.data?.config ?? {}) }
  const set = <K extends keyof TimeConfig>(k: K, v: TimeConfig[K]) => setDraft({ ...time, [k]: v })
  const dirty = draft !== null
  // Конец раньше начала — сутки наизнанку. Не даём сохранить и говорим почему,
  // а не подменяем значение молча: подмену замечают, лишь перезагрузив страницу.
  const badHours = time.workDayEnd <= time.workDayStart

  if (cfgQ.isLoading) return <p className="text-sm text-muted-foreground">…</p>

  return (
    <div className="space-y-5 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <Clock className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('time.settingsTitle')}</h3>
      </div>
      <p className="-mt-3 text-xs text-muted-foreground">{t('time.settingsHint')}</p>

      {/* Регион задаётся одним выбором: пояс и первый день недели связаны, и
          настраивать их порознь — путь к рассинхрону отчётов. */}
      <div className="space-y-3 rounded-lg border p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">{t('time.country')}</p>
            <p className="text-xs text-muted-foreground">{t('time.countryHint')}</p>
          </div>
          <Select
            value={time.country || 'none'}
            onValueChange={(code) => {
              const preset = countryByCode(code)
              if (!preset) return set('country', '')
              setDraft({ ...time, country: preset.code, timezone: preset.timezone, weekStart: preset.weekStart })
            }}
            disabled={!canEdit}
          >
            <SelectTrigger className="w-52">
              <SelectValue placeholder={t('time.countryNone')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t('time.countryNone')}</SelectItem>
              {COUNTRIES.map((c) => (
                <SelectItem key={c.code} value={c.code}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-xs text-muted-foreground">{t('time.timezone')}</p>
            {/* У Combobox нет своего disabled: гасим обёрткой, иначе
                читатель тыкал бы в список, который сервер всё равно отвергнет. */}
            <div className={cn(!canEdit && 'pointer-events-none opacity-60')}>
              <Combobox
                options={timezoneOptions}
                value={time.timezone}
                onChange={(tz) => set('timezone', tz)}
                placeholder="UTC"
              />
            </div>
          </div>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">{t('time.weekStart')}</p>
            <Select value={String(time.weekStart)} onValueChange={(v) => set('weekStart', Number(v))} disabled={!canEdit}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[0, 1, 6].map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {t(`notif.weekday.${d}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Рабочие часы: по ним понятно, укладывается ли день в норму. */}
      <div className="space-y-2">
        <div>
          <p className="text-sm font-medium">{t('time.workDay')}</p>
          <p className="text-xs text-muted-foreground">{t('time.workDayHint')}</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="mb-1 text-xs text-muted-foreground">{t('time.workDayStart')}</p>
            <Input
              type="time"
              value={toHHMM(time.workDayStart)}
              disabled={!canEdit}
              onChange={(e) => {
                const v = fromHHMM(e.target.value)
                if (v !== null) set('workDayStart', v)
              }}
            />
          </div>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">{t('time.workDayEnd')}</p>
            <Input
              type="time"
              value={toHHMM(time.workDayEnd)}
              disabled={!canEdit}
              className={cn(badHours && 'border-destructive')}
              onChange={(e) => {
                const v = fromHHMM(e.target.value)
                if (v !== null) set('workDayEnd', v)
              }}
            />
          </div>
        </div>
        {badHours && <p className="text-xs text-destructive">{t('time.workDayInvalid')}</p>}
      </div>

      {/* Параллельные таймеры: они же закрывают потребность вести две задачи
          разом — вместо списка задач внутри одной записи. */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{t('time.maxTimers')}</p>
          <p className="text-xs text-muted-foreground">{t('time.maxTimersHint')}</p>
        </div>
        <Input
          type="number"
          min={1}
          max={20}
          value={time.maxTimers}
          disabled={!canEdit}
          onChange={(e) => set('maxTimers', Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
          className="w-20 text-center"
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{t('time.translate')}</p>
          <p className="text-xs text-muted-foreground">{t('time.translateHint')}</p>
        </div>
        <Switch checked={time.translate} onCheckedChange={(v) => set('translate', v)} disabled={!canEdit} />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">{t('time.idleAction')}</p>
        <div className="flex gap-1.5">
          {(['remind', 'stop'] as const).map((action) => (
            <button
              key={action}
              type="button"
              disabled={!canEdit}
              onClick={() => set('idleAction', action)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs transition-colors disabled:opacity-60',
                time.idleAction === action ? 'border-brand bg-brand/10 text-foreground' : 'text-muted-foreground hover:bg-accent',
              )}
            >
              {t(action === 'remind' ? 'time.idleRemind' : 'time.idleStop')}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="mb-1 text-xs text-muted-foreground">{t('time.idleHours')}</p>
            <Input
              type="number"
              min={1}
              max={48}
              value={time.idleHours}
              disabled={!canEdit}
              onChange={(e) => set('idleHours', Math.max(1, Math.min(48, Number(e.target.value) || 8)))}
            />
          </div>
          {time.idleAction === 'remind' && (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">{t('time.repeatHours')}</p>
              <Input
                type="number"
                min={1}
                max={48}
                value={time.repeatHours}
                disabled={!canEdit}
                onChange={(e) => set('repeatHours', Math.max(1, Math.min(48, Number(e.target.value) || 8)))}
              />
            </div>
          )}
        </div>
      </div>

      {canEdit && (
        <div className="flex justify-end gap-2">
          {dirty && (
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
          )}
          <Button variant="brand" size="sm" disabled={!dirty || badHours || save.isPending} onClick={() => save.mutate(time)}>
            {t('projectForm.save')}
          </Button>
        </div>
      )}
    </div>
  )
}
