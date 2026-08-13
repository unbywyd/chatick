import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { ArrowLeft, ArrowRight, Check, ExternalLink, Link2, Pencil, Rocket } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Combobox } from '@/components/ui/combobox'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckItem,
} from '@/components/ui/dropdown-menu'

// Страница версии: что это, где сейчас и как сюда пришло.
//
// Отдельной страницей, а не окном: лента стадий с комментариями — главное, что
// у версии есть. «Почему 1.4 неделю висит в ревью» читается по ней, и в
// модалке, которую закрывают одним кликом мимо, этому тесно. Плюс страницей
// можно поделиться — у окна нет своего адреса.

type StageTone = 'neutral' | 'testing' | 'waiting' | 'live'
type Stage = { key: string; label: string; live?: boolean; hint?: string; tone?: StageTone }

/** Те же цвета, что в списке: тон приходит с сервера, один на всю систему. */
const STAGE_TONE: Record<StageTone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  testing: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200',
  waiting: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  live: 'bg-brand font-medium text-brand-foreground',
}
function toneOf(stages: Stage[], key: string, isLive = false): string {
  const tone = stages.find((s) => s.key === key)?.tone
  return STAGE_TONE[tone ?? (isLive ? 'live' : 'neutral')]
}

/** Те же три профиля, что и в диалогах: список один, чтобы не разошёлся. */
const BUILD_PROFILES = ['development', 'preview', 'production'] as const

type ReleaseDetails = {
  id: string
  version: string
  appName: string | null
  buildType: string
  buildTypeLabel: string
  status: string
  statusLabel: string
  isLive: boolean
  owner: { id: string; name: string; avatarUrl: string | null } | null
  buildProfile: string | null
  referenceUrl: string | null
  notes: string | null
  releasedAt: string | null
  createdAt: string
  tasks: { id: string; number: string; title: string; status: string }[]
  events: {
    id: string
    status: string
    fromStatus: string | null
    statusLabel: string
    comment: string
    actor: { id: string; name: string; avatarUrl: string | null } | null
    createdAt: string
  }[]
}

/**
 * Подпись стадии на языке интерфейса.
 *
 * Сервер присылает английскую — она годится как запасная, но человеку,
 * работающему на иврите, «Waiting for Apple review» ничего не объясняет.
 * Ключи общие для всех платформ: building у всех одинаков.
 */
function useStageLabel() {
  const { t } = useTranslation()
  return (key: string, fallback: string) => t(`releases.stage.${key}`, { defaultValue: fallback })
}

/** Служебные комментарии ленты сервер хранит ключом: переводим их здесь. */
function useEventComment() {
  const { t } = useTranslation()
  return (raw: string) => {
    if (raw === '@created') return t('releases.eventCreated')
    const req = /^@requested:(.+)$/.exec(raw)
    if (req) return t('releases.eventRequested', { task: req[1] })
    return raw
  }
}

export function ReleasePage({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const { t, i18n } = useTranslation()
  const stageLabel = useStageLabel()
  const eventComment = useEventComment()
  const { companyId, id: routeProjectId, releaseId } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [nextStage, setNextStage] = useState('')
  const [comment, setComment] = useState('')
  const [copied, setCopied] = useState(false)

  const one = useQuery({
    queryKey: ['release', releaseId],
    queryFn: () => api<ReleaseDetails>(`/api/v1/releases/${releaseId}`, {}, 'project'),
    enabled: Boolean(releaseId),
  })
  const types = useQuery({
    queryKey: ['release-build-types', projectId],
    queryFn: () => api<{ buildTypes: { key: string; label: string; stages: Stage[] }[] }>(
      '/api/v1/releases/build-types',
      {},
      'project',
    ),
    staleTime: Infinity,
  })

  const stages = types.data?.buildTypes.find((b) => b.key === one.data?.buildType)?.stages ?? []
  const back = `/c/${companyId}/p/${routeProjectId}/releases`

  const move = useMutation({
    mutationFn: () =>
      api(
        `/api/v1/releases/${releaseId}/stage`,
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

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/v1/releases/${releaseId}`, { method: 'PATCH', body: JSON.stringify(body) }, 'project'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['release', releaseId] })
      void qc.invalidateQueries({ queryKey: ['releases', projectId] })
    },
    onError: (e: { message?: string }) => toast.error(e.message || t('common.error')),
  })

  /** Короткая ссылка: ею и делятся, длинный адрес для этого не годится. */
  const share = useMutation({
    mutationFn: () => api<{ url: string | null }>(`/api/v1/shares/short-release/${releaseId}`),
    onSuccess: async (r) => {
      const url = r.url ?? `${location.origin}/#${back}/${releaseId}`
      await navigator.clipboard.writeText(url).catch(() => {})
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      toast.success(url)
    },
    onError: (e: { message?: string }) => toast.error(e.message || t('common.error')),
  })

  if (one.isLoading) return <div className="p-6 text-sm text-muted-foreground">{t('common.loading')}</div>
  if (one.isError || !one.data) {
    return <div className="p-6 text-sm text-muted-foreground">{t('releases.notFound')}</div>
  }
  const r = one.data

  return (
    <div className="mx-auto max-w-3xl p-4">
      <button
        onClick={() => navigate(back)}
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {t('releases.title')}
      </button>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">
          {r.appName ? `${r.appName} ${r.version}` : r.version}
        </h1>
        <span className="rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">{r.buildTypeLabel}</span>
        <span className={cn('rounded px-2 py-0.5 text-xs', toneOf(stages, r.status, r.isLive))}>
          {stageLabel(r.status, r.statusLabel)}
        </span>
        <div className="ms-auto flex items-center gap-2">
          <Button size="sm" variant="outline" className="gap-1" onClick={() => share.mutate()}>
            {copied ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
            {t('releases.copyLink')}
          </Button>
          {r.owner && <Avatar name={r.owner.name} src={r.owner.avatarUrl} size={26} />}
        </div>
      </div>

      {/* Дорожка стадий: где версия сейчас и что осталось. Пройденное отмечено,
          и по ней видно путь целиком, а не только текущую точку. */}
      <div className="mb-4 flex flex-wrap items-center gap-1 rounded-lg border p-3">
        {stages.map((s, i) => {
          const at = stages.findIndex((x) => x.key === r.status)
          const done = i < at
          const here = s.key === r.status
          return (
            <span key={s.key} className="inline-flex items-center gap-1">
              {i > 0 && <ArrowRight className="size-3 text-muted-foreground/50" />}
              <span
                title={s.hint}
                className={cn(
                  'rounded px-2 py-0.5 text-xs',
                  // Текущая — своим цветом; пройденные приглушены, будущие
                  // бледные: по дорожке видно и путь, и где мы на нём.
                  here
                    ? cn('font-medium', toneOf(stages, s.key, s.live))
                    : done
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground',
                )}
              >
                {stageLabel(s.key, s.label)}
              </span>
            </span>
          )
        })}
      </div>

      <dl className="mb-4 grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border p-3 text-sm sm:grid-cols-2">
        <Row label={t('releases.releasedAt')}>
          {r.releasedAt ? new Date(r.releasedAt).toLocaleString(i18n.language) : '—'}
        </Row>
        <Row label={t('releases.createdAt')}>{new Date(r.createdAt).toLocaleString(i18n.language)}</Row>
        <Row label={t('releases.reference')}>
          <div className="flex items-center gap-2">
            {r.referenceUrl ? (
              <a
                href={r.referenceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex min-w-0 items-center gap-1 text-brand-ink hover:underline"
              >
                <ExternalLink className="size-3 shrink-0" />
                <span className="truncate">{r.referenceUrl}</span>
              </a>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
            {canManage && (
              <EditPopover
                title={t('releases.reference')}
                value={r.referenceUrl ?? ''}
                placeholder="https://…"
                onSave={(v) => patch.mutate({ referenceUrl: v.trim() || null })}
              />
            )}
          </div>
        </Row>
        <Row label={t('releases.buildProfile')}>
          <div className="flex items-center gap-2">
            <span className={cn(!r.buildProfile && 'text-muted-foreground')}>
              {r.buildProfile ? t(`releases.profile.${r.buildProfile}`, { defaultValue: r.buildProfile }) : '—'}
            </span>
            {/* Список, а не свободный ввод: профилей ровно три, и «prod»
                вместо «production» разошлось бы со столбцом в таблице. */}
            {canManage && (
              <EditChoice
                value={r.buildProfile ?? ''}
                options={BUILD_PROFILES.map((p) => ({
                  value: p,
                  label: t(`releases.profile.${p}`, { defaultValue: p }),
                }))}
                clearLabel={t('releases.profileNone')}
                onSave={(v) => patch.mutate({ buildProfile: v || null })}
              />
            )}
          </div>
        </Row>
        <Row label={t('releases.owner')}>
          {r.owner ? (
            <span className="inline-flex items-center gap-1.5">
              <Avatar name={r.owner.name} src={r.owner.avatarUrl} size={20} />
              <span className="truncate">{r.owner.name}</span>
            </span>
          ) : (
            '—'
          )}
        </Row>
      </dl>

      <section className="mb-4 rounded-lg border p-3">
        <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
          {t('releases.notes')}
          {canManage && (
            <EditPopover
              title={t('releases.notes')}
              value={r.notes ?? ''}
              onSave={(v) => patch.mutate({ notes: v.trim() || null })}
            />
          )}
        </div>
        <p className="whitespace-pre-wrap break-words text-sm">
          {r.notes || <span className="text-muted-foreground">—</span>}
        </p>
      </section>

      {r.tasks.length > 0 && (
        <section className="mb-4 rounded-lg border p-3">
          <div className="mb-2 text-xs font-semibold text-muted-foreground">{t('releases.linkedTasks')}</div>
          <div className="space-y-1">
            {r.tasks.map((task) => (
              <button
                key={task.id}
                onClick={() => navigate(`/c/${companyId}/p/${routeProjectId}/tasks/${task.id}`)}
                className="flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-start text-sm transition-colors hover:border-brand hover:text-brand-ink"
              >
                <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[11px] text-secondary-foreground">
                  {task.number}
                </span>
                <span className="truncate">{task.title}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {canManage && (
        <section className="mb-4 rounded-lg border p-3">
          <div className="mb-2 text-xs font-semibold text-muted-foreground">{t('releases.moveStage')}</div>
          <div className="flex flex-wrap gap-2">
            <div className="min-w-40 flex-1">
              <Combobox
                options={stages
                  .filter((s) => s.key !== r.status)
                  .map((s) => ({ value: s.key, label: stageLabel(s.key, s.label), hint: s.hint }))}
                value={nextStage}
                onChange={setNextStage}
                placeholder={t('releases.pickStage')}
              />
            </div>
            <Input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={t('releases.commentRequired')}
              className="min-w-48 flex-[2]"
            />
            <Button disabled={!nextStage || !comment.trim() || move.isPending} onClick={() => move.mutate()}>
              {t('releases.moveStage')}
            </Button>
          </div>
        </section>
      )}

      {/* Лента: что когда произошло и почему. Ради неё страница и нужна. */}
      <section>
        <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <Rocket className="size-3.5" />
          {t('releases.history')}
        </div>
        <ol className="space-y-3 border-s ps-4">
          {r.events.map((e) => (
            <li key={e.id} className="relative">
              <span className="absolute -start-[21px] top-1.5 size-2 rounded-full bg-brand" />
              <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                {e.fromStatus && (
                  <>
                    <span>{stageLabel(e.fromStatus, stages.find((s) => s.key === e.fromStatus)?.label ?? e.fromStatus)}</span>
                    <ArrowRight className="size-3" />
                  </>
                )}
                <span className="font-medium text-foreground">{stageLabel(e.status, e.statusLabel)}</span>
                <span>· {new Date(e.createdAt).toLocaleString(i18n.language)}</span>
                {e.actor && (
                  <span className="inline-flex items-center gap-1">
                    · <Avatar name={e.actor.name} src={e.actor.avatarUrl} size={16} />
                    {e.actor.name}
                  </span>
                )}
              </div>
              <p className="whitespace-pre-wrap break-words text-sm">{eventComment(e.comment)}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      {/* Без truncate на самом dd: overflow:hidden срезает кольцо фокуса у
          поля, которое здесь раскрывается. Длинный текст обрезаем внутри. */}
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function EditPopover({
  title,
  value,
  placeholder,
  onSave,
}: {
  title: string
  value: string
  placeholder?: string
  onSave: (next: string) => void
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  if (!editing) {
    return (
      <button
        title={t('common.edit')}
        onClick={() => {
          setDraft(value)
          setEditing(true)
        }}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <Pencil className="size-3" />
      </button>
    )
  }
  return (
    <span className="inline-flex items-center gap-1">
      <Input
        value={draft}
        placeholder={placeholder}
        autoFocus
        className="h-7 text-sm"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onSave(draft)
            setEditing(false)
          }
          if (e.key === 'Escape') setEditing(false)
        }}
      />
      <Button
        size="sm"
        className="h-7"
        onClick={() => {
          onSave(draft)
          setEditing(false)
        }}
      >
        {t('common.save')}
      </Button>
      <Button size="sm" variant="ghost" className="h-7" onClick={() => setEditing(false)}>
        {t('common.cancel')}
      </Button>
    </span>
  )
}

/**
 * Выбор из готового списка прямо в строке.
 *
 * Отдельно от EditPopover: там свободный текст (ссылка, заметки), здесь —
 * закрытый набор. Ввод руками означал бы «prod» у одного и «production» у
 * другого, а по этому полю потом сортируют и фильтруют.
 */
function EditChoice({
  value,
  options,
  clearLabel,
  onSave,
}: {
  value: string
  options: { value: string; label: string }[]
  clearLabel: string
  onSave: (next: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button title={t('common.edit')} className="shrink-0 text-muted-foreground hover:text-foreground">
          <Pencil className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((o) => (
          <DropdownMenuCheckItem key={o.value} checked={o.value === value} onSelect={() => onSave(o.value)}>
            {o.label}
          </DropdownMenuCheckItem>
        ))}
        <DropdownMenuCheckItem checked={!value} onSelect={() => onSave('')}>
          {clearLabel}
        </DropdownMenuCheckItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
