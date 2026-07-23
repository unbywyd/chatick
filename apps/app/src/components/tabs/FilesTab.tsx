import { useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Download,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Loader2,
  Search,
  Trash2,
  UploadCloud,
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
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

type Page = { items: FileRow[]; page: number; hasMore: boolean }

// Таб «Файлы»: сетка 2 колонки, превью картинок, пагинация, встроенный просмотрщик
export function FilesTab({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [q, setQ] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState<string[]>([])
  const [viewing, setViewing] = useState<ViewerFile | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const filesQ = useInfiniteQuery({
    queryKey: ['files', projectId, q],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => api<Page>(`/api/v1/files?page=${pageParam}&q=${encodeURIComponent(q)}`, {}, 'project'),
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
  })
  const items = useMemo(() => (filesQ.data?.pages ?? []).flatMap((p) => p.items), [filesQ.data])

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
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText)
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
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('files.search')} className="ps-9" />
        </div>
        <Button variant="brand" onClick={() => inputRef.current?.click()}>
          <UploadCloud className="size-4" />
          {t('files.upload')}
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) uploadFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      <div
        className={cn(
          'mt-4 rounded-lg border-2 border-dashed p-6 text-center text-sm transition-colors',
          dragOver ? 'border-brand bg-accent text-foreground' : 'text-muted-foreground',
          uploading.length > 0 && 'border-brand/50',
        )}
      >
        {uploading.length > 0 ? (
          <span className="inline-flex items-center gap-2">
            <Loader2 className="size-4 animate-spin text-brand" />
            {t('files.uploading', { count: uploading.length })}
          </span>
        ) : (
          t('files.dropHint')
        )}
      </div>

      {/* Сетка 2 колонки на широких экранах */}
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {filesQ.isLoading && <p className="text-sm text-muted-foreground">…</p>}
        {items.map((f) => (
          <FileCard
            key={f.id}
            file={f}
            lang={i18n.language}
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
          {q ? t('start.nothingFound') : t('files.empty')}
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

function FileCard({ file, lang, onOpen, onDelete }: { file: FileRow; lang: string; onOpen: () => void; onDelete: () => void }) {
  const { t } = useTranslation()
  const Icon = iconFor(file.mime)
  const isImg = file.mime.startsWith('image/')

  const preview = useQuery({
    queryKey: ['file-preview', file.id],
    enabled: isImg,
    staleTime: 50 * 60 * 1000,
    queryFn: () => api<{ url: string }>(`/api/v1/files/${file.id}/download?inline=1`, {}, 'project').then((r) => r.url),
  })

  const openDownload = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const { url } = await api<{ url: string }>(`/api/v1/files/${file.id}/download`, {}, 'project')
    window.open(url, '_blank')
  }

  return (
    <div
      onClick={onOpen}
      draggable
      onDragStart={(e) =>
        e.dataTransfer.setData(
          'application/x-chatick-file',
          JSON.stringify({ id: file.id, name: file.name, mime: file.mime, size: file.size }),
        )
      }
      className="group flex cursor-pointer items-center gap-3 overflow-hidden rounded-lg border bg-card px-3 py-2.5 transition-colors hover:bg-accent/50 active:cursor-grabbing"
    >
      {isImg ? (
        <span className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-md bg-secondary">
          {preview.data ? (
            <img src={preview.data} alt="" className="size-full object-cover" loading="lazy" />
          ) : (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          )}
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
      <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
        <Button variant="ghost" size="icon" title={t('files.download')} onClick={openDownload}>
          <Download className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title={t('files.delete')}
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        >
          <Trash2 className="size-4 text-muted-foreground hover:text-destructive" />
        </Button>
      </span>
    </div>
  )
}
