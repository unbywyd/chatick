import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Link as LinkIcon,
  MessagesSquare,
  Pencil,
  Plus,
  ScrollText,
  Search,
  Trash2,
  X,
  Share2,
} from 'lucide-react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ShareDialog } from '@/components/ShareDialog'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { DragHandle } from '@/components/ui/drag-handle'
import { useConfirm } from '@/components/ui/confirm'
import { DbConnections } from './DbConnections'

type ResourceRow = {
  id: string
  name: string
  url: string | null
  /** og:image или favicon сайта — ссылку в списке узнают по значку. */
  icon: string | null
  description: string
  source: 'manual' | 'chat'
  messageId: string | null
  secretCount: number
  creator: { id: string; name: string } | null
  createdAt: string
}
type ResourceDetail = { id: string; name: string; url: string | null; description: string; secrets: { id: string; label: string }[] }

// Таб «Ресурсы» (SPEC §8.1): ссылка + описание + опциональные секреты
export function ResourcesTab({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<ResourceRow | 'new' | null>(null)
  const { resourceId, companyId } = useParams()
  // ?create=1 — просьба открыть форму сразу: так сюда приходит горячая клавиша,
  // которой всё равно, смонтирована ли вкладка.
  const [params, setParams] = useSearchParams()
  useEffect(() => {
    if (params.get('create') !== '1') return
    setEditing('new')
    const next = new URLSearchParams(params)
    next.delete('create')
    setParams(next, { replace: true })
  }, [params, setParams])
  const [sharing, setSharing] = useState<ResourceRow | null>(null)
  const [showAudit, setShowAudit] = useState(false)

  const list = useQuery({ queryKey: ['resources', projectId], queryFn: () => api<ResourceRow[]>('/api/v1/resources', {}, 'project') })

  const filtered = useMemo(() => {
    const rows = list.data ?? []
    const needle = q.trim().toLowerCase()
    return needle ? rows.filter((r) => r.name.toLowerCase().includes(needle) || r.url?.toLowerCase().includes(needle)) : rows
  }, [list.data, q])

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/resources/${id}`, { method: 'DELETE' }, 'project'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['resources', projectId] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  return (
    <>
    <div className="mx-auto w-full max-w-6xl p-6">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('resources.search')} className="ps-9" />
        </div>
        {isAdmin && (
          <Button variant="outline" onClick={() => setShowAudit((v) => !v)}>
            <ScrollText className="size-4" />
            {t('creds.audit')}
          </Button>
        )}
        <Button variant="brand" onClick={() => setEditing('new')}>
          <Plus className="size-4" />
          {t('resources.add')}
        </Button>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">{t('resources.note')}</p>

      {showAudit && isAdmin && <AuditLog projectId={projectId} onClose={() => setShowAudit(false)} />}
      {editing && (
        <ResourceForm
          projectId={projectId}
          editing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}

      <ul className="mt-4 space-y-1.5">
        {list.isLoading && <p className="text-sm text-muted-foreground">…</p>}
        {/* редактируемый ресурс скрыт: его заменяет форма выше, иначе одна
            и та же запись видна дважды и это путает */}
        {filtered
          .filter((r) => !(editing && editing !== 'new' && editing.id === r.id))
          .map((r) => (
          <li
            key={r.id}
            id={`resource-${r.id}`}
            draggable
            onDragStart={(e) => {
              // copy — иначе браузер считает, что бросать некуда, и рисует
              // курсор запрета до самого композера.
              e.dataTransfer.effectAllowed = 'copy'
              e.dataTransfer.setData('application/x-chatick-resource', JSON.stringify({ id: r.id, name: r.name }))
            }}
            // Прямая ссылка подсвечивает нужный ресурс: список бывает длинным,
            // и «вот он, где-то здесь» — плохой ответ на присланную ссылку.
            className={cn(
              'group rounded-lg border bg-card px-3 py-2.5 transition-colors',
              resourceId === r.id && 'border-brand ring-1 ring-brand',
            )}
          >
            <div className="flex items-center gap-3">
              <DragHandle className="-ms-1" />
              {/* Значок сайта: в длинном списке ссылку находят глазами по
                  картинке, а не читая адреса. Нет иконки — прежний символ. */}
              <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-md bg-secondary">
                {r.icon ? (
                  <img
                    src={r.icon}
                    alt=""
                    className="no-zoom size-full object-contain"
                    onError={(e) => (e.currentTarget.style.display = 'none')}
                  />
                ) : r.url ? (
                  <LinkIcon className="size-4" />
                ) : (
                  <KeyRound className="size-4" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 truncate text-sm font-medium">
                  {r.name}
                  {r.source === 'chat' && <span className="rounded bg-brand/15 px-1 text-[10px] text-brand">{t('files.source.chat')}</span>}
                </span>
                <span className="flex items-center gap-2 truncate text-xs text-muted-foreground">
                  {r.url && (
                    <a href={r.url} target="_blank" rel="noreferrer" className="truncate text-brand hover:underline" onClick={(e) => e.stopPropagation()}>
                      {r.url}
                    </a>
                  )}
                  {r.secretCount > 0 && <span className="inline-flex items-center gap-0.5"><KeyRound className="size-3" />{r.secretCount}</span>}
                </span>
              </span>
              {r.messageId && (
                <Button variant="ghost" size="icon" title={t('files.jumpToChat')} onClick={() => navigate({ search: `?msg=${r.messageId}` })}>
                  <MessagesSquare className="size-4" />
                </Button>
              )}
              <Button variant="ghost" size="icon" title={t('tasks.share')} onClick={() => setSharing(r)}>
                <Share2 className="size-4" />
              </Button>
              <Button variant="ghost" size="icon" title={t('about.edit')} onClick={() => setEditing(r)}>
                <Pencil className="size-4" />
              </Button>
              <Button
                variant="destructive"
                size="icon"
                title={t('files.delete')}
                onClick={async () => {
                  if (await confirm({ title: t('resources.deleteConfirm', { name: r.name }), destructive: true, confirmLabel: t('files.delete') }))
                    remove.mutate(r.id)
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
            {r.description && <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{r.description}</p>}
          </li>
        ))}
        {!list.isLoading && filtered.length === 0 && (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{q ? t('start.nothingFound') : t('resources.empty')}</p>
        )}
      </ul>

      {/* Базы данных проекта — такой же ресурс, как доступ к серверу.
          Секция сама себя прячет, если фича выключена на сервере. */}
      <DbConnections projectId={projectId} />
    </div>
      {sharing && (
        <ShareDialog
          type="resource"
          id={sharing.id}
          title={sharing.name}
          appPath={`/c/${companyId}/p/${projectId}/resources/${sharing.id}`}
          canPublish={isAdmin}
          onClose={() => setSharing(null)}
        />
      )}
    </>
  )
}

function ResourceForm({ projectId, editing, onClose }: { projectId: string; editing: ResourceRow | null; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [name, setName] = useState(editing?.name ?? '')
  const [url, setUrl] = useState(editing?.url ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  // новые секреты для добавления
  const [newSecrets, setNewSecrets] = useState<{ label: string; value: string }[]>([])
  // Имя правят редко — прячем поле, пока не попросят.
  const [renaming, setRenaming] = useState(Boolean(editing?.name))

  // Ссылку набирают «figma.com», а не «https://figma.com» — дописываем схему
  // молча: требовать её от человека значит спорить с ним о синтаксисе.
  const normalized = (() => {
    const raw = url.trim()
    if (!raw) return ''
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  })()

  const host = (() => {
    try {
      return new URL(normalized).hostname.replace(/^www\./, '')
    } catch {
      return ''
    }
  })()

  // То, как ресурс назовётся, если своё имя не вводить. Показываем сразу:
  // человек видит результат и не гадает, обязательно ли поле.
  const derived = (() => {
    if (!host) return ''
    const path = new URL(normalized).pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop()
    return path && path.length <= 40 ? `${host}/${decodeURIComponent(path)}` : host
  })()

  const finalName = name.trim() || derived
  const hasSecret = newSecrets.some((s) => s.value.trim())
  // Пустой ресурс сохранять нечего, но хватает чего-то одного.
  const canSave = Boolean(finalName || normalized || hasSecret)

  // Значок для предпросмотра. С задержкой: пока адрес набирают, ходить в сеть
  // на каждую букву незачем. Через свой сервер — чтобы набранные адреса не
  // уходили постороннему сервису иконок.
  const [debouncedUrl, setDebouncedUrl] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setDebouncedUrl(host ? normalized : ''), 600)
    return () => clearTimeout(id)
  }, [normalized, host])

  const iconQ = useQuery({
    queryKey: ['resource-icon', debouncedUrl],
    enabled: Boolean(debouncedUrl),
    staleTime: 10 * 60 * 1000,
    retry: false,
    queryFn: () =>
      api<{ icon: string | null }>(`/api/v1/resources/icon-preview?url=${encodeURIComponent(debouncedUrl)}`, {}, 'project').then((r) => r.icon),
  })
  const previewIcon = iconQ.data ?? editing?.icon ?? null

  // детали (существующие секреты) при редактировании
  const detail = useQuery({
    queryKey: ['resource', editing?.id],
    enabled: Boolean(editing),
    queryFn: () => api<ResourceDetail>(`/api/v1/resources/${editing!.id}`, {}, 'project'),
  })

  const save = useMutation({
    mutationFn: async () => {
      if (editing) {
        await api(`/api/v1/resources/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ name, url: normalized || null, description }) }, 'project')
        for (const s of newSecrets.filter((s) => s.value)) {
          await api(`/api/v1/resources/${editing.id}/secrets`, { method: 'POST', body: JSON.stringify(s) }, 'project')
        }
      } else {
        await api('/api/v1/resources', { method: 'POST', body: JSON.stringify({ name, url: normalized || null, description, secrets: newSecrets.filter((s) => s.value) }) }, 'project')
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resources', projectId] })
      qc.invalidateQueries({ queryKey: ['resource', editing?.id] })
      toast.success(t('projectForm.saved'))
      onClose()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const revealSecret = async (secretId: string): Promise<string> => {
    const { value } = await api<{ value: string }>(`/api/v1/resources/${editing!.id}/secrets/${secretId}/reveal`, { method: 'POST' }, 'project')
    return value
  }
  const deleteSecret = useMutation({
    mutationFn: (secretId: string) => api(`/api/v1/resources/${editing!.id}/secrets/${secretId}`, { method: 'DELETE' }, 'project'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['resource', editing!.id] }),
  })

  return (
    <div className="mt-4 overflow-hidden rounded-xl border bg-card">
      {/* Шапка с подложкой: форма перестаёт быть россыпью полей и читается
          как одна карточка. */}
      <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-2.5">
        <h3 className="flex items-center gap-2 text-sm font-bold">
          <LinkIcon className="size-4 text-muted-foreground" />
          {editing ? t('resources.editTitle') : t('resources.addTitle')}
        </h3>
        <Button variant="ghost" size="icon" className="size-7" onClick={onClose}><X className="size-4" /></Button>
      </div>

      <div className="space-y-3 p-4">
        {/* Ссылка первой и крупно: ресурс — это в первую очередь она, а имя
            и описание дописывают по желанию. */}
        <div>
          <Input
            autoFocus={!editing}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t('resources.urlPlaceholder')}
            className="h-11 text-base"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
          />

          {/* Как ресурс будет выглядеть в списке. Показываем сразу, чтобы имя
              не приходилось воображать. */}
          {(host || finalName) && (
            <div className="mt-2 flex items-center gap-2.5 rounded-lg border bg-muted/20 px-3 py-2">
              <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-md border bg-background">
                {previewIcon ? (
                  <img src={previewIcon} alt="" className="no-zoom size-full object-contain" />
                ) : host ? (
                  <LinkIcon className={cn('size-4 text-muted-foreground', iconQ.isFetching && 'animate-pulse')} />
                ) : (
                  <KeyRound className="size-4 text-muted-foreground" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{finalName || t('resources.untitled')}</span>
                {host && <span className="block truncate text-xs text-muted-foreground">{normalized}</span>}
              </span>
              {!renaming && (
                <Button variant="ghost" size="sm" className="h-7 shrink-0 text-xs" onClick={() => setRenaming(true)}>
                  <Pencil className="size-3" />
                  {t('resources.rename')}
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Имя — по запросу: его придумывают редко, а поле в форме создаёт
            ощущение обязательного. */}
        {renaming && (
          <Input
            autoFocus={!editing}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={derived ? t('resources.namePlaceholderAuto', { name: derived }) : t('resources.namePlaceholder')}
          />
        )}
        {!renaming && !host && (
          <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => setRenaming(true)}>
            <Pencil className="size-3" />
            {t('resources.nameManually')}
          </Button>
        )}

        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder={t('resources.descPlaceholder')}
          className="w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
        />

        {/* Секреты */}
        <div className="rounded-lg border border-dashed p-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <KeyRound className="size-3.5" />
            {t('resources.secrets')}
          </p>
          <ul className="space-y-1.5">
            {detail.data?.secrets.map((s) => (
              <ExistingSecret key={s.id} label={s.label} onReveal={() => revealSecret(s.id)} onDelete={async () => {
                if (await confirm({ title: t('resources.deleteSecretConfirm'), destructive: true, confirmLabel: t('files.delete') })) deleteSecret.mutate(s.id)
              }} />
            ))}
            {newSecrets.map((s, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <Input value={s.label} onChange={(e) => setNewSecrets((p) => p.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder={t('resources.secretLabel')} className="h-8 w-32 text-xs" />
                <Input type="password" value={s.value} onChange={(e) => setNewSecrets((p) => p.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder={t('resources.secretValue')} className="h-8 flex-1 text-xs" autoComplete="off" />
                <Button variant="ghost" size="icon" onClick={() => setNewSecrets((p) => p.filter((_, j) => j !== i))}><X className="size-3.5" /></Button>
              </li>
            ))}
          </ul>
          <Button variant="ghost" size="sm" className="mt-1" onClick={() => setNewSecrets((p) => [...p, { label: '', value: '' }])}>
            <Plus className="size-3.5" /> {t('resources.addSecret')}
          </Button>
        </div>

        <div className="flex items-center justify-end gap-2 border-t pt-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="brand" size="sm" disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
            {t('projectForm.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function ExistingSecret({ label, onReveal, onDelete }: { label: string; onReveal: () => Promise<string>; onDelete: () => void }) {
  const { t } = useTranslation()
  const [value, setValue] = useState<string | null>(null)
  return (
    <li className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs">
      <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="w-28 shrink-0 truncate">{label || t('resources.secret')}</span>
      <span className="flex-1 truncate font-mono">{value ?? '••••••••'}</span>
      <Button variant="ghost" size="icon" title={value ? t('creds.hide') : t('creds.reveal')} onClick={async () => setValue(value ? null : await onReveal())}>
        {value ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </Button>
      <Button variant="ghost" size="icon" title={t('creds.copy')} onClick={async () => { await navigator.clipboard.writeText(await onReveal()); toast.success(t('creds.copied')) }}>
        <Copy className="size-3.5" />
      </Button>
      <Button variant="ghost" size="icon" title={t('files.delete')} onClick={onDelete}>
        <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
      </Button>
    </li>
  )
}

function AuditLog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const auditQ = useQuery({ queryKey: ['resources-audit', projectId], queryFn: () => api<{ id: string; action: string; resourceName: string; createdAt: string; user: { name: string; email: string } | null }[]>('/api/v1/resources/audit/log', {}, 'project') })
  return (
    <div className="mt-4 rounded-xl border bg-card p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-bold">{t('creds.auditTitle')}</h3>
        <Button variant="ghost" size="icon" onClick={onClose}><X className="size-4" /></Button>
      </div>
      <ul className="max-h-64 space-y-1 overflow-y-auto">
        {auditQ.data?.map((row) => (
          <li key={row.id} className="flex items-center gap-2 rounded px-2 py-1 text-xs">
            <span className="w-32 shrink-0 text-muted-foreground">{new Date(row.createdAt).toLocaleString(i18n.language)}</span>
            <span className="truncate font-medium">{row.user?.name ?? row.user?.email ?? '—'}</span>
            <span className="rounded-full bg-secondary px-1.5 py-0.5">{t(`creds.actions.${row.action}`)}</span>
            <span className="truncate text-muted-foreground">{row.resourceName}</span>
          </li>
        ))}
        {auditQ.data?.length === 0 && <p className="text-xs text-muted-foreground">{t('creds.auditEmpty')}</p>}
      </ul>
    </div>
  )
}
