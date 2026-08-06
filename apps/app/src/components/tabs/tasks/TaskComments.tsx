import { useEffect, useMemo, useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import ReactMarkdown from 'react-markdown'
import { CornerUpLeft, Paperclip, Pencil, Trash2, X } from 'lucide-react'
import { api, API_URL, getProjectToken } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { RichEditor } from '@/components/ui/rich-editor'
import { Avatar } from '@/components/ui/avatar'
import { ClipboardBanner } from '@/components/ui/clipboard-banner'
import { useConfirm } from '@/components/ui/confirm'
import type { Member } from './types'
import { FileViewer, type ViewerFile } from '@/components/files/FileViewer'

// Комментарии к задаче (SPEC §8.9): минимальный Tiptap + mentions + ответы + файлы.

/**
 * Текст без разметки — для мест в одну строку: цитата ответа. Редактор
 * хранит HTML, и теги в такой строке видны как текст.
 */
const plainText = (html: string) => {
  const el = document.createElement('div')
  el.innerHTML = html
  return (el.textContent ?? '').trim()
}

type CommentFile = { id: string; name: string; mime: string; deleted: boolean }
type Comment = {
  id: string
  body: string
  replyToId: string | null
  createdAt: string
  author: { id: string; name: string; avatarUrl: string | null } | null
  files: CommentFile[]
}

// @[Label](id) → @Label для отображения
function renderMentions(text: string) {
  return text.replace(/@\[([^\]]*)\]\([^)]+\)/g, '@$1')
}

export function TaskComments({
  taskId,
  members,
  lang,
  meId,
  onFilesChanged,
}: {
  taskId: string
  members: Member[]
  lang: string
  meId?: string
  onFilesChanged: () => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [body, setBody] = useState('')
  const [replyTo, setReplyTo] = useState<Comment | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [pending, setPending] = useState<File[]>([])
  // Оригиналы и здесь по желанию: механизм общий, и делать в комментариях
  // исключение значит заставлять помнить, где как. По умолчанию сжимаем.
  const [keepOriginal, setKeepOriginal] = useState(false)
  // Открытый файл вложения: тот же просмотрщик, что и в задаче — с зумом,
  // pdf и видео. Раньше вложения комментария вообще не открывались.
  const [viewing, setViewing] = useState<ViewerFile | null>(null)

  // Ссылки на превью держим отдельно и освобождаем при смене набора:
  // createObjectURL прямо в разметке создавал бы новую ссылку на каждый
  // перерисовку, и браузер держал бы их все до перезагрузки страницы.
  const previews = useMemo(
    () => pending.map((f) => (f.type.startsWith('image/') ? URL.createObjectURL(f) : null)),
    [pending],
  )
  useEffect(() => () => previews.forEach((u) => u && URL.revokeObjectURL(u)), [previews])
  const [editorKey, setEditorKey] = useState(0) // сброс редактора после отправки
  const fileRef = useRef<HTMLInputElement>(null)

  const onErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))
  const mentions = members.map((m) => ({ id: m.user.id, label: m.user.name || m.user.email, avatarUrl: m.user.avatarUrl }))

  const commentsQ = useQuery({
    queryKey: ['task-comments', taskId],
    queryFn: () => api<Comment[]>(`/api/v1/tasks/${taskId}/comments`, {}, 'project'),
  })

  // Ссылки на превью картинок из вложений. Тем же способом, что во
  // вложениях задачи: presigned на час, запрашиваем разом на все комментарии.
  const previewUrls = useQuery({
    queryKey: ['comment-previews', taskId, commentsQ.data?.map((c) => c.files.map((f) => f.id).join(',')).join('|')],
    enabled: Boolean(commentsQ.data?.some((c) => c.files.some((f) => f.mime.startsWith('image/') && !f.deleted))),
    queryFn: async () => {
      const images = (commentsQ.data ?? []).flatMap((c) => c.files.filter((f) => f.mime.startsWith('image/') && !f.deleted))
      const entries = await Promise.all(
        images.map(async (f) => {
          try {
            const { url } = await api<{ url: string }>(`/api/v1/files/${f.id}/view-url`, {}, 'project')
            return [f.id, url] as const
          } catch {
            // Файл мог исчезнуть — показываем скрепку вместо битой картинки.
            return [f.id, ''] as const
          }
        }),
      )
      return Object.fromEntries(entries) as Record<string, string>
    },
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['task-comments', taskId] })
    onFilesChanged() // файлы комментария появляются в разделе Files задачи
  }

  // загрузить прикреплённые файлы (как файлы проекта без владельца-сообщения), получить их id
  async function uploadPending(): Promise<string[]> {
    const ids: string[] = []
    for (const file of pending) {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('pending', '1') // временный до отправки комментария (SPEC §8.17)
      if (keepOriginal) fd.append('keepOriginal', '1')
      const res = await fetch(`${API_URL}/api/v1/files`, { method: 'POST', headers: { Authorization: `Bearer ${getProjectToken()}` }, body: fd })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(b.error ?? res.statusText)
      }
      const f = (await res.json()) as { id: string }
      ids.push(f.id)
    }
    return ids
  }

  const submit = useMutation({
    mutationFn: async () => {
      const attachmentIds = await uploadPending()
      return api<Comment>(
        `/api/v1/tasks/${taskId}/comments`,
        { method: 'POST', body: JSON.stringify({ body, replyToId: replyTo?.id ?? null, attachmentIds }) },
        'project',
      )
    },
    onSuccess: () => {
      setBody('')
      setReplyTo(null)
      setPending([])
      setKeepOriginal(false)
      setEditorKey((k) => k + 1)
      refresh()
    },
    onError: onErr,
  })

  const saveEdit = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      api(`/api/v1/tasks/${taskId}/comments/${id}`, { method: 'PATCH', body: JSON.stringify({ body }) }, 'project'),
    onSuccess: () => {
      setEditing(null)
      refresh()
    },
    onError: onErr,
  })

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/tasks/${taskId}/comments/${id}`, { method: 'DELETE' }, 'project'),
    onSuccess: refresh,
    onError: onErr,
  })

  const byId = new Map((commentsQ.data ?? []).map((c) => [c.id, c]))

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">{t('tasks.comments')}</h3>

      <ul className="space-y-1.5">
        {(commentsQ.data ?? []).map((c) => {
          const parent = c.replyToId ? byId.get(c.replyToId) : null
          const mine = c.author?.id === meId
          return (
            <li key={c.id} className="rounded-lg border bg-card px-3 py-1.5">
              <div className="flex items-center gap-2">
                <Avatar name={c.author?.name ?? 'AI'} src={c.author?.avatarUrl} size={20} />
                <span className="text-xs font-medium">{c.author?.name ?? 'AI'}</span>
                <span className="text-xs text-muted-foreground">{new Date(c.createdAt).toLocaleString(lang)}</span>
                <div className="ms-auto flex items-center gap-1">
                  <button
                    className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    title={t('tasks.reply')}
                    onClick={() => setReplyTo(c)}
                  >
                    <CornerUpLeft className="size-4" />
                  </button>
                  {mine && (
                    <button
                      className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                      title={t('about.edit')}
                      onClick={() => setEditing(c.id)}
                    >
                      <Pencil className="size-4" />
                    </button>
                  )}
                  {mine && (
                    <button
                      className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      title={t('files.delete')}
                      onClick={async () => {
                        if (await confirm({ title: t('tasks.deleteCommentConfirm'), destructive: true, confirmLabel: t('files.delete') })) remove.mutate(c.id)
                      }}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </div>
              </div>

              {parent && (
                <div className="mb-1 border-s-2 ps-2 text-xs text-muted-foreground">
                  <span className="font-medium">{parent.author?.name ?? 'AI'}:</span> <span className="line-clamp-1">{plainText(renderMentions(parent.body))}</span>
                </div>
              )}

              {editing === c.id ? (
                <EditForm initial={c.body} mentions={mentions} onCancel={() => setEditing(null)} onSave={(b) => saveEdit.mutate({ id: c.id, body: b })} />
              ) : (
                <div className="msg-md break-words text-sm">
                  {/* Тем же редактором, что и писали: он отдаёт HTML, а
                      ReactMarkdown его не разбирал и печатал теги как текст.
                      readOnly — значит просто разметка, без правки. */}
                  <RichEditor value={renderMentions(c.body)} onChange={() => {}} mentions={[]} preset="minimal" readOnly />
                </div>
              )}

              {c.files.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {c.files.map((f) =>
                    f.deleted ? (
                      <span key={f.id} className="inline-flex items-center gap-1 rounded border border-dashed px-1.5 py-0.5 text-xs text-muted-foreground line-through">
                        🚫 {f.name}
                      </span>
                    ) : (
                      <button
                        key={f.id}
                        onClick={() => setViewing({ id: f.id, name: f.name, mime: f.mime })}
                        className="inline-flex items-center gap-1.5 rounded border py-0.5 pe-1.5 ps-1 text-xs transition-colors hover:border-brand hover:text-brand"
                      >
                        {/* Превью вместо скрепки: по имени вроде
                            «354881888_6f937116-….webp» не понять, что внутри. */}
                        {f.mime.startsWith('image/') && previewUrls.data?.[f.id] ? (
                          <img src={previewUrls.data[f.id]} alt="" className="no-zoom size-5 rounded object-cover" />
                        ) : (
                          <Paperclip className="size-3" />
                        )}
                        {f.name}
                      </button>
                    ),
                  )}
                </div>
              )}
            </li>
          )
        })}
        {(commentsQ.data?.length ?? 0) === 0 && <p className="text-xs text-muted-foreground">{t('tasks.noComments')}</p>}
      </ul>

      {/* Composer */}
      <div className="rounded-lg border p-2">
        {replyTo && (
          <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            <CornerUpLeft className="size-3" />
            {t('tasks.replyingTo', { name: replyTo.author?.name ?? 'AI' })}
            <button onClick={() => setReplyTo(null)} className="hover:text-foreground">
              <X className="size-3" />
            </button>
          </div>
        )}
        <RichEditor
          key={editorKey}
          value={body}
          onChange={(md) => setBody(md)}
          onSubmit={() => body.trim() && submit.mutate()}
          placeholder={t('tasks.commentPlaceholder')}
          mentions={mentions}
          preset="minimal"
        />
        {pending.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {pending.map((f, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 rounded border py-0.5 pe-1.5 ps-1 text-xs">
                {/* Превью вместо скрепки: по имени файла со скриншота не
                    понять, тот ли он — а прикрепив не тот, узнаёшь об этом
                    уже после отправки. */}
                {f.type.startsWith('image/') ? (
                  <img src={previews[i] ?? ''} alt="" className="no-zoom size-5 rounded object-cover" />
                ) : (
                  <Paperclip className="size-3" />
                )}
                {f.name}
                <button onClick={() => setPending((p) => p.filter((_, j) => j !== i))} className="hover:text-destructive">
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        {pending.some((f) => f.type.startsWith('image/')) && (
          <label className="mt-1.5 flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
            <input
              type="checkbox"
              checked={keepOriginal}
              onChange={(e) => setKeepOriginal(e.target.checked)}
              className="size-3.5 accent-brand"
            />
            {t('upload.keepOriginal')}
          </label>
        )}
        <div className="mt-1.5 flex items-center justify-between">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              // Файлы забираем ДО сброса value: setPending выполняет функцию
              // отложенно, а сброс к тому времени уже обнулил e.target.files —
              // добавлять оказывалось нечего. Сброс нужен, чтобы повторный
              // выбор того же файла тоже считался изменением.
              const picked = Array.from(e.target.files ?? [])
              e.target.value = ''
              if (picked.length) setPending((p) => [...p, ...picked])
            }}
          />
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>
              <Paperclip className="size-3.5" />
              {t('tasks.attach')}
            </Button>
            <ClipboardBanner
              compact
              onImage={(files) => setPending((p) => [...p, ...files])}
              onText={(text) => {
                setBody((b) => (b ? b + '\n' + text : text))
                setEditorKey((k) => k + 1) // пересоздать редактор с новым значением
              }}
            />
          </div>
          <Button variant="brand" size="sm" disabled={!body.trim() || submit.isPending} onClick={() => submit.mutate()}>
            {t('tasks.send')}
          </Button>
        </div>
      </div>
      {viewing && <FileViewer file={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

function EditForm({
  initial,
  mentions,
  onCancel,
  onSave,
}: {
  initial: string
  mentions: { id: string; label: string; avatarUrl: string | null }[]
  onCancel: () => void
  onSave: (body: string) => void
}) {
  const { t } = useTranslation()
  const [body, setBody] = useState(initial)
  return (
    <div className="space-y-1.5">
      <RichEditor value={body} onChange={(md) => setBody(md)} onSubmit={() => body.trim() && onSave(body)} mentions={mentions} preset="minimal" />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('confirm.cancel')}
        </Button>
        <Button variant="brand" size="sm" disabled={!body.trim()} onClick={() => onSave(body)}>
          {t('projectForm.save')}
        </Button>
      </div>
    </div>
  )
}
