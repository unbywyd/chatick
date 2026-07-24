import { useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  CheckSquare,
  Download,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Loader2,
  Search,
  Settings2,
  Square,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react'
import { CalendarDays, MessagesSquare } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api, API_URL, getProjectToken } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'
import { FileViewer, type ViewerFile } from '@/components/files/FileViewer'
import { StorageSettings } from '@/components/files/StorageSettings'
import { usePasteFiles } from '@/hooks/usePasteFiles'

type FileRow = {
  id: string
  name: string
  mime: string
  size: number
  createdAt: string
  hasOriginal?: boolean
  messageId?: string | null
  taskId?: string | null
  taskNumber?: string | null
  uploader: { id: string; name: string; avatarUrl: string | null } | null
}
type Page = { items: FileRow[]; page: number; hasMore: boolean; storage?: { used: number; limit: number; custom?: boolean } }

const SOURCES = ['all', 'chat', 'task', 'upload'] as const
const TYPES = ['image', 'video', 'audio', 'doc', 'other'] as const
type Source = (typeof SOURCES)[number]
type FileType = (typeof TYPES)[number]

function fmtDate(d: string | undefined, lang: string) {
  return d ? new Date(d).toLocaleDateString(lang) : ''
}

function iconFor(mime: string) {
  if (mime.startsWith('image/')) return FileImage
  if (mime.startsWith('video/')) return FileVideo
  if (mime.startsWith('audio/')) return FileAudio
  if (/zip|rar|7z|tar|gzip/.test(mime)) return FileArchive
  if (/pdf|text|document|word|sheet|excel|presentation/.test(mime)) return FileText
  return File
}
function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export function FilesTab({ projectId, isAdmin = false }: { projectId: string; isAdmin?: boolean }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [storageSettingsOpen, setStorageSettingsOpen] = useState(false)
  const confirm = useConfirm()
  const [q, setQ] = useState('')
  const [source, setSource] = useState<Source>('all')
  const [type, setType] = useState<FileType | null>(null)
  const [fromDate, setFromDate] = useState<Date | undefined>()
  const [toDate, setToDate] = useState<Date | undefined>()
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState<string[]>([])
  const [viewing, setViewing] = useState<ViewerFile | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)

  const iso = (d?: Date) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '')
  const query = new URLSearchParams()
  if (q) query.set('q', q)
  if (source !== 'all') query.set('source', source)
  if (type) query.set('type', type)
  if (fromDate) query.set('from', iso(fromDate))
  if (toDate) query.set('to', iso(toDate))
  const qs = query.toString()

  const filesQ = useInfiniteQuery({
    queryKey: ['files', projectId, qs],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => api<Page>(`/api/v1/files?page=${pageParam}${qs ? `&${qs}` : ''}`, {}, 'project'),
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
  })
  const items = useMemo(() => (filesQ.data?.pages ?? []).flatMap((p) => p.items), [filesQ.data])
  const storage = filesQ.data?.pages[0]?.storage
  const usedPct = storage && storage.limit > 0 ? Math.min(100, (storage.used / storage.limit) * 100) : 0

  async function uploadFiles(list: FileList | File[]) {
    for (const file of Array.from(list)) {
      const label = file.name
      setUploading((u) => [...u, label])
      try {
        const fd = new FormData()
        fd.append('file', file)
        const res = await fetch(`${API_URL}/api/v1/files`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${getProjectToken()}` },
          body: fd,
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
          throw new Error(body.code === 'STORAGE_LIMIT' ? t('files.limitReached') : body.error ?? res.statusText)
        }
        qc.invalidateQueries({ queryKey: ['files', projectId] })
      } catch (e) {
        toast.error(`${file.name}: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setUploading((u) => u.filter((n) => n !== label))
      }
    }
  }

  // вставка файлов/картинок из буфера (SPEC §8.16)
  usePasteFiles(uploadFiles)

  const remove = useMutation({
    mutationFn: (fileId: string) => api(`/api/v1/files/${fileId}`, { method: 'DELETE' }, 'project'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files', projectId] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const bulkDelete = useMutation({
    mutationFn: (ids: string[]) => api<{ deleted: number; skipped: number }>('/api/v1/files/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) }, 'project'),
    onSuccess: (r) => {
      toast.success(t('files.bulkDeleted', { count: r.deleted }))
      setSelected(new Set())
      setSelectMode(false)
      qc.invalidateQueries({ queryKey: ['files', projectId] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  const allSelected = items.length > 0 && items.every((f) => selected.has(f.id))
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(items.map((f) => f.id)))
  const hasFilter = Boolean(q || type || fromDate || toDate)
  const clearFilters = () => { setQ(''); setType(null); setFromDate(undefined); setToDate(undefined) }

  return (
    <div
      className="mx-auto max-w-6xl p-6"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files)
      }}
    >
      {/* Прогресс хранилища (для custom — «без лимита», прогресс-бар не рисуем) */}
      {storage && (
        <div className="mb-4">
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {storage.custom ? (
                t('storage.customActive')
              ) : (
                <>
                  {t('files.storage')}: {fmtSize(storage.used)}
                  {storage.limit > 0 && <> / {fmtSize(storage.limit)}</>}
                </>
              )}
            </span>
            <span className="flex items-center gap-2">
              {!storage.custom && storage.limit > 0 && (
                <span className={cn('tabular-nums', usedPct > 90 && 'text-destructive')}>{usedPct.toFixed(0)}%</span>
              )}
              {isAdmin && (
                <button onClick={() => setStorageSettingsOpen(true)} className="text-muted-foreground hover:text-foreground" title={t('storage.title')}>
                  <Settings2 className="size-3.5" />
                </button>
              )}
            </span>
          </div>
          {!storage.custom && storage.limit > 0 && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div className={cn('h-full transition-all', usedPct > 90 ? 'bg-destructive' : 'bg-brand')} style={{ width: `${usedPct}%` }} />
            </div>
          )}
        </div>
      )}
      {storageSettingsOpen && <StorageSettings projectId={projectId} onClose={() => setStorageSettingsOpen(false)} />}

      {/* Табы-источник */}
      <div className="flex gap-1 border-b">
        {SOURCES.map((s) => (
          <button
            key={s}
            onClick={() => setSource(s)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              source === s ? 'border-brand text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`files.source.${s}`)}
          </button>
        ))}
      </div>

      {/* Строка действий */}
      <div className="mt-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('files.search')} className="ps-9" />
        </div>
        <Button variant={selectMode ? 'default' : 'outline'} size="icon" title={t('files.select')} onClick={() => { setSelectMode((v) => !v); setSelected(new Set()) }}>
          <CheckSquare className="size-4" />
        </Button>
        <Button variant="brand" onClick={() => inputRef.current?.click()}>
          <UploadCloud className="size-4" />
          {t('files.upload')}
        </Button>
        <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files?.length) uploadFiles(e.target.files); e.target.value = '' }} />
      </div>

      {/* Чипы-тип + период (календарь) */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {TYPES.map((tp) => (
          <button
            key={tp}
            onClick={() => setType(type === tp ? null : tp)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-xs transition-colors',
              type === tp ? 'border-brand bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`files.type.${tp}`)}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-border" />
        <DatePick label={t('files.from')} value={fromDate} onChange={setFromDate} lang={i18n.language} />
        <span className="text-xs text-muted-foreground">—</span>
        <DatePick label={t('files.to')} value={toDate} onChange={setToDate} lang={i18n.language} />
        {hasFilter && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="size-3.5" />
            {t('files.clearFilter')}
          </Button>
        )}
      </div>

      {/* Панель выделения */}
      {selectMode && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border bg-card p-2">
          <Button variant="ghost" size="sm" onClick={toggleAll}>
            {allSelected ? <CheckSquare className="size-4 text-brand" /> : <Square className="size-4" />}
            {t('files.selectAll')}
          </Button>
          <span className="text-xs text-muted-foreground">{t('files.selectedCount', { count: selected.size })}</span>
          <Button
            variant="destructive"
            size="sm"
            className="ms-auto"
            disabled={selected.size === 0 || bulkDelete.isPending}
            onClick={async () => {
              if (await confirm({ title: t('files.bulkDeleteConfirm', { count: selected.size }), destructive: true, confirmLabel: t('files.delete') }))
                bulkDelete.mutate([...selected])
            }}
          >
            <Trash2 className="size-3.5" />
            {t('files.delete')}
          </Button>
        </div>
      )}

      {!selectMode && (
        <div className={cn('mt-4 rounded-lg border-2 border-dashed p-6 text-center text-sm transition-colors', dragOver ? 'border-brand bg-accent text-foreground' : 'text-muted-foreground', uploading.length > 0 && 'border-brand/50')}>
          {uploading.length > 0 ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="size-4 animate-spin text-brand" />
              {t('files.uploading', { count: uploading.length })}
            </span>
          ) : (
            t('files.dropHint')
          )}
        </div>
      )}

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {filesQ.isLoading && <p className="text-sm text-muted-foreground">…</p>}
        {items.map((f) => (
          <FileCard
            key={f.id}
            file={f}
            lang={i18n.language}
            selectMode={selectMode}
            selected={selected.has(f.id)}
            onToggle={() => toggle(f.id)}
            onOpen={() => setViewing(f)}
            onJumpToChat={f.messageId ? () => navigate({ search: `?msg=${f.messageId}` }) : undefined}
            onDelete={async () => {
              if (await confirm({ title: t('files.deleteConfirm', { name: f.name }), destructive: true, confirmLabel: t('files.delete') }))
                remove.mutate(f.id)
            }}
          />
        ))}
      </div>

      {!filesQ.isLoading && items.length === 0 && (
        <p className="mt-4 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {hasFilter ? t('start.nothingFound') : t('files.empty')}
        </p>
      )}

      {filesQ.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" size="sm" onClick={() => filesQ.fetchNextPage()} disabled={filesQ.isFetchingNextPage}>
            {filesQ.isFetchingNextPage ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t('files.loadMore')}
          </Button>
        </div>
      )}

      {viewing && <FileViewer file={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

function FileCard({
  file,
  lang,
  selectMode,
  selected,
  onToggle,
  onOpen,
  onJumpToChat,
  onDelete,
}: {
  file: FileRow
  lang: string
  selectMode: boolean
  selected: boolean
  onToggle: () => void
  onOpen: () => void
  onJumpToChat?: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const Icon = iconFor(file.mime)
  const isImg = file.mime.startsWith('image/')

  const preview = useQuery({
    queryKey: ['file-preview', file.id],
    enabled: isImg,
    staleTime: 50 * 60 * 1000,
    queryFn: () => api<{ url: string }>(`/api/v1/files/${file.id}/view-url`, {}, 'project').then((r) => r.url),
  })

  const openDownload = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const { url } = await api<{ url: string }>(`/api/v1/files/${file.id}/download`, {}, 'project')
    window.open(url, '_blank')
  }

  return (
    <div
      onClick={selectMode ? onToggle : onOpen}
      draggable={!selectMode}
      onDragStart={(e) =>
        e.dataTransfer.setData('application/x-chatick-file', JSON.stringify({ id: file.id, name: file.name, mime: file.mime, size: file.size }))
      }
      className={cn(
        'group flex cursor-pointer items-center gap-3 overflow-hidden rounded-lg border bg-card px-3 py-2.5 transition-colors hover:bg-accent/50',
        selected && 'border-brand bg-accent',
      )}
    >
      {selectMode && (
        <span className="shrink-0">
          {selected ? <CheckSquare className="size-5 text-brand" /> : <Square className="size-5 text-muted-foreground" />}
        </span>
      )}
      {isImg ? (
        <span className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-md bg-secondary">
          {preview.data ? <img src={preview.data} alt="" className="size-full object-cover" loading="lazy" /> : <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        </span>
      ) : (
        <span className="grid size-12 shrink-0 place-items-center rounded-md bg-secondary">
          <Icon className="size-5" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{file.name}</span>
        <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
          {file.messageId && <span className="rounded bg-brand/15 px-1 text-[10px] text-brand">{t('files.source.chat')}</span>}
          {file.taskNumber && <span className="rounded bg-secondary px-1 text-[10px]">{file.taskNumber}</span>}
          <span className="truncate">
            {fmtSize(file.size)}
            {file.uploader && <> · {file.uploader.name}</>} · {fmtDate(file.createdAt, lang)}
          </span>
        </span>
      </span>
      {!selectMode && (
        <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
          {onJumpToChat && (
            <Button variant="ghost" size="icon" title={t('files.jumpToChat')} onClick={(e) => { e.stopPropagation(); onJumpToChat() }}>
              <MessagesSquare className="size-4" />
            </Button>
          )}
          <Button variant="ghost" size="icon" title={t('files.download')} onClick={openDownload}>
            <Download className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" title={t('files.delete')} onClick={(e) => { e.stopPropagation(); onDelete() }}>
            <Trash2 className="size-4 text-muted-foreground hover:text-destructive" />
          </Button>
        </span>
      )}
    </div>
  )
}

// Пикер даты через нормальный календарь (поповер)
function DatePick({ label, value, onChange, lang }: { label: string; value?: Date; onChange: (d?: Date) => void; lang: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <CalendarDays className="size-3.5 text-muted-foreground" />
          {value ? value.toLocaleDateString(lang, { day: 'numeric', month: 'short', year: '2-digit' }) : label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto">
        <Calendar selected={value} onSelect={onChange} />
        {value && (
          <Button variant="ghost" size="sm" className="mt-1 w-full" onClick={() => onChange(undefined)}>
            <X className="size-3.5" /> {label}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}
