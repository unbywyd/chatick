import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Download, FileLock2, Paperclip, X } from 'lucide-react'
import { api, API_URL, getProjectToken } from '@/lib/api'
import { Button } from '@/components/ui/button'

// Файлы под ресурсом: кейстор, сертификат, приватный ключ.
//
// То, что нельзя вставить текстом и нельзя положить в общие файлы проекта.
// В хранилище лежит шифротекст, расшифровать может только сервер — поэтому
// скачивание идёт через наш API, а не по ссылке в бакет.
//
// Видны эти файлы тем же людям, что и пароли ресурса: адрес и описание
// открыты всему проекту, файл — нет.

type ResourceFile = { id: string; name: string; mime: string; size: string; createdAt: string }

/** Размер человеку, а не в байтах. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function ResourceFiles({
  resourceId,
  canEdit,
  pending,
  onPendingChange,
}: {
  /** null у ещё не сохранённого ресурса: класть файл некуда, id появится позже. */
  resourceId: string | null
  canEdit: boolean
  /**
   * Файлы, выбранные до сохранения.
   *
   * Форма нового ресурса — ровно то место, где человек заводит запись под
   * кейстор. Прятать от него загрузку до первого сохранения значит
   * отправлять его искать, куда же положить файл, посреди начатого дела.
   * Здесь файлы придерживаются, а форма дозаливает их, как только у ресурса
   * появится id.
   */
  pending?: File[]
  onPendingChange?: (files: File[]) => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const q = useQuery({
    queryKey: ['resource-files', resourceId],
    enabled: Boolean(resourceId),
    queryFn: () => api<{ items: ResourceFile[] }>(`/api/v1/resources/${resourceId}/files`, {}, 'project'),
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ['resource-files', resourceId] })

  const remove = useMutation({
    mutationFn: (fileId: string) =>
      api(`/api/v1/resources/${resourceId}/files/${fileId}`, { method: 'DELETE' }, 'project'),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  /**
   * Загрузка идёт напрямую через fetch, а не через api(): тело здесь
   * multipart, а api() ставит content-type: application/json и ломает разбор
   * формы на сервере.
   */
  const upload = async (file: File) => {
    // Ресурса ещё нет — держим файл у себя, форма дозальёт его после создания.
    if (!resourceId) {
      onPendingChange?.([...(pending ?? []), file])
      return
    }
    setBusy(true)
    try {
      const form = new FormData()
      form.set('file', file)
      const res = await fetch(`${API_URL}/api/v1/resources/${resourceId}/files`, {
        method: 'POST',
        headers: { authorization: `Bearer ${getProjectToken()}` },
        body: form,
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  /**
   * Скачивание — тоже через fetch: файл отдаётся расшифрованным потоком и
   * требует заголовок авторизации, поэтому обычной ссылкой его не забрать.
   */
  const download = async (f: ResourceFile) => {
    try {
      const res = await fetch(`${API_URL}/api/v1/resources/${resourceId}/files/${f.id}`, {
        headers: { authorization: `Bearer ${getProjectToken()}` },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = f.name
      a.click()
      // Ссылка на blob держит файл в памяти вкладки, пока её не отозвать —
      // для секрета это лишняя жизнь после скачивания.
      URL.revokeObjectURL(url)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  const items = q.data?.items ?? []
  const held = pending ?? []
  if (!canEdit && !items.length && !held.length) return null

  return (
    <div className="mt-3 border-t pt-3">
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <FileLock2 className="size-3.5" />
        {t('resourceFiles.title')}
      </p>

      {!items.length && !held.length && (
        <p className="text-xs text-muted-foreground">{t('resourceFiles.empty')}</p>
      )}

      <ul className="space-y-1">
        {items.map((f) => (
          <li key={f.id} className="group/f flex items-center gap-2 rounded-md border px-2 py-1.5">
            <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-xs">{f.name}</span>
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {humanSize(Number(f.size) || 0)}
            </span>
            <button
              type="button"
              title={t('resourceFiles.download')}
              onClick={() => download(f)}
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <Download className="size-3.5" />
            </button>
            {canEdit && (
              <button
                type="button"
                title={t('resourceFiles.remove')}
                onClick={() => remove.mutate(f.id)}
                className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/f:opacity-100"
              >
                <X className="size-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>

      {/* Придержанные: их ещё нет на сервере, поэтому ни скачать, ни
          сослаться на них нельзя — только убрать из списка. */}
      {held.length > 0 && (
        <ul className="space-y-1">
          {held.map((f, i) => (
            <li key={i} className="flex items-center gap-2 rounded-md border border-dashed px-2 py-1.5">
              <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs">{f.name}</span>
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{humanSize(f.size)}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{t('resourceFiles.afterSave')}</span>
              <button
                type="button"
                title={t('resourceFiles.remove')}
                onClick={() => onPendingChange?.(held.filter((_, j) => j !== i))}
                className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <>
          <input
            ref={inputRef}
            type="file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void upload(f)
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 gap-1"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            <Paperclip className="size-3.5" />
            {busy ? t('resourceFiles.uploading') : t('resourceFiles.attach')}
          </Button>
          {/* Говорим про шифрование прямо здесь: человек кладёт ключ подписи и
              должен видеть, что тот не окажется в общих файлах проекта. */}
          <p className="mt-1 text-[11px] text-muted-foreground">{t('resourceFiles.hint')}</p>
        </>
      )}
    </div>
  )
}
