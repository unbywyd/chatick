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
  Square,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react'
import { api, API_URL, getProjectToken } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm'
import { FileViewer, type ViewerFile } from '@/components/files/FileViewer'

type FileRow = {
  id: string
  name: string
  mime: string
  size: number
  createdAt: string
  hasOriginal?: boolean
  uploader: { id: string; name: string; avatarUrl: string | null } | null
}
type Page = { items: FileRow[]; page: number; hasMore: boolean; storage?: { used: number; limit: number } }

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

export function FilesTab({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState<string[]>([])
  const [viewing, setViewing] = useState<ViewerFile | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)

  const query = new URLSearchParams()
  if (q) query.set('q', q)
  if (from) query.set('from', from)
  if (to) query.set('to', to)
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
  const hasFilter = Boolean(q || from || to)

  return (
    <div
      className="mx-auto max-w-4xl p-6"
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
      {/* Прогресс хранилища */}
      {storage && (
        <div className="mb-4">
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {t('files.storage')}: {fmtSize(storage.used)}
              {storage.limit > 0 && <> / {fmtSize(storage.limit)}</>}
            </span>
            {storage.limit > 0 && <span className={cn('tabular-nums', usedPct > 90 && 'text-destructive')}>{usedPct.toFixed(0)}%</span>}
          </div>
          {storage.limit > 0 && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div className={cn('h-full transition-all', usedPct > 90 ? 'bg-destructive' : 'bg-brand')} style={{ width: `${usedPct}%` }} />
            </div>
          )}
        </div>
      )}

      {/* Строка действий */}
      <div className="flex items-center gap-2">
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

      {/* Фильтр по периоду */}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">{t('files.period')}:</span>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 rounded-md border bg-transparent px-2 text-foreground" />
        <span className="text-muted-foreground">—</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 rounded-md border bg-transparent px-2 text-foreground" />
        {hasFilter && (
          <Button variant="ghost" size="sm" onClick={() => { setQ(''); setFrom(''); setTo('') }}>
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
  onDelete,
}: {
  file: FileRow
  lang: string
  selectMode: boolean
  selected: boolean
  onToggle: () => void
  onOpen: () => void
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
        <span className="block truncate text-xs text-muted-foreground">
          {fmtSize(file.size)}
          {file.uploader && <> · {file.uploader.name}</>} · {new Date(file.createdAt).toLocaleDateString(lang)}
        </span>
      </span>
      {!selectMode && (
        <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
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
