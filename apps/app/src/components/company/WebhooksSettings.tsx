import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check, Copy, Plus, Radio, Trash2, TriangleAlert } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useConfirm } from '@/components/ui/confirm'

// Вебхуки во внешнюю систему (SPEC-INTEGRATION §7).
//
// Настраивает админ компании, а не разработчик с curl: адрес приёмника и
// подписка на события — это решение про интеграцию, а не про код.

type Webhook = {
  id: string
  url: string
  events: string[]
  active: boolean
  lastOkAt: string | null
  lastFailAt: string | null
  lastError: string | null
}

const EVENTS = ['task.created', 'task.status_changed', 'task.assigned'] as const

export function WebhooksSettings({ companyId, isAdmin }: { companyId: string; isAdmin: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()

  const [creating, setCreating] = useState(false)
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<string[]>([])
  // Секрет показывается один раз — как ключ API. Дальше его негде взять.
  const [fresh, setFresh] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const hooks = useQuery({
    queryKey: ['webhooks', companyId],
    enabled: isAdmin,
    queryFn: () => api<{ items: Webhook[] }>(`/api/v1/companies/${companyId}/webhooks`),
  })

  const create = useMutation({
    mutationFn: () =>
      api<{ secret: string }>(`/api/v1/companies/${companyId}/webhooks`, {
        method: 'POST',
        body: JSON.stringify({ url: url.trim(), events }),
      }),
    onSuccess: (res) => {
      setFresh(res.secret)
      setCreating(false)
      setUrl('')
      setEvents([])
      qc.invalidateQueries({ queryKey: ['webhooks', companyId] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/companies/${companyId}/webhooks/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks', companyId] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  if (!isAdmin) return null

  const copy = async () => {
    if (!fresh) return
    try {
      await navigator.clipboard.writeText(fresh)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(t('composer.clipboardDenied'))
    }
  }

  return (
    <section className="rounded-xl border bg-card p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Radio className="size-4 text-muted-foreground" />
        {t('webhooks.title')}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">{t('webhooks.subtitle')}</p>

      {fresh && (
        <div className="mt-3 rounded-lg border border-brand bg-brand/5 p-3">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <TriangleAlert className="size-4 text-brand-ink" />
            {t('webhooks.secretOnce')}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{t('webhooks.secretHint')}</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded bg-secondary px-2 py-1.5 font-mono text-xs">
              {fresh}
            </code>
            <Button variant="outline" size="sm" onClick={copy}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
          </div>
          <Button variant="ghost" size="sm" className="mt-1.5" onClick={() => setFresh(null)}>
            {t('apiKeys.hide')}
          </Button>
        </div>
      )}

      {/* Пустой список без объяснения читается как поломка: человек не
          понимает, вебхуков нет или они не загрузились. */}
      {hooks.data && !hooks.data.items.length && (
        <p className="mt-3 rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
          {t('webhooks.empty')}
        </p>
      )}

      <ul className="mt-3 space-y-2">
        {(hooks.data?.items ?? []).map((w) => (
          <li key={w.id} className="flex items-center gap-3 rounded-lg border px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-xs">{w.url}</span>
              <span className="text-xs text-muted-foreground">
                {w.events.length ? w.events.join(', ') : t('webhooks.allEvents')}
                {/* Последняя ошибка на виду: сломанный вебхук молчит, и без
                    этой строки о поломке узнают, когда разойдутся цифры. */}
                {w.lastError && <span className="ms-2 text-destructive">· {w.lastError}</span>}
              </span>
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:text-destructive"
              onClick={async () => {
                if (await confirm({ title: t('webhooks.deleteConfirm'), destructive: true, confirmLabel: t('files.delete') }))
                  remove.mutate(w.id)
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          </li>
        ))}
      </ul>

      {creating ? (
        <div className="mt-3 space-y-3 rounded-lg border p-3">
          <Input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://atlas.example.com/hooks/chatick"
            spellCheck={false}
          />
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('webhooks.events')}</p>
            <div className="flex flex-wrap gap-2">
              {EVENTS.map((ev) => (
                <button
                  key={ev}
                  onClick={() => setEvents((p) => (p.includes(ev) ? p.filter((x) => x !== ev) : [...p, ev]))}
                  className={cn(
                    'rounded-full border px-3 py-1 font-mono text-xs transition-colors',
                    events.includes(ev) ? 'border-brand bg-brand/10' : 'text-muted-foreground hover:bg-accent',
                  )}
                >
                  {ev}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{t('webhooks.eventsHint')}</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="brand" size="sm" disabled={!url.trim() || create.isPending} onClick={() => create.mutate()}>
              {t('webhooks.add')}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" className="mt-3" onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          {t('webhooks.add')}
        </Button>
      )}
    </section>
  )
}
