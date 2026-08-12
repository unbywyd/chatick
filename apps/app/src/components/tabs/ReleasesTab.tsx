import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowRight, ExternalLink, Package, Plus, Rocket, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'

// Версии проекта (SPEC §8.46).
//
// Экран отвечает на вопрос, который сейчас задают голосом: «какая версия в
// проде». Поэтому сводка стоит первой и читается без прокрутки, а список —
// уже под ней.

type Stage = { key: string; label: string; live?: boolean }
type BuildTypeDef = { key: string; label: string; stages: Stage[] }

type Release = {
  id: string
  version: string
  buildType: string
  buildTypeLabel: string
  status: string
  statusLabel: string
  isLive: boolean
  owner: { id: string; name: string; avatarUrl: string | null } | null
  referenceUrl: string | null
  notes: string | null
  releasedAt: string | null
  tasks: { id: string; number: string; title: string; status: string }[]
  createdAt: string
}

type ReleaseEvent = {
  id: string
  status: string
  fromStatus: string | null
  statusLabel: string
  comment: string
  actor: { id: string; name: string; avatarUrl: string | null } | null
  createdAt: string
}

export function ReleasesTab({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const list = useQuery({
    queryKey: ['releases', projectId],
    queryFn: () => api<{ items: Release[]; live: Record<string, { version: string; id: string }> }>('/releases', {}, 'project'),
  })
  const types = useQuery({
    queryKey: ['release-build-types', projectId],
    queryFn: () => api<{ buildTypes: BuildTypeDef[] }>('/releases/build-types', {}, 'project'),
    // Лестницы зашиты в код сервера и между запросами не меняются.
    staleTime: Infinity,
  })

  const byType = useMemo(() => new Map((types.data?.buildTypes ?? []).map((b) => [b.key, b])), [types.data])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
        <h2 className="text-sm font-semibold">{t('releases.title')}</h2>
        {canManage && (
          <Button size="sm" className="gap-1" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" />
            {t('releases.create')}
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {/* Сводка — то, ради чего открывают вкладку. Пустая не рисуется:
            рамка с надписью «пока ничего» отвечает не на тот вопрос. */}
        {Object.keys(list.data?.live ?? {}).length > 0 && (
          <div className="mb-4 rounded-lg border bg-brand/5 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <Rocket className="size-3.5" />
              {t('releases.liveNow')}
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {Object.entries(list.data!.live).map(([type, info]) => (
                <button
                  key={type}
                  onClick={() => setOpenId(info.id)}
                  className="text-start transition-opacity hover:opacity-70"
                >
                  <div className="text-[11px] text-muted-foreground">{byType.get(type)?.label ?? type}</div>
                  <div className="text-sm font-semibold">{info.version}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {list.isLoading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
        ) : !list.data?.items.length ? (
          <div className="py-10 text-center">
            <Package className="mx-auto mb-2 size-8 text-muted-foreground/40" />
            <div className="text-sm text-muted-foreground">{t('releases.empty')}</div>
          </div>
        ) : (
          <div className="space-y-2">
            {list.data.items.map((r) => (
              <ReleaseRow key={r.id} release={r} onOpen={() => setOpenId(r.id)} locale={i18n.language} />
            ))}
          </div>
        )}
      </div>

      {creating && (
        <CreateDialog
          projectId={projectId}
          buildTypes={types.data?.buildTypes ?? []}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false)
            void qc.invalidateQueries({ queryKey: ['releases', projectId] })
          }}
        />
      )}
      {openId && (
        <DetailsDialog
          projectId={projectId}
          releaseId={openId}
          canManage={canManage}
          buildTypes={types.data?.buildTypes ?? []}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  )
}

function ReleaseRow({ release: r, onOpen, locale }: { release: Release; onOpen: () => void; locale: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors hover:border-brand/50">
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-start">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{r.version}</span>
            <span className="rounded bg-secondary px-1.5 py-0.5 text-[11px] text-secondary-foreground">
              {r.buildTypeLabel}
            </span>
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[11px]',
                // Конечная стадия выделена: на ней держится ответ «что в проде».
                r.isLive ? 'bg-brand text-brand-foreground font-medium' : 'bg-muted text-muted-foreground',
              )}
            >
              {r.statusLabel}
            </span>
          </div>
          {r.notes && <div className="mt-0.5 line-clamp-1 break-all text-xs text-muted-foreground">{r.notes}</div>}
          {/* Связанные задачи: видно, что закрывать, без перехода внутрь. */}
          {r.tasks.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {r.tasks.map((task) => (
                <span key={task.id} className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground">
                  {task.number}
                </span>
              ))}
            </div>
          )}
        </div>
      </button>

      <div className="flex shrink-0 items-center gap-2">
        {r.releasedAt && (
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            {new Date(r.releasedAt).toLocaleDateString(locale)}
          </span>
        )}
        {r.referenceUrl && (
          <a
            href={r.referenceUrl}
            target="_blank"
            rel="noreferrer noopener"
            title={t('releases.reference')}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
        {r.owner && <Avatar name={r.owner.name} src={r.owner.avatarUrl} size={22} />}
      </div>
    </div>
  )
}

function CreateDialog({
  projectId,
  buildTypes,
  onClose,
  onDone,
}: {
  projectId: string
  buildTypes: BuildTypeDef[]
  onClose: () => void
  onDone: () => void
}) {
  const { t } = useTranslation()
  const [version, setVersion] = useState('')
  const [type, setType] = useState(buildTypes[0]?.key ?? 'other')
  const [referenceUrl, setReferenceUrl] = useState('')
  const [notes, setNotes] = useState('')

  const create = useMutation({
    mutationFn: () =>
      api<Release>(
        '/releases',
        {
          method: 'POST',
          body: JSON.stringify({
            version: version.trim(),
            buildType: type,
            referenceUrl: referenceUrl.trim() || null,
            notes: notes.trim() || null,
          }),
        },
        'project',
      ),
    onSuccess: onDone,
    onError: (e: { message?: string }) => toast.error(e.message || t('common.error')),
  })

  return (
    <Overlay onClose={onClose} title={t('releases.create')}>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">{t('releases.version')}</label>
          <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.4.0" autoFocus />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">{t('releases.buildType')}</label>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {buildTypes.map((b) => (
                <SelectItem key={b.key} value={b.key}>
                  {b.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">{t('releases.reference')}</label>
          <Input value={referenceUrl} onChange={(e) => setReferenceUrl(e.target.value)} placeholder="https://…" />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">{t('releases.notes')}</label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('releases.notesHint')} />
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button disabled={!version.trim() || create.isPending} onClick={() => create.mutate()}>
          {t('releases.create')}
        </Button>
      </div>
    </Overlay>
  )
}

function DetailsDialog({
  projectId,
  releaseId,
  canManage,
  buildTypes,
  onClose,
}: {
  projectId: string
  releaseId: string
  canManage: boolean
  buildTypes: BuildTypeDef[]
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const [nextStage, setNextStage] = useState('')
  const [comment, setComment] = useState('')

  const one = useQuery({
    queryKey: ['release', releaseId],
    queryFn: () => api<Release & { events: ReleaseEvent[] }>(`/releases/${releaseId}`, {}, 'project'),
  })

  const stages = buildTypes.find((b) => b.key === one.data?.buildType)?.stages ?? []

  const move = useMutation({
    mutationFn: () =>
      api<Release>(
        `/releases/${releaseId}/stage`,
        { method: 'POST', body: JSON.stringify({ status: nextStage, comment: comment.trim() }) },
        'project',
      ),
    onSuccess: () => {
      setNextStage('')
      setComment('')
      void qc.invalidateQueries({ queryKey: ['release', releaseId] })
      void qc.invalidateQueries({ queryKey: ['releases', projectId] })
    },
    onError: (e: { message?: string }) => toast.error(e.message || t('common.error')),
  })

  return (
    <Overlay onClose={onClose} title={one.data ? `${one.data.version} · ${one.data.buildTypeLabel}` : '…'}>
      {one.isLoading || !one.data ? (
        <div className="py-8 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'rounded px-2 py-0.5 text-xs',
                one.data.isLive ? 'bg-brand font-medium text-brand-foreground' : 'bg-muted text-muted-foreground',
              )}
            >
              {one.data.statusLabel}
            </span>
            {one.data.referenceUrl && (
              <a
                href={one.data.referenceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-xs text-brand-ink hover:underline"
              >
                <ExternalLink className="size-3" />
                {t('releases.reference')}
              </a>
            )}
          </div>

          {one.data.notes && <p className="whitespace-pre-wrap break-words text-sm">{one.data.notes}</p>}

          {one.data.tasks.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-semibold text-muted-foreground">{t('releases.linkedTasks')}</div>
              <div className="space-y-1">
                {one.data.tasks.map((task) => (
                  <div key={task.id} className="flex items-center gap-2 text-sm">
                    <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[11px]">{task.number}</span>
                    <span className="line-clamp-1 break-all">{task.title}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Смена стадии. Комментарий обязателен — кнопка до него не активна:
              иначе человек упрётся в отказ сервера уже после нажатия. */}
          {canManage && (
            <div className="rounded-lg border p-3">
              <div className="mb-2 text-xs font-semibold text-muted-foreground">{t('releases.moveStage')}</div>
              <div className="space-y-2">
                <Select value={nextStage} onValueChange={setNextStage}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('releases.pickStage')} />
                  </SelectTrigger>
                  <SelectContent>
                    {stages
                      .filter((s) => s.key !== one.data!.status)
                      .map((s) => (
                        <SelectItem key={s.key} value={s.key}>
                          {s.label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <Input
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder={t('releases.commentRequired')}
                />
                <Button
                  size="sm"
                  className="w-full"
                  disabled={!nextStage || !comment.trim() || move.isPending}
                  onClick={() => move.mutate()}
                >
                  {t('releases.moveStage')}
                </Button>
              </div>
            </div>
          )}

          <div>
            <div className="mb-2 text-xs font-semibold text-muted-foreground">{t('releases.history')}</div>
            <div className="space-y-2">
              {one.data.events.map((e) => (
                <div key={e.id} className="flex gap-2 text-xs">
                  {e.actor && <Avatar name={e.actor.name} src={e.actor.avatarUrl} size={20} />}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1 text-muted-foreground">
                      {e.fromStatus && (
                        <>
                          <span>{stages.find((s) => s.key === e.fromStatus)?.label ?? e.fromStatus}</span>
                          <ArrowRight className="size-3" />
                        </>
                      )}
                      <span className="font-medium text-foreground">{e.statusLabel}</span>
                      <span>· {new Date(e.createdAt).toLocaleString(i18n.language)}</span>
                    </div>
                    <div className="break-words">{e.comment}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Overlay>
  )
}

function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border bg-card p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
