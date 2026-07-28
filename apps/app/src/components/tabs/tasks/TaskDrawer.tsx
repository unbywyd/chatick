import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  ArrowLeft,
  CalendarDays,
  Download,
  ExternalLink,
  File,
  Loader2,
  MessagesSquare,
  Paperclip,
  Pencil,
  Share2,
  Sparkles,
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
import { FileViewer, type ViewerFile } from '@/components/files/FileViewer'
import { RichEditor } from '@/components/ui/rich-editor'
import { Avatar } from '@/components/ui/avatar'
import { TaskComments } from './TaskComments'
import { TaskNotes } from './TaskNotes'
import { usePasteFiles } from '@/hooks/usePasteFiles'
import { useProjectSocket } from '@/hooks/useProjectSocket'
import { STATUSES, PRIORITIES, STATUS_ICON, STATUS_COLOR, PRIORITY_DOT, fmtEstimate, type Task, type Member, type TaskGroup } from './types'
import { parseDuration } from '@/lib/time-parse'
import { ShareDialog } from '@/components/ShareDialog'
import { UploadDialog, hasImages } from '@/components/UploadDialog'

type Attachment = {
  id: string
  name: string
  mime: string
  size: number
  createdAt: string
  deleted?: boolean
  messageId?: string | null
  uploader: { id: string; name: string } | null
}

// Детальная панель задачи: редактирование + вложения прямо в таске (dnd, превью, лайтбокс)
export function TaskDrawer({
  task,
  members,
  groups = [],
  meId,
  canEdit = true,
  onPatch,
  onDelete,
  onClose,
  startEditing = false,
}: {
  task: Task
  members: Member[]
  groups?: TaskGroup[]
  meId?: string
  canEdit?: boolean
  onPatch: (body: Record<string, unknown>) => void
  onDelete: () => void
  /** только что созданная задача — открываем сразу в режиме правки */
  startEditing?: boolean
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [estimate, setEstimate] = useState(fmtEstimate(task.estimateMinutes))
  const [assigneeQuery, setAssigneeQuery] = useState('')
  const [uploading, setUploading] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [viewing, setViewing] = useState<ViewerFile | null>(null)
  // Файлы выбраны, но ещё не отправлены: ждём решения про оригиналы.
  const [asking, setAsking] = useState<File[] | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [aiCheck, setAiCheck] = useState<{ advice: string; suggestedTitle: string; suggestedDescription: string } | null>(null)

  // ИИ-валидация задачи («Проверить мою задачу», SPEC §8.6)
  const validate = useMutation({
    mutationFn: () =>
      api<{ advice: string; suggestedTitle: string; suggestedDescription: string }>(
        '/api/v1/tasks/validate',
        { method: 'POST', body: JSON.stringify({ title, description }) },
        'project',
      ),
    onSuccess: (r) => setAiCheck(r),
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  // при переключении на другую задачу — сбросить черновики
  useEffect(() => {
    setTitle(task.title)
    setDescription(task.description)
    setEstimate(fmtEstimate(task.estimateMinutes))
  }, [task.id, task.title, task.description, task.estimateMinutes])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !viewing) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewing, onClose])

  const attachments = useQuery({
    queryKey: ['task-files', task.id],
    // includeDeleted: показываем удалённые как «Файл удалён», ссылка не пропадает (SPEC §8.3)
    queryFn: () => api<{ items: Attachment[] }>(`/api/v1/files?taskId=${task.id}&includeDeleted=1`, {}, 'project').then((r) => r.items),
  })
  // превью-URL картинок (inline presigned, 1ч)
  const previews = useQuery({
    queryKey: ['task-file-previews', task.id, attachments.data?.map((a) => a.id).join(',')],
    enabled: Boolean(attachments.data?.some((a) => a.mime.startsWith('image/') && !a.deleted)),
    queryFn: async () => {
      const images = attachments.data!.filter((a) => a.mime.startsWith('image/') && !a.deleted)
      const entries = await Promise.all(
        images.map(async (a) => {
          const { url } = await api<{ url: string }>(`/api/v1/files/${a.id}/view-url`, {}, 'project')
          return [a.id, url] as const
        }),
      )
      return Object.fromEntries(entries) as Record<string, string>
    },
  })

  const dirty = title !== task.title || description !== task.description

  /**
   * Выйти из правки, не сохраняя.
   *
   * Спрашиваем, только когда есть что терять: подтверждать выход из формы,
   * в которой ничего не меняли, — лишний вопрос. Блокировка задачи снимается
   * сама при выходе из режима, иначе она осталась бы занятой для остальных.
   */
  async function cancelEditing() {
    if (dirty) {
      const ok = await confirm({
        title: t('tasks.discardTitle'),
        description: t('tasks.discardHint'),
        destructive: true,
        confirmLabel: t('tasks.discardConfirm'),
      })
      if (!ok) return
    }
    setTitle(task.title)
    setDescription(task.description)
    setEstimate(fmtEstimate(task.estimateMinutes))
    setEditing(false)
  }
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['task-files', task.id] })
    qc.invalidateQueries({ queryKey: ['tasks'] }) // attachmentsCount в списке
  }

  async function upload(list: FileList | File[], keepOriginal = false) {
    for (const file of Array.from(list)) {
      setUploading((n) => n + 1)
      try {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('taskId', task.id)
        if (keepOriginal) fd.append('keepOriginal', '1')
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

  // Вставка файлов из буфера прямо в задачу (SPEC §8.16). Только когда правки
  // разрешены: принять файл и не сохранить его — хуже, чем не принять.
  // Перетаскивание и вставка — тем же путём, что и выбор файла.
  const pickFiles = (list: FileList | File[]) => {
    const picked = Array.from(list)
    if (!picked.length) return
    if (hasImages(picked)) setAsking(picked)
    else void upload(picked)
  }

  usePasteFiles(pickFiles, canEdit)

  const open = (att: Attachment) => setViewing({ id: att.id, name: att.name, mime: att.mime })

  const removeAtt = useMutation({
    mutationFn: (id: string) => api(`/api/v1/files/${id}`, { method: 'DELETE' }, 'project'),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const confirm = useConfirm()
  const canPreviewInline = (mime: string) => mime.startsWith('image/') || mime === 'application/pdf'

  // редактирование справа — по умолчанию скрыто (открывается кнопкой «Редактировать»)
  const [editing, setEditing] = useState(startEditing)
  // при смене задачи форму закрываем — кроме случая, когда её только что создали
  useEffect(() => setEditing(startEditing), [task.id, startEditing])

  // Блокировка редактирования: кто сейчас правит эту задачу (SPEC §8.18)
  const [lockedBy, setLockedBy] = useState<{ id: string; name: string; avatarUrl: string | null } | null>(null)
  const { lockTask, unlockTask, heartbeatLock } = useProjectSocket(window.location.hash.split('/')[2], {
    onMessage: () => {},
    onTaskLock: (p) => {
      if (p.taskId !== task.id) return
      setLockedBy(p.user && p.user.id !== meId ? p.user : null)
    },
    onTaskLockDenied: (p) => {
      if (p.taskId === task.id) {
        setEditing(false)
        toast.error(t('tasks.lockedByOther'))
      }
    },
  })

  // захват лока на время редактирования + heartbeat; освобождение при закрытии
  useEffect(() => {
    if (!editing) return
    lockTask(task.id)
    const hb = setInterval(() => heartbeatLock(task.id), 30_000)
    return () => {
      clearInterval(hb)
      unlockTask(task.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, task.id])

  // файлы, пришедшие из чата (есть messageId) — секция «связь с чатом»
  const chatFiles = (attachments.data ?? []).filter((a) => a.messageId)

  // Диалог вместо копирования в буфер: кроме ссылки для команды у задачи
  // теперь есть и публичная — показать её можно и тому, кого нет в проекте.
  const [sharing, setSharing] = useState(false)
  // Проект берём из адреса: сама задача его не хранит, а ссылка без проекта
  // никуда не ведёт.
  const { id: routeProjectId } = useParams()

  const editForm = (
    <>
      {/* Title */}
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('tasks.newPlaceholder')} className="text-base font-semibold" />

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
                <DropdownMenu onOpenChange={(o) => !o && setAssigneeQuery('')}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                      {task.assignee ? (
                        <Avatar name={task.assignee.name} src={task.assignee.avatarUrl} size={18} />
                      ) : (
                        <User className="size-3.5 text-muted-foreground" />
                      )}
                      <span className="truncate">{task.assignee?.name ?? t('tasks.unassigned')}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="max-h-72 overflow-y-auto">
                    {members.length > 6 && (
                      <div className="p-1">
                        <input
                          autoFocus
                          value={assigneeQuery}
                          onChange={(e) => setAssigneeQuery(e.target.value)}
                          onKeyDown={(e) => e.stopPropagation()}
                          onKeyDownCapture={(e) => e.stopPropagation()}
                          placeholder={t('tasks.searchAssignee')}
                          className="h-7 w-full rounded border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                        />
                      </div>
                    )}
                    <DropdownMenuItem onSelect={() => onPatch({ assigneeId: null })}>
                      <X className="size-3.5" />
                      {t('tasks.unassigned')}
                    </DropdownMenuItem>
                    {members
                      .filter((m) => {
                        const n = assigneeQuery.trim().toLowerCase()
                        return !n || (m.user.name || m.user.email).toLowerCase().includes(n)
                      })
                      .map((m) => (
                        <DropdownMenuCheckItem key={m.user.id} checked={task.assignee?.id === m.user.id} onSelect={() => onPatch({ assigneeId: m.user.id })}>
                          <Avatar name={m.user.name || m.user.email} src={m.user.avatarUrl} size={18} />
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

            {/* Оценка времени (SPEC §8.13) */}
            <PropRow label={t('tasks.estimate')}>
              <div className="flex items-center gap-2">
                {/* Текстовое поле, а не number: формат тот же, что в трекере и в
                    таблице — 230 значит 2:30, а числовой ввод такого не примет. */}
                <input
                  value={estimate}
                  onChange={(e) => setEstimate(e.target.value)}
                  onBlur={() => {
                    const trimmed = estimate.trim()
                    const next = trimmed === '' ? null : parseDuration(trimmed)
                    // непонятный ввод откатываем к сохранённому, а не обнуляем
                    if (trimmed !== '' && next === null) {
                      setEstimate(fmtEstimate(task.estimateMinutes))
                      return
                    }
                    if (next !== (task.estimateMinutes ?? null)) onPatch({ estimateMinutes: next })
                  }}
                  placeholder="2:30"
                  className="h-8 w-28 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <span className="text-xs text-muted-foreground">{t('tasks.estimateHint')}</span>
              </div>
            </PropRow>

            {/* Спринт (группа) */}
            {groups.length > 0 && (
              <PropRow label={t('tasks.sprint')}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                      {(() => {
                        const g = groups.find((x) => x.id === task.groupId)
                        return g ? (
                          <>
                            <span className="size-3 rounded-full" style={{ backgroundColor: g.color }} />
                            <span className="truncate">{g.name}</span>
                          </>
                        ) : (
                          <span className="truncate text-muted-foreground">{t('tasks.noGroup')}</span>
                        )
                      })()}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem onSelect={() => onPatch({ groupId: null })}>
                      <X className="size-3.5" />
                      {t('tasks.noGroup')}
                    </DropdownMenuItem>
                    {groups.map((g) => (
                      <DropdownMenuCheckItem key={g.id} checked={task.groupId === g.id} onSelect={() => onPatch({ groupId: g.id })}>
                        <span className="size-3 rounded-full" style={{ backgroundColor: g.color }} />
                        {g.name}
                      </DropdownMenuCheckItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </PropRow>
            )}
          </div>

          {/* Description — Tiptap с mentions команды */}
          <RichEditor
            value={description}
            onChange={(md) => setDescription(md)}
            placeholder={t('tasks.descriptionPlaceholder')}
            mentions={members.map((m) => ({ id: m.user.id, label: m.user.name || m.user.email, avatarUrl: m.user.avatarUrl }))}
            preset="full"
          />

          {/* ИИ-совет по задаче */}
          {aiCheck && (
            <div className="space-y-2 rounded-lg border border-brand/40 bg-brand/5 p-3">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Sparkles className="size-4 text-brand" />
                {t('tasks.aiAdvice')}
              </div>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{aiCheck.advice}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="brand"
                  size="sm"
                  onClick={() => {
                    setTitle(aiCheck.suggestedTitle)
                    setDescription(aiCheck.suggestedDescription)
                    setAiCheck(null)
                  }}
                >
                  {t('tasks.applySuggestion')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setAiCheck(null)}>
                  {t('files.cancel')}
                </Button>
              </div>
            </div>
          )}

      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" size="sm" disabled={validate.isPending || !title.trim()} onClick={() => validate.mutate()}>
          {validate.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          {t('tasks.checkTask')}
        </Button>
        <div className="flex items-center gap-2">
          {/* Отмена рядом с сохранением, а не в углу: решают их вместе. */}
          <Button variant="ghost" size="sm" onClick={() => void cancelEditing()}>
            {t('files.cancel')}
          </Button>
          {dirty && (
            <Button variant="brand" size="sm" onClick={() => onPatch({ title: title.trim() || task.title, description })}>
              {t('projectForm.save')}
            </Button>
          )}
        </div>
      </div>
    </>
  )

  // Секция вложений (в левой read-колонке)
  const attachmentsSection = (
          <section className="rounded-xl border bg-card p-4">
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
                  const picked = Array.from(e.target.files ?? [])
                  e.target.value = ''
                  if (!picked.length) return
                  // Про оригиналы спрашиваем только когда есть картинки.
                  pickFiles(picked)
                }}
              />
            </div>

            <div
              className={cn(
                // рамка видна всегда: иначе зона загрузки не читается как зона
                'rounded-lg border-2 border-dashed p-2 transition-colors',
                dragOver ? 'border-brand bg-accent' : 'border-border',
              )}
            >
              {/* Превью картинок сеткой (удалённые — не показываем как превью) */}
              {(attachments.data ?? []).some((a) => a.mime.startsWith('image/') && !a.deleted) && (
                // Мельче и больше в ряд: это опознавательные знаки, а не
                // галерея — разглядывают их в просмотрщике по клику.
                <div className="mb-2 grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
                  {attachments.data!
                    .filter((a) => a.mime.startsWith('image/') && !a.deleted)
                    .map((a) => (
                      <button
                        key={a.id}
                        className="group relative aspect-square overflow-hidden rounded-md border bg-secondary"
                        onClick={() => open(a)}
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

              {/* Остальные файлы списком (не картинки, не удалённые) */}
              <ul className="space-y-1">
                {(attachments.data ?? [])
                  .filter((a) => !a.mime.startsWith('image/') && !a.deleted)
                  .map((a) => (
                    <li key={a.id} className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-2">
                      <File className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm">{a.name}</span>
                      {canPreviewInline(a.mime) && (
                        <Button variant="ghost" size="icon" title={t('tasks.preview')} onClick={() => open(a)}>
                          <ExternalLink className="size-3.5" />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" title={t('files.download')} onClick={() => open(a)}>
                        <Download className="size-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" title={t('files.delete')} onClick={() => removeAtt.mutate(a.id)}>
                        <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
                      </Button>
                    </li>
                  ))}
              </ul>

              {/* Удалённые из менеджера — ссылка сохранена, файл недоступен (SPEC §8.3) */}
              {(attachments.data ?? []).some((a) => a.deleted) && (
                <ul className="mt-1 space-y-1">
                  {(attachments.data ?? [])
                    .filter((a) => a.deleted)
                    .map((a) => (
                      <li
                        key={a.id}
                        className="flex items-center gap-2 rounded-md border border-dashed px-2.5 py-2 text-sm text-muted-foreground"
                        title={a.name}
                      >
                        🚫 <span className="min-w-0 flex-1 truncate line-through">{a.name}</span>
                        <span className="whitespace-nowrap text-xs">{t('chat.fileDeleted')}</span>
                      </li>
                    ))}
                </ul>
              )}

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
            {(attachments.data ?? []).filter((a) => a.mime.startsWith('image/') && !a.deleted).length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-muted-foreground">{t('tasks.manageImages')}</summary>
                <ul className="mt-1 space-y-1">
                  {attachments.data!
                    .filter((a) => a.mime.startsWith('image/') && !a.deleted)
                    .map((a) => (
                      <li key={a.id} className="flex items-center gap-2 text-xs">
                        <span className="min-w-0 flex-1 truncate">{a.name}</span>
                        <Button variant="ghost" size="icon" title={t('files.download')} onClick={() => open(a)}>
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
  )

  // Мета-строка: статус · приоритет · исполнитель · дедлайн · оценка · спринт (read-only)
  const g = groups.find((x) => x.id === task.groupId)
  const StatusIcon = STATUS_ICON[task.status]
  const meta = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <span className="inline-flex items-center gap-1.5">
        <StatusIcon className={cn('size-4', STATUS_COLOR[task.status])} />
        {t(`tasks.status.${task.status}`)}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className={cn('size-2 rounded-full', PRIORITY_DOT[task.priority])} />
        {t(`tasks.priority.${task.priority}`)}
      </span>
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        {task.assignee ? <Avatar name={task.assignee.name} src={task.assignee.avatarUrl} size={18} /> : <User className="size-3.5" />}
        {task.assignee?.name ?? t('tasks.unassigned')}
      </span>
      {task.dueDate && (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <CalendarDays className="size-3.5" />
          {new Date(task.dueDate).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short', year: 'numeric' })}
        </span>
      )}
      {task.estimateMinutes ? <span className="text-muted-foreground">⏱ {fmtEstimate(task.estimateMinutes)}</span> : null}
      {g && (
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-full" style={{ backgroundColor: g.color }} />
          {g.name}
        </span>
      )}
    </div>
  )

  return (
    <div
      className="relative flex h-full flex-col bg-background"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer.files.length) pickFiles(e.dataTransfer.files)
      }}
    >
      {sharing && (
        <ShareDialog
          type="task"
          id={task.id}
          title={`${task.number} ${task.title}`}
          appPath={`/p/${routeProjectId}/tasks/${task.id}`}
          canPublish={canEdit}
          onClose={() => setSharing(false)}
        />
      )}

      {/* Верхняя панель: назад · номер · поделиться / редактировать / удалить */}
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onClose} className="gap-1.5">
          <ArrowLeft className="size-4 rtl:-scale-x-100" />
          <span className="hidden sm:inline">{t('tasks.backToTasks')}</span>
        </Button>
        <span className="text-xs font-medium text-muted-foreground">{task.number}</span>
        {/* Кто сейчас правит задачу (SPEC §8.18) */}
        {lockedBy && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2 py-1 text-xs text-amber-500" title={t('tasks.editingNow', { name: lockedBy.name })}>
            <Avatar name={lockedBy.name} src={lockedBy.avatarUrl} size={16} />
            <span className="hidden sm:inline">{t('tasks.editingNow', { name: lockedBy.name })}</span>
          </span>
        )}
        <div className="ms-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setSharing(true)} className="gap-1.5" title={t('tasks.share')}>
            <Share2 className="size-4" />
            <span className="hidden sm:inline">{t('tasks.share')}</span>
          </Button>
          {canEdit && (
            <Button
              variant={editing ? 'brand' : 'outline'}
              size="sm"
              disabled={Boolean(lockedBy)}
              title={lockedBy ? t('tasks.lockedByOther') : undefined}
              onClick={() => setEditing((v) => !v)}
              className="gap-1.5"
            >
              <Pencil className="size-4" />
              <span className="hidden sm:inline">{t('about.edit')}</span>
            </Button>
          )}
          {canEdit && (
            <Button
              variant="ghost"
              size="icon"
              title={t('files.delete')}
              onClick={async () => {
                if (await confirm({ title: t('tasks.deleteConfirm', { number: task.number }), destructive: true, confirmLabel: t('files.delete') }))
                  onDelete()
              }}
            >
              <Trash2 className="size-4 text-muted-foreground hover:text-destructive" />
            </Button>
          )}
        </div>
      </header>

      {/* Двухколоночный контент; на узких экранах правая форма — оверлеем снизу */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Левая колонка — чтение */}
        <div className="min-w-0 flex-1 space-y-6 overflow-y-auto p-4 sm:p-6">
          <div className="space-y-3 border-b pb-5">
            <h1 className="text-xl font-bold tracking-tight">{task.title}</h1>
            {meta}
          </div>

          {/* Без карточки: описание — основное содержимое задачи, а не
              вложенный блок. В чате у сообщений подложки тоже нет. */}
          {task.description?.trim() && (
            <div className="msg-md max-w-none break-words text-sm">
              <RichEditor value={task.description} onChange={() => {}} mentions={[]} preset="full" readOnly />
            </div>
          )}

          {attachmentsSection}

          {/* Связь с чатом: файлы из переписки → переход к сообщению */}
          {chatFiles.length > 0 && (
            <section className="space-y-2">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                <MessagesSquare className="size-3.5" />
                {t('tasks.fromChat')}
              </h3>
              <ul className="space-y-1">
                {chatFiles.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{a.name}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => navigate({ pathname: `/p/${window.location.hash.split("/")[2]}/tasks`, search: `?msg=${a.messageId}` })}
                    >
                      <ExternalLink className="size-3.5" />
                      {t('files.jumpToChat')}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Заметки ИИ (SPEC §8.14) */}
          <div className="rounded-xl border bg-card p-4">
            <TaskNotes taskId={task.id} canEdit={canEdit} />
          </div>

          {/* Комментарии (SPEC §8.9) */}
          <div className="rounded-xl border bg-card p-4">
            <TaskComments taskId={task.id} members={members} lang={i18n.language} meId={meId} onFilesChanged={refresh} />
          </div>
        </div>

        {/* Правая колонка — форма редактирования (скрыта до «Редактировать»). Мобила: оверлей снизу */}
        {editing && (
          <>
            <div className="absolute inset-0 z-20 bg-black/40 sm:hidden" onClick={() => setEditing(false)} />
            <div className="absolute inset-x-0 bottom-0 z-30 max-h-[85%] space-y-4 overflow-y-auto rounded-t-2xl border-t bg-background p-4 shadow-2xl sm:static sm:z-0 sm:max-h-none sm:w-96 sm:rounded-none sm:border-s sm:border-t-0 sm:p-5 sm:shadow-none">
              <div className="flex items-center justify-between sm:hidden">
                <h2 className="text-sm font-semibold">{t('about.edit')}</h2>
                <Button variant="ghost" size="icon" onClick={() => setEditing(false)}>
                  <X className="size-4" />
                </Button>
              </div>
              {editForm}
            </div>
          </>
        )}
      </div>

      {/* Встроенный просмотрщик вложений */}
      {viewing && <FileViewer file={viewing} onClose={() => setViewing(null)} />}
      {asking && (
        <UploadDialog
          files={asking}
          onCancel={() => setAsking(null)}
          onConfirm={({ files, keepOriginal }) => {
            setAsking(null)
            void upload(files, keepOriginal)
          }}
        />
      )}
    </div>
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
