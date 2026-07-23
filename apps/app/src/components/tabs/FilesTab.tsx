import { useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
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

type FileRow = {
  id: string
  name: string
  mime: string
  size: number
  createdAt: string
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

// Таб «Файлы»: presigned upload в R2 напрямую, список, поиск, скачивание, удаление
export function FilesTab({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const filesQ = useQuery({
    queryKey: ['files', projectId],
    queryFn: () => api<FileRow[]>('/api/v1/files', {}, 'project'),
  })

  const filtered = useMemo(() => {
    const list = filesQ.data ?? []
    const needle = q.trim().toLowerCase()
    return needle ? list.filter((f) => f.name.toLowerCase().includes(needle)) : list
  }, [filesQ.data, q])

  async function uploadFiles(list: FileList | File[]) {
    for (const file of Array.from(list)) {
      const label = file.name
      setUploading((u) => [...u, label])
      try {
        // multipart через API (R2-токен без прав на CORS — прямой PUT из браузера недоступен)
        const fd = new FormData()
        fd.append('file', file)
        const res = await fetch(`${API_URL}/api/v1/files`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${getProjectToken()}` },
          body: fd,
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(body.error ?? res.statusText)
        }
        qc.invalidateQueries({ queryKey: ['files', projectId] })
      } catch (e) {
        toast.error(`${file.name}: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setUploading((u) => u.filter((n) => n !== label))
      }
    }
  }

  const download = useMutation({
    mutationFn: (fileId: string) => api<{ url: string }>(`/api/v1/files/${fileId}/download`, {}, 'project'),
    onSuccess: (r) => window.open(r.url, '_blank'),
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const remove = useMutation({
    mutationFn: (fileId: string) => api(`/api/v1/files/${fileId}`, { method: 'DELETE' }, 'project'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files', projectId] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  return (
    <div
      className="mx-auto max-w-3xl p-6"
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

      {/* Drop-зона / прогресс */}
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

      {/* Список */}
      <ul className="mt-4 space-y-1.5">
        {filesQ.isLoading && <p className="text-sm text-muted-foreground">…</p>}
        {filtered.map((f) => {
          const Icon = iconFor(f.mime)
          return (
            <li key={f.id} className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-md bg-secondary">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{f.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {fmtSize(f.size)}
                  {f.uploader && <> · {f.uploader.name}</>}
                  {' · '}
                  {new Date(f.createdAt).toLocaleDateString(i18n.language)}
                </span>
              </span>
              <Button variant="ghost" size="icon" title={t('files.download')} onClick={() => download.mutate(f.id)}>
                <Download className="size-4" />
              </Button>
              <Button
                variant="destructive"
                size="icon"
                title={t('files.delete')}
                onClick={() => {
                  if (confirm(t('files.deleteConfirm', { name: f.name }))) remove.mutate(f.id)
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          )
        })}
        {!filesQ.isLoading && filtered.length === 0 && (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {q ? t('start.nothingFound') : t('files.empty')}
          </p>
        )}
      </ul>
    </div>
  )
}
