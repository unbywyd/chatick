import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Bell, Clock } from 'lucide-react'
import { api } from '@/lib/api'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Link } from 'react-router-dom'
import { NOTIFY_EVENTS, DEFAULT_NOTIFY_CONFIG, type NotifyConfig } from '@/lib/notify-config'

/** Варианты упреждения: часами до полусуток, дальше — сутками. */
const LEAD_OPTIONS = [1, 2, 4, 8, 12, 24, 48, 72, 168]

// Уведомления и подписки проекта (SPEC §8.9): личные подписки + напоминания задач.
const EVENTS = [
  'chat_mention',
  'task_mention',
  'comment_mention',
  'task_assigned',
  'task_status',
  'task_comment',
  // Срок задачи: кому-то напоминание нужно, кто-то ведёт сроки в своём
  // календаре и второй раз о них слышать не хочет.
  'task_due',
] as const
type Event = (typeof EVENTS)[number]

const STATUSES = ['todo', 'in_progress', 'review', 'done'] as const

type Reminder = {
  enabled: boolean
  cadence: 'hourly' | 'daily' | 'weekly'
  everyHours: string
  hourOfDay: string
  dayOfWeek: string
  audience: 'all_members' | 'assignees'
  statuses: string
}

export function NotificationsTab({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const onErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

  const prefs = useQuery({
    queryKey: ['notif-prefs', projectId],
    // Подписки живут внутри проекта — нужен project-токен, а не сессионный.
    queryFn: () => api<{ prefs: Record<Event, boolean> }>(`/api/v1/notifications/prefs`, {}, 'project'),
  })

  const togglePref = useMutation({
    mutationFn: ({ event, enabled }: { event: Event; enabled: boolean }) =>
      api(`/api/v1/notifications/prefs`, { method: 'PATCH', body: JSON.stringify({ event, enabled }) }, 'project'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notif-prefs', projectId] }),
    onError: onErr,
  })

  return (
    <div className="mx-auto w-full max-w-6xl space-y-8 p-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <Bell className="size-5" />
          {t('notif.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('notif.subtitle')}</p>
      </div>

      {/* Настройки компании — они же умолчание для этого проекта */}
      <ProjectNotifyConfig projectId={projectId} isAdmin={isAdmin} />

      {/* Личные подписки */}
      <section className="space-y-2.5 rounded-xl border bg-card p-4">
        <h2 className="text-sm font-semibold">{t('notif.subscriptions')}</h2>
        <p className="text-xs text-muted-foreground">{t('notif.subscriptionsHint')}</p>
        {EVENTS.map((ev) => (
          <label key={ev} className="flex cursor-pointer items-center justify-between gap-3 py-1">
            <div>
              <span className="block text-sm">{t(`notif.event.${ev}.label`)}</span>
              <span className="block text-xs text-muted-foreground">{t(`notif.event.${ev}.hint`)}</span>
            </div>
            <Switch
              checked={prefs.data?.prefs[ev] ?? true}
              onCheckedChange={(v) => togglePref.mutate({ event: ev, enabled: v })}
            />
          </label>
        ))}
      </section>

      {/* Напоминания об открытых задачах */}
      <ReminderConfig projectId={projectId} isAdmin={isAdmin} />

      {/* Сводка на почту — настройка человека, а не проекта: ключ в базе
          только userId, и выключенная здесь она выключалась сразу везде.
          Оставляем ссылку, чтобы её не искали. */}
      <p className="text-xs text-muted-foreground">
        {t('notif.digestMoved')}{' '}
        <Link to="/settings/notifications" className="underline underline-offset-2 hover:text-foreground">
          {t('notif.digestMovedLink')}
        </Link>
      </p>
    </div>
  )
}

/**
 * Настройки уведомлений проекта — те же, что у компании.
 *
 * Проект по умолчанию НАСЛЕДУЕТ компанию, и это видно словами: иначе человек
 * видит переключатели, думает, что настраивает проект, а на деле смотрит на
 * чужое умолчание. Переопределение — осознанное действие, и вернуться к
 * общему можно одной кнопкой.
 */
function ProjectNotifyConfig({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const q = useQuery({
    queryKey: ['notify-config', projectId],
    queryFn: () =>
      api<{ config: NotifyConfig; inherited: boolean; canEdit: boolean }>('/api/v1/notifications/config', {}, 'project'),
  })

  const save = useMutation({
    mutationFn: (body: Partial<NotifyConfig> & { inherit?: boolean }) =>
      api('/api/v1/notifications/config', { method: 'PATCH', body: JSON.stringify(body) }, 'project'),
    onSuccess: () => {
      toast.success(t('notif.saved'))
      qc.invalidateQueries({ queryKey: ['notify-config', projectId] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const inherited = q.data?.inherited ?? true
  const cfg = { ...DEFAULT_NOTIFY_CONFIG, ...(q.data?.config ?? {}) }
  const canEdit = (q.data?.canEdit ?? false) && isAdmin

  if (q.isLoading) return null

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{t('notifyConfig.title')}</h2>
          <p className="text-xs text-muted-foreground">
            {inherited ? t('notifyConfig.inherited') : t('notifyConfig.own')}
          </p>
        </div>
        {canEdit && !inherited && (
          <Button variant="outline" size="sm" onClick={() => save.mutate({ inherit: true })} disabled={save.isPending}>
            {t('notifyConfig.backToCompany')}
          </Button>
        )}
      </div>

      {/* Унаследованное показываем приглушённым и только на чтение: так видно,
          что настройка работает, но живёт не здесь. */}
      <fieldset disabled={!canEdit} className="space-y-3 disabled:opacity-60">
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <div>
            <p className="text-sm font-medium">{t('notifyConfig.dueLead')}</p>
            <p className="text-xs text-muted-foreground">{t('notifyConfig.dueLeadHint')}</p>
          </div>
          <Select
            value={String(cfg.dueLeadHours)}
            disabled={!canEdit || cfg.events.task_due === false}
            onValueChange={(v) => save.mutate({ ...cfg, dueLeadHours: Number(v) })}
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
          <p className="pb-1 text-xs text-muted-foreground">{t('notifyConfig.eventsHintProject')}</p>
          {NOTIFY_EVENTS.map((e) => (
            <label key={e} className="flex cursor-pointer items-center justify-between gap-3 py-1">
              <span className="text-sm">{t(`notifyConfig.event.${e}`)}</span>
              <Switch
                checked={cfg.events[e] !== false}
                disabled={!canEdit}
                onCheckedChange={(v) => save.mutate({ ...cfg, events: { ...cfg.events, [e]: v } })}
              />
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  )
}

function ReminderConfig({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const onErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

  const q = useQuery({
    queryKey: ['task-reminder', projectId],
    queryFn: () => api<{ reminder: Reminder | null }>(`/api/v1/notifications/reminders`, {}, 'project'),
  })

  const [form, setForm] = useState<Reminder>({
    enabled: false,
    cadence: 'daily',
    everyHours: '12',
    hourOfDay: '9',
    dayOfWeek: '1',
    audience: 'all_members',
    statuses: 'todo',
  })

  useEffect(() => {
    if (q.data?.reminder) setForm(q.data.reminder)
  }, [q.data?.reminder])

  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/notifications/reminders`, {
        method: 'PUT',
        body: JSON.stringify({
          enabled: form.enabled,
          cadence: form.cadence,
          everyHours: Math.min(24, Math.max(12, Number(form.everyHours) || 12)),
          hourOfDay: Number(form.hourOfDay),
          dayOfWeek: Number(form.dayOfWeek),
          audience: form.audience,
          statuses: form.statuses.split(',').filter(Boolean),
        }),
      }, 'project'),
    onSuccess: () => {
      toast.success(t('notif.saved'))
      qc.invalidateQueries({ queryKey: ['task-reminder', projectId] })
    },
    onError: onErr,
  })

  const toggleStatus = (s: string) => {
    const set = new Set(form.statuses.split(',').filter(Boolean))
    if (set.has(s)) set.delete(s)
    else set.add(s)
    if (set.size === 0) return // хотя бы один статус
    setForm({ ...form, statuses: [...set].join(',') })
  }

  const sel = new Set(form.statuses.split(',').filter(Boolean))

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Clock className="size-4" />
          {t('notif.reminders')}
        </h2>
        <Switch
          checked={form.enabled}
          disabled={!isAdmin}
          onCheckedChange={(v) => setForm({ ...form, enabled: v })}
        />
      </div>
      <p className="text-xs text-muted-foreground">{t('notif.remindersHint')}</p>

      <fieldset disabled={!isAdmin || !form.enabled} className="space-y-4 disabled:opacity-50">
        {/* Частота */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('notif.cadence')}</label>
          {/* «каждые N часов» убрано намеренно: письма чаще раза в сутки
              раздражают и портят репутацию домена (сервер это тоже не пустит) */}
          <div className="inline-flex overflow-hidden rounded-md border">
            {(['daily', 'weekly'] as const).map((cd) => (
              <button
                key={cd}
                type="button"
                onClick={() => setForm({ ...form, cadence: cd })}
                className={`px-3 py-1.5 text-xs transition-colors ${form.cadence === cd ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'}`}
              >
                {t(`notif.cadenceOpt.${cd}`)}
              </button>
            ))}
          </div>
        </div>

        {/* Параметры частоты */}
        {form.cadence === 'hourly' ? (
          <label className="flex items-center gap-2 text-sm">
            {t('notif.everyHours')}
            <input
              type="number"
              min={12}
              max={24}
              value={form.everyHours}
              onChange={(e) => setForm({ ...form, everyHours: e.target.value })}
              className="w-20 rounded-md border bg-background px-2 py-1 text-sm"
            />
            <span className="text-xs text-muted-foreground">{t('notif.minInterval')}</span>
          </label>
        ) : (
          <div className="flex flex-wrap items-center gap-4">
            {form.cadence === 'weekly' && (
              <label className="flex items-center gap-2 text-sm">
                {t('notif.dayOfWeek')}
                <Select
                  value={String(form.dayOfWeek)}
                  onValueChange={(v) => setForm({ ...form, dayOfWeek: v })}
                >
                  <SelectTrigger className="w-auto min-w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                  {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {t(`notif.weekday.${d}`)}
                    </SelectItem>
                  ))}
                  </SelectContent>
                </Select>
              </label>
            )}
            <label className="flex items-center gap-2 text-sm">
              {t('notif.atHour')}
              <Select value={String(form.hourOfDay)} onValueChange={(v) => setForm({ ...form, hourOfDay: v })}>
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
          </div>
        )}

        {/* Кому */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('notif.audience')}</label>
          <div className="inline-flex overflow-hidden rounded-md border">
            {(['all_members', 'assignees'] as const).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setForm({ ...form, audience: a })}
                className={`px-3 py-1.5 text-xs transition-colors ${form.audience === a ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'}`}
              >
                {t(`notif.audienceOpt.${a}`)}
              </button>
            ))}
          </div>
        </div>

        {/* Какие статусы считать открытыми */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('notif.statuses')}</label>
          <div className="flex flex-wrap gap-2">
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => toggleStatus(s)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${sel.has(s) ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'}`}
              >
                {t(`tasks.status.${s}`)}
              </button>
            ))}
          </div>
        </div>
      </fieldset>

      {isAdmin && (
        <Button variant="brand" onClick={() => save.mutate()} disabled={save.isPending}>
          {t('notif.save')}
        </Button>
      )}
    </section>
  )
}

/**
 * Системные уведомления — всплывашки операционной системы.
 *
 * Настройки этого устройства, а не учётной записи: за рабочим ноутбуком и
 * домашним компьютером ответ обычно разный, и хранить их на сервере значило бы
 * навязывать один выбор всем машинам сразу.
 */
