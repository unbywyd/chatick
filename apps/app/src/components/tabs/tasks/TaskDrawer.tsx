import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  CalendarDays,
  Download,
  ExternalLink,
  File,
  Loader2,
  Paperclip,
  Trash2,
  User,
  X,
} from 'lucide-react'
import { api, API_URL, getProjectToken } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckItem,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'
import { STATUSES, PRIORITIES, STATUS_ICON, STATUS_COLOR, PRIORITY_DOT, type Task, type Member } from './types'

type Attachment = {
  id: string
  name: string
  mime: string
  size: number
  createdAt: string
  uploader: { id: string; name: string } | null
}

// Детальная панель задачи: редактирование + вложения прямо в таске (dnd, превью, лайтбокс)
export function TaskDrawer({
  task,
  members,
  onPatch,
  onDelete,
  onClose,
}: {
  task: Task
  members: Member[]
  onPatch: (body: Record<string, unknown>) => void
  onDelete: () => void
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [uploading, setUploading] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // при переключении на другую задачу — сбросить черновики
  useEffect(() => {
    setTitle(task.title)
    setDescription(task.description)
  }, [task.id, task.title, task.description])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') (lightbox ? setLightbox(null) : onClose())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox, onClose])

  const attachments = useQuery({
    queryKey: ['task-files', task.id],
    queryFn: () => api<Attachment[]>(`/api/v1/files?taskId=${task.id}`, {}, 'project'),
  })
  // превью-URL картинок (inline presigned, 1ч)
  const previews = useQuery({
    queryKey: ['task-file-previews', task.id, attachments.data?.map((a) => a.id).join(',')],
    enabled: Boolean(attachments.data?.some((a) => a.mime.startsWith('image/'))),
    queryFn: async () => {
      const images = attachments.data!.filter((a) => a.mime.startsWith('image/'))
      const entries = await Promise.all(
        images.map(async (a) => {
          const { url } = await api<{ url: string }>(`/api/v1/files/${a.id}/download?inline=1`, {}, 'project')
          return [a.id, url] as const
        }),
      )
      return Object.fromEntries(entries) as Record<string, string>
    },
  })

  const dirty = title !== task.title || description !== task.description
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['task-files', task.id] })
    qc.invalidateQueries({ queryKey: ['tasks'] }) // attachmentsCount в списке
  }

  async function upload(list: FileList | File[]) {
    for (const file of Array.from(list)) {
      setUploading((n) => n + 1)
      try {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('taskId', task.id)
        const res = await fetch(`${API_URL}/api/v1/files`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${getProjectToken()}` },
          body: fd,
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(body.error ?? res.statusText)
        }
        refresh()
      } catch (e) {
        toast.error(`${file.name}: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  const open = async (att: Attachment, inline: boolean) => {
    try {
      const { url } = await api<{ url: string }>(`/api/v1/files/${att.id}/download${inline ? '?inline=1' : ''}`, {}, 'project')
      if (inline && att.mime.startsWith('image/')) setLightbox(url)
      else window.open(url, '_blank')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  const removeAtt = useMutation({
    mutationFn: (id: string) => api(`/api/v1/files/${id}`, { method: 'DELETE' }, 'project'),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const confirm = useConfirm()
  const canPreviewInline = (mime: string) => mime.startsWith('image/') || mime === 'application/pdf'

  return (
    <>
      <div
        className="absolute inset-y-0 end-0 z-20 flex w-full max-w-md flex-col border-s bg-background shadow-2xl"
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          if (e.dataTransfer.files.length) upload(e.dataTransfer.files)
        }}
      >
        {/* Header */}
        <header className="flex items-center gap-2 border-b px-4 py-3">
          <span className="text-xs font-medium text-muted-foreground">{task.number}</span>
          <span className="ms-auto" />
          <Button
            variant="destructive"
            size="icon"
            title={t('files.delete')}
            onClick={async () => {
              if (await confirm({ title: t('tasks.deleteConfirm', { number: task.number }), destructive: true, confirmLabel: t('files.delete') }))
                onDelete()
            }}
          >
            <Trash2 className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {/* Title */}
          <Input value={title} onChange={(e) => setTitle(e.target.value)} className="border-0 px-0 text-lg font-semibold focus:ring-0" />

          {/* Properties: чипы-кнопки вместо селектов — выбор одним кликом */}
          <div className="space-y-3">
            <PropRow label={t('tasks.statusLabel')}>
              <div className="flex flex-wrap gap-1.5">
                {STATUSES.map((s) => {
                  const Icon = STATUS_ICON[s]
                  const active = s === task.status
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => onPatch({ status: s })}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                        active ? 'border-current bg-accent font-medium' : 'text-muted-foreground hover:text-foreground',
                        active && STATUS_COLOR[s],
                      )}
                    >
                      <Icon className={cn('size-3.5', STATUS_COLOR[s])} />
                      {t(`tasks.status.${s}`)}
                    </button>
                  )
                })}
              </div>
            </PropRow>

            <PropRow label={t('tasks.priorityLabel')}>
              <div className="flex flex-wrap gap-1.5">
                {PRIORITIES.map((p) => {
                  const active = p === task.priority
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => onPatch({ priority: p })}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                        active ? 'border-brand bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <span className={cn('size-2 rounded-full', PRIORITY_DOT[p])} />
                      {t(`tasks.priority.${p}`)}
                    </button>
                  )
                })}
              </div>
            </PropRow>

            <div className="grid grid-cols-2 gap-2">
              <PropRow label={t('tasks.assigneeLabel')}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                      <User className="size-3.5 text-muted-foreground" />
                      <span className="truncate">{task.assignee?.name ?? t('tasks.unassigned')}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem onSelect={() => onPatch({ assigneeId: null })}>
                      <X className="size-3.5" />
                      {t('tasks.unassigned')}
                    </DropdownMenuItem>
                    {members.map((m) => (
                      <DropdownMenuCheckItem key={m.user.id} checked={task.assignee?.id === m.user.id} onSelect={() => onPatch({ assigneeId: m.user.id })}>
                        {m.user.name || m.user.email}
                      </DropdownMenuCheckItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </PropRow>

              <PropRow label={t('tasks.due')}>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                      <CalendarDays className="size-3.5 text-muted-foreground" />
                      {task.dueDate
                        ? new Date(task.dueDate).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short', year: 'numeric' })
                        : '—'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-auto">
                    <Calendar
                      selected={task.dueDate ? new Date(task.dueDate) : undefined}
                      onSelect={(d) =>
                        onPatch({ dueDate: d ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).toISOString() : null })
                      }
                    />
                    {task.dueDate && (
                      <Button variant="ghost" size="sm" className="mt-1 w-full" onClick={() => onPatch({ dueDate: null })}>
                        <X className="size-3.5" />
                        {t('tasks.clearDue')}
                      </Button>
                    )}
                  </PopoverContent>
                </Popover>
              </PropRow>
            </div>
          </div>

          {/* Description */}
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={5}
            placeholder={t('tasks.descriptionPlaceholder')}
            className="w-full resize-y rounded-md border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
          />
          {dirty && (
            <div className="flex justify-end">
              <Button variant="brand" size="sm" onClick={() => onPatch({ title: title.trim() || task.title, description })}>
                {t('projectForm.save')}
              </Button>
            </div>
          )}

          {/* Attachments */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                <Paperclip className="size-3.5" />
                {t('tasks.attachments')}
                {(attachments.data?.length ?? 0) > 0 && <span className="tabular-nums text-muted-foreground">({attachments.data!.length})</span>}
              </h3>
              <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
                {uploading > 0 ? <Loader2 className="size-3.5 animate-spin" /> : <Paperclip className="size-3.5" />}
                {t('tasks.attach')}
              </Button>
              <input
                ref={inputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) upload(e.target.files)
                  e.target.value = ''
                }}
              />
            </div>

            <div
              className={cn(
                'rounded-lg border-2 border-dashed p-2 transition-colors',
                dragOver ? 'border-brand bg-accent' : 'border-transparent',
              )}
            >
              {/* Превью картинок сеткой */}
              {(attachments.data ?? []).some((a) => a.mime.startsWith('image/')) && (
                <div className="mb-2 grid grid-cols-3 gap-2">
                  {attachments.data!
                    .filter((a) => a.mime.startsWith('image/'))
                    .map((a) => (
                      <button
                        key={a.id}
                        className="group relative aspect-square overflow-hidden rounded-md border bg-secondary"
                        onClick={() => open(a, true)}
                        title={a.name}
                      >
                        {previews.data?.[a.id] ? (
                          <img src={previews.data[a.id]} alt={a.name} className="size-full object-cover transition-transform group-hover:scale-105" />
                        ) : (
                          <span className="grid size-full place-items-center">
                            <Loader2 className="size-4 animate-spin text-muted-foreground" />
                          </span>
                        )}
                      </button>
                    ))}
                </div>
              )}

              {/* Остальные файлы списком */}
              <ul className="space-y-1">
                {(attachments.data ?? [])
                  .filter((a) => !a.mime.startsWith('image/'))
                  .map((a) => (
                    <li key={a.id} className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-2">
                      <File className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm">{a.name}</span>
                      {canPreviewInline(a.mime) && (
                        <Button variant="ghost" size="icon" title={t('tasks.preview')} onClick={() => open(a, true)}>
                          <ExternalLink className="size-3.5" />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" title={t('files.download')} onClick={() => open(a, false)}>
                        <Download className="size-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" title={t('files.delete')} onClick={() => removeAtt.mutate(a.id)}>
                        <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
                      </Button>
                    </li>
                  ))}
              </ul>

              {(attachments.data?.length ?? 0) === 0 && uploading === 0 && (
                <p className="p-3 text-center text-xs text-muted-foreground">{t('tasks.attachHint')}</p>
              )}
              {uploading > 0 && (
                <p className="flex items-center justify-center gap-2 p-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin text-brand" />
                  {t('files.uploading', { count: uploading })}
                </p>
              )}
            </div>

            {/* Удаление картинок — по ховеру в лайтбоксе сложно; кнопка под сеткой */}
            {(attachments.data ?? []).filter((a) => a.mime.startsWith('image/')).length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-muted-foreground">{t('tasks.manageImages')}</summary>
                <ul className="mt-1 space-y-1">
                  {attachments.data!
                    .filter((a) => a.mime.startsWith('image/'))
                    .map((a) => (
                      <li key={a.id} className="flex items-center gap-2 text-xs">
                        <span className="min-w-0 flex-1 truncate">{a.name}</span>
                        <Button variant="ghost" size="icon" title={t('files.download')} onClick={() => open(a, false)}>
                          <Download className="size-3" />
                        </Button>
                        <Button variant="ghost" size="icon" title={t('files.delete')} onClick={() => removeAtt.mutate(a.id)}>
                          <Trash2 className="size-3 text-muted-foreground hover:text-destructive" />
                        </Button>
                      </li>
                    ))}
                </ul>
              </details>
            )}
          </section>
        </div>
      </div>

      {/* Лайтбокс */}
      {lightbox && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/85 p-6" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
          <button className="absolute end-4 top-4 rounded-full bg-black/50 p-2 text-white hover:bg-black/70">
            <X className="size-5" />
          </button>
        </div>
      )}
    </>
  )
}

function PropRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-xs text-muted-foreground">{label}</p>
      {children}
    </div>
  )
}
