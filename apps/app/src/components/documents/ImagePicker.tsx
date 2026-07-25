import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, Upload, X } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'

// Галерея изображений проекта для вставки в документ (SPEC §8.25).
type FileRow = { id: string; name: string; mime: string }

export function ImagePicker({
  projectId,
  onPick,
  onClose,
  onUploadClick,
}: {
  projectId: string
  onPick: (fileId: string) => void
  onClose: () => void
  onUploadClick: () => void
}) {
  const { t } = useTranslation()

  const files = useQuery({
    queryKey: ['doc-images', projectId],
    queryFn: () => api<{ items: FileRow[] }>('/api/v1/files?type=image', {}, 'project').then((r) => r.items),
  })
  const previews = useQuery({
    queryKey: ['doc-image-previews', projectId, files.data?.map((f) => f.id).join(',')],
    enabled: Boolean(files.data?.length),
    queryFn: async () => {
      const entries = await Promise.all(
        files.data!.slice(0, 60).map(async (f) => {
          const { url } = await api<{ url: string }>(`/api/v1/files/${f.id}/view-url`, {}, 'project')
          return [f.id, url] as const
        }),
      )
      return Object.fromEntries(entries) as Record<string, string>
    },
  })

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl border bg-card p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t('docs.pickImage')}</h2>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={onUploadClick}>
              <Upload className="size-3.5" />
              {t('files.upload')}
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="size-4" />
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {files.isLoading && <p className="py-6 text-center text-sm text-muted-foreground">…</p>}
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {(files.data ?? []).slice(0, 60).map((f) => (
              <button
                key={f.id}
                onClick={() => onPick(f.id)}
                title={f.name}
                className="group aspect-square overflow-hidden rounded-md border bg-secondary transition-colors hover:border-brand"
              >
                {previews.data?.[f.id] ? (
                  <img src={previews.data[f.id]} alt={f.name} className="size-full object-cover transition-transform group-hover:scale-105" />
                ) : (
                  <span className="grid size-full place-items-center">
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  </span>
                )}
              </button>
            ))}
          </div>
          {files.data && files.data.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">{t('docs.noImages')}</p>}
        </div>
      </div>
    </div>
  )
}
