import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { History, RotateCcw, Search, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// История действий + Корзина (SPEC §8.21).
type Activity = {
  id: string
  action: string
  entityType: string
  entityLabel: string
  createdAt: string
  actor: { id: string; name: string; avatarUrl: string | null } | null
}
type TrashItem = { id: string; number?: string; name?: string; title?: string; deletedAt: string; deletedBy: { id: string; name: string; avatarUrl: string | null } | null }
type Member = { user: { id: string; name: string; email: string; avatarUrl: string | null } }

const ENTITY_TYPES = ['task', 'resource', 'file', 'comment', 'sprint', 'member'] as const
const ACTIONS = ['create', 'update', 'delete', 'restore', 'status', 'assign'] as const

export function HistoryTab({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const { t, i18n } = useTranslation()
  const [tab, setTab] = useState<'activity' | 'trash'>('activity')

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <History className="size-5" />
          {t('history.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('history.subtitle')}</p>
      </div>

      <div className="inline-flex overflow-hidden rounded-md border text-sm">
        <button
          onClick={() => setTab('activity')}
          className={cn('px-3 py-1.5 transition-colors', tab === 'activity' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary')}
        >
          {t('history.activity')}
        </button>
        <button
          onClick={() => setTab('trash')}
          className={cn('px-3 py-1.5 transition-colors', tab === 'trash' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary')}
        >
          {t('history.trash')}
        </button>
      </div>

      {tab === 'activity' ? <ActivityFeed projectId={projectId} lang={i18n.language} /> : <TrashView projectId={projectId} isAdmin={isAdmin} lang={i18n.language} />}
    </div>
  )
}

function ActivityFeed({ projectId, lang }: { projectId: string; lang: string }) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [entityType, setEntityType] = useState<string>('')
  const [action, setAction] = useState<string>('')
  const [actorId, setActorId] = useState<string>('')

  const members = useQuery({ queryKey: ['project-members', projectId], queryFn: () => api<Member[]>(`/api/v1/projects/${projectId}/members`) })

  const qs = new URLSearchParams()
  if (q.trim()) qs.set('q', q.trim())
  if (entityType) qs.set('entityType', entityType)
  if (action) qs.set('action', action)
  if (actorId) qs.set('actorId', actorId)

  const feed = useQuery({
    queryKey: ['activity', projectId, q, entityType, action, actorId],
    queryFn: () => api<{ items: Activity[]; hasMore: boolean }>(`/api/v1/activity?${qs.toString()}`, {}, 'project'),
  })

  const chip = 'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors'
  const hasFilters = q || entityType || action || actorId

  return (
    <div className="space-y-3">
      {/* Фильтры и поиск — один ряд.
          Поиск не в общем потоке flex-wrap, а отдельной колонкой справа:
          в общем ряду его выдавливало вниз, стоило добавить ещё фильтр.
          На узком экране колонки складываются, и поиск идёт во всю ширину. */}
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
        <div className="flex flex-wrap items-center gap-1.5">
          <Select value={entityType || 'all'} onValueChange={(v) => setEntityType(v === 'all' ? '' : v)}>
            <SelectTrigger className="h-8 w-auto min-w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('history.allTypes')}</SelectItem>
              {ENTITY_TYPES.map((et) => (
                <SelectItem key={et} value={et}>
                  {t(`history.entity.${et}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={action || 'all'} onValueChange={(v) => setAction(v === 'all' ? '' : v)}>
            <SelectTrigger className="h-8 w-auto min-w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('history.allActions')}</SelectItem>
              {ACTIONS.map((a) => (
                <SelectItem key={a} value={a}>
                  {t(`history.action.${a}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={actorId || 'all'} onValueChange={(v) => setActorId(v === 'all' ? '' : v)}>
            <SelectTrigger className="h-8 w-auto min-w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('history.allActors')}</SelectItem>
              {(members.data ?? []).map((m) => (
                <SelectItem key={m.user.id} value={m.user.id}>
                  {m.user.name || m.user.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {hasFilters && (
            <button onClick={() => { setQ(''); setEntityType(''); setAction(''); setActorId('') }} className={cn(chip, 'text-muted-foreground hover:text-foreground')}>
              {t('tasks.resetFilters')}
            </button>
          )}
        </div>

        <div className="relative w-full shrink-0 sm:ms-auto sm:w-56">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('history.search')} className="h-8 ps-8 text-xs" />
        </div>
      </div>

      {/* Лента */}
      <ul className="space-y-1">
        {feed.isLoading && <p className="text-sm text-muted-foreground">…</p>}
        {(feed.data?.items ?? []).map((a) => (
          <li key={a.id} className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2 text-sm">
            <Avatar name={a.actor?.name ?? 'AI'} src={a.actor?.avatarUrl} size={22} />
            <span className="min-w-0 flex-1">
              <span className="font-medium">{a.actor?.name ?? t('history.ai')}</span>{' '}
              <span className="text-muted-foreground">{t(`history.action.${a.action}`, { defaultValue: a.action })}</span>{' '}
              <span className="text-muted-foreground">{t(`history.entity.${a.entityType}`, { defaultValue: a.entityType })}</span>
              {a.entityLabel && <span className="ms-1 truncate">— {a.entityLabel}</span>}
            </span>
            <span className="whitespace-nowrap text-xs text-muted-foreground">{new Date(a.createdAt).toLocaleString(lang)}</span>
          </li>
        ))}
        {feed.data && feed.data.items.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t('history.empty')}</p>}
      </ul>
    </div>
  )
}

function TrashView({ projectId, isAdmin, lang }: { projectId: string; isAdmin: boolean; lang: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const onErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

  const tasks = useQuery({ queryKey: ['trash-tasks', projectId], queryFn: () => api<TrashItem[]>('/api/v1/tasks/trash', {}, 'project') })
  const filesT = useQuery({ queryKey: ['trash-files', projectId], queryFn: () => api<TrashItem[]>('/api/v1/files/trash', {}, 'project').catch(() => [] as TrashItem[]) })
  const resources = useQuery({
    queryKey: ['trash-resources', projectId],
    queryFn: () => api<TrashItem[]>('/api/v1/resources/trash', {}, 'project').catch(() => [] as TrashItem[]),
    enabled: isAdmin,
  })

  const restoreFile = useMutation({
    mutationFn: (id: string) => api(`/api/v1/files/${id}/restore`, { method: 'POST' }, 'project'),
    onSuccess: () => {
      toast.success(t('history.restored'))
      qc.invalidateQueries({ queryKey: ['trash-files', projectId] })
      qc.invalidateQueries({ queryKey: ['files', projectId] })
    },
    onError: onErr,
  })

  const restoreTask = useMutation({
    mutationFn: (id: string) => api(`/api/v1/tasks/${id}/restore`, { method: 'POST' }, 'project'),
    onSuccess: () => {
      toast.success(t('history.restored'))
      qc.invalidateQueries({ queryKey: ['trash-tasks', projectId] })
      qc.invalidateQueries({ queryKey: ['tasks', projectId] })
    },
    onError: onErr,
  })
  const restoreResource = useMutation({
    mutationFn: (id: string) => api(`/api/v1/resources/${id}/restore`, { method: 'POST' }, 'project'),
    onSuccess: () => {
      toast.success(t('history.restored'))
      qc.invalidateQueries({ queryKey: ['trash-resources', projectId] })
    },
    onError: onErr,
  })

  const Row = ({ label, item, onRestore }: { label: string; item: TrashItem; onRestore: () => void }) => (
    <li className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2 text-sm">
      <Trash2 className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {item.deletedBy && (
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
          <Avatar name={item.deletedBy.name} src={item.deletedBy.avatarUrl} size={16} />
          {item.deletedBy.name}
        </span>
      )}
      <span className="whitespace-nowrap text-xs text-muted-foreground">{new Date(item.deletedAt).toLocaleDateString(lang)}</span>
      <Button variant="outline" size="sm" onClick={onRestore}>
        <RotateCcw className="size-3.5" />
        {t('history.restore')}
      </Button>
    </li>
  )

  const empty = (tasks.data?.length ?? 0) === 0 && (resources.data?.length ?? 0) === 0 && (filesT.data?.length ?? 0) === 0

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{t('history.trashNote')}</p>
      {tasks.data && tasks.data.length > 0 && (
        <section className="space-y-1">
          <h3 className="text-sm font-semibold">{t('tabs.tasks')}</h3>
          <ul className="space-y-1">
            {tasks.data.map((it) => (
              <Row key={it.id} item={it} label={`${it.number ?? ''} ${it.title ?? ''}`.trim()} onRestore={() => restoreTask.mutate(it.id)} />
            ))}
          </ul>
        </section>
      )}
      {filesT.data && filesT.data.length > 0 && (
        <section className="space-y-1">
          <h3 className="text-sm font-semibold">{t('tabs.files')}</h3>
          <ul className="space-y-1">
            {filesT.data.map((it) => (
              <Row key={it.id} item={it} label={it.name ?? ''} onRestore={() => restoreFile.mutate(it.id)} />
            ))}
          </ul>
        </section>
      )}
      {isAdmin && resources.data && resources.data.length > 0 && (
        <section className="space-y-1">
          <h3 className="text-sm font-semibold">{t('tabs.resources')}</h3>
          <ul className="space-y-1">
            {resources.data.map((it) => (
              <Row key={it.id} item={it} label={it.name ?? ''} onRestore={() => restoreResource.mutate(it.id)} />
            ))}
          </ul>
        </section>
      )}
      {empty && <p className="py-6 text-center text-sm text-muted-foreground">{t('history.trashEmpty')}</p>}
    </div>
  )
}
