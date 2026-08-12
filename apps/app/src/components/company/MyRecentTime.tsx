import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check, Clock, Pencil, Trash2, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Combobox } from '@/components/ui/combobox'
import { useConfirm } from '@/components/ui/confirm'

// Мои последние записи времени — на странице компании, над общей статистикой.
//
// Зачем отдельно от статистики ниже: та отвечает на «сколько потрачено», а это
// на «поправь мою запись». Раньше поправить свои часы можно было только зайдя
// в конкретный проект, а перенести время между проектами — вообще никак.

type Entry = {
  id: string
  projectId: string
  projectName: string
  task: { id: string; number: string; title: string } | null
  description: string
  startedAt: string
  endedAt: string | null
  minutes: number | null
  autoStopped: boolean
}

type Recent = { items: Entry[]; projects: { id: string; name: string }[] }

/** «2ч 15м» — часы с минутами читаются быстрее, чем 135. */
function human(minutes: number | null): string {
  if (minutes == null) return '—'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? `${h}ч ${m}м` : `${m}м`
}

/** Дата для input[type=datetime-local]: он не понимает ISO с зоной. */
function forInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function MyRecentTime() {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [editing, setEditing] = useState<string | null>(null)

  const recent = useQuery({
    queryKey: ['my-time-recent'],
    queryFn: () => api<Recent>('/api/v1/my/time/recent?limit=10'),
  })

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api(`/api/v1/my/time/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => {
      setEditing(null)
      void qc.invalidateQueries({ queryKey: ['my-time-recent'] })
      // Сводка ниже считает те же записи — иначе цифры разойдутся со списком.
      void qc.invalidateQueries({ queryKey: ['company-time'] })
    },
    onError: (e: { message?: string }) => toast.error(e.message || t('common.error')),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/my/time/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['my-time-recent'] })
      void qc.invalidateQueries({ queryKey: ['company-time'] })
    },
    onError: (e: { message?: string }) => toast.error(e.message || t('common.error')),
  })

  const items = recent.data?.items ?? []
  if (!recent.isLoading && !items.length) return null

  return (
    <section className="mb-6">
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        <Clock className="size-4" />
        {t('myTime.title')}
      </h2>

      {recent.isLoading ? (
        <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[680px] text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
                <th className="px-2 py-1.5 text-start font-medium">{t('myTime.when')}</th>
                <th className="px-2 py-1.5 text-start font-medium">{t('myTime.project')}</th>
                <th className="px-2 py-1.5 text-start font-medium">{t('myTime.what')}</th>
                <th className="px-2 py-1.5 text-end font-medium">{t('myTime.duration')}</th>
                <th className="w-16" />
              </tr>
            </thead>
            <tbody>
              {items.map((e) =>
                editing === e.id ? (
                  <EditRow
                    key={e.id}
                    entry={e}
                    projects={recent.data?.projects ?? []}
                    saving={patch.isPending}
                    onCancel={() => setEditing(null)}
                    onSave={(body) => patch.mutate({ id: e.id, body })}
                  />
                ) : (
                  <tr key={e.id} className="group border-b last:border-0 hover:bg-accent/40">
                    <td className="whitespace-nowrap px-2 py-1.5 align-middle text-xs text-muted-foreground">
                      {new Date(e.startedAt).toLocaleString(i18n.language, {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="px-2 py-1.5 align-middle">
                      <span className="line-clamp-1 text-xs">{e.projectName}</span>
                    </td>
                    <td className="px-2 py-1.5 align-middle">
                      <span className={cn('line-clamp-1', !e.description && 'text-muted-foreground')}>
                        {e.description || '—'}
                      </span>
                      {e.task && (
                        <span className="text-[11px] text-muted-foreground">{e.task.number}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-end align-middle tabular-nums">
                      {e.endedAt ? human(e.minutes) : <span className="text-brand-ink">{t('myTime.running')}</span>}
                    </td>
                    <td className="px-2 py-1.5 align-middle">
                      <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          title={t('common.edit')}
                          onClick={() => setEditing(e.id)}
                          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          <Pencil className="size-3.5" />
                        </button>
                        <button
                          title={t('common.delete')}
                          onClick={async () => {
                            // Удаление времени необратимо: спрашиваем всегда.
                            if (await confirm({ title: t('myTime.deleteConfirm'), destructive: true })) {
                              remove.mutate(e.id)
                            }
                          }}
                          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function EditRow({
  entry,
  projects,
  saving,
  onCancel,
  onSave,
}: {
  entry: Entry
  projects: { id: string; name: string }[]
  saving: boolean
  onCancel: () => void
  onSave: (body: Record<string, unknown>) => void
}) {
  const { t } = useTranslation()
  const [projectId, setProjectId] = useState(entry.projectId)
  const [description, setDescription] = useState(entry.description)
  const [startedAt, setStartedAt] = useState(forInput(entry.startedAt))
  const [endedAt, setEndedAt] = useState(entry.endedAt ? forInput(entry.endedAt) : '')

  const save = () =>
    onSave({
      projectId,
      description,
      startedAt: new Date(startedAt).toISOString(),
      // Идущий таймер не трогаем: пустое поле означает «ещё идёт», а не «сбрось».
      ...(endedAt ? { endedAt: new Date(endedAt).toISOString() } : {}),
    })

  return (
    <tr className="border-b bg-accent/30 last:border-0">
      <td className="px-2 py-1.5 align-middle">
        <div className="flex flex-col gap-1">
          <Input
            type="datetime-local"
            value={startedAt}
            onChange={(e) => setStartedAt(e.target.value)}
            className="h-7 w-40 text-xs"
          />
          <Input
            type="datetime-local"
            value={endedAt}
            onChange={(e) => setEndedAt(e.target.value)}
            className="h-7 w-40 text-xs"
          />
        </div>
      </td>
      {/* Смена проекта здесь и есть «перекинуть часы»: связь с задачей при
          переносе рвётся на сервере — задача осталась в прежнем проекте. */}
      <td className="px-2 py-1.5 align-middle">
        <Combobox
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
          value={projectId}
          onChange={setProjectId}
          className="h-7 w-44 text-xs"
        />
      </td>
      <td className="px-2 py-1.5 align-middle" colSpan={2}>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('myTime.what')}
          className="h-7 text-xs"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') onCancel()
          }}
        />
      </td>
      <td className="px-2 py-1.5 align-middle">
        <div className="flex items-center justify-end gap-1">
          <button
            title={t('common.save')}
            disabled={saving}
            onClick={save}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Check className="size-4" />
          </button>
          <button
            title={t('common.cancel')}
            onClick={onCancel}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      </td>
    </tr>
  )
}
