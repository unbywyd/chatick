import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Bell } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { NOTIFY_EVENTS, DEFAULT_NOTIFY_CONFIG, type NotifyConfig } from '@/lib/notify-config'

// Уведомления компании — умолчание для всех её проектов (SPEC §8.9).
//
// Раньше настраивались только в проекте, и правило вроде «о сроках
// предупреждаем за сутки» приходилось заводить в каждом заново — десять
// проектов, десять способов разойтись.
//
// Наследование, а не копия при создании: меняя правило здесь, ждут, что оно
// изменится везде, а не только в проектах, заведённых после. Проект, которому
// нужно иначе, переопределяет у себя.

/** Варианты упреждения: часами до полусуток, дальше — сутками. */
const LEAD_OPTIONS = [1, 2, 4, 8, 12, 24, 48, 72, 168]

export function CompanyNotifySettings({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  // Черновик отдельно от загруженного: правки не должны исчезать при фоновом
  // обновлении, а кнопка «Сохранить» — понимать, менялось ли что-то.
  const [draft, setDraft] = useState<NotifyConfig | null>(null)

  const cfgQ = useQuery({
    queryKey: ['company-notify-config', companyId],
    queryFn: () => api<{ config: NotifyConfig; canEdit: boolean }>(`/api/v1/companies/${companyId}/notify-config`),
  })

  const save = useMutation({
    mutationFn: (v: NotifyConfig) =>
      api(`/api/v1/companies/${companyId}/notify-config`, { method: 'PATCH', body: JSON.stringify(v) }),
    onSuccess: () => {
      toast.success(t('projectForm.saved'))
      setDraft(null)
      qc.invalidateQueries({ queryKey: ['company-notify-config', companyId] })
      // Проекты берут настройку отсюда — их эффективный конфиг устарел.
      qc.invalidateQueries({ queryKey: ['notify-config'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const canEdit = cfgQ.data?.canEdit ?? false
  const cfg = draft ?? { ...DEFAULT_NOTIFY_CONFIG, ...(cfgQ.data?.config ?? {}) }
  const dirty = draft !== null

  const setEvent = (key: string, on: boolean) =>
    setDraft({ ...cfg, events: { ...cfg.events, [key]: on } })

  if (cfgQ.isLoading) return <p className="text-sm text-muted-foreground">…</p>

  return (
    <div className="space-y-5 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <Bell className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('notifyConfig.title')}</h3>
      </div>
      <p className="-mt-3 text-xs text-muted-foreground">{t('notifyConfig.hint')}</p>

      {/* За сколько предупреждать о сроке — первым: это единственная числовая
          настройка, и ради неё сюда чаще всего и заходят. */}
      <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
        <div>
          <p className="text-sm font-medium">{t('notifyConfig.dueLead')}</p>
          <p className="text-xs text-muted-foreground">{t('notifyConfig.dueLeadHint')}</p>
        </div>
        <Select
          value={String(cfg.dueLeadHours)}
          disabled={!canEdit || cfg.events.task_due === false}
          onValueChange={(v) => setDraft({ ...cfg, dueLeadHours: Number(v) })}
        >
          <SelectTrigger className="w-44 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LEAD_OPTIONS.map((h) => (
              <SelectItem key={h} value={String(h)}>
                {h < 24 ? t('notifyConfig.leadHours', { count: h }) : t('notifyConfig.leadDays', { count: h / 24 })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1 rounded-lg border p-3">
        <p className="text-sm font-medium">{t('notifyConfig.events')}</p>
        <p className="pb-1 text-xs text-muted-foreground">{t('notifyConfig.eventsHint')}</p>
        {NOTIFY_EVENTS.map((e) => (
          <label key={e} className="flex cursor-pointer items-center justify-between gap-3 py-1">
            <span className="text-sm">{t(`notifyConfig.event.${e}`)}</span>
            <Switch
              checked={cfg.events[e] !== false}
              disabled={!canEdit}
              onCheckedChange={(v) => setEvent(e, v)}
            />
          </label>
        ))}
      </div>

      {canEdit && (
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate(cfg)}>
            {t('projectForm.save')}
          </Button>
          {dirty && (
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
