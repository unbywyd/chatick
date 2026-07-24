import { useState, useRef } from 'react'
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

// Комментарии к задаче (SPEC §8.9): минимальный Tiptap + mentions + ответы + файлы.

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
  const [editorKey, setEditorKey] = useState(0) // сброс редактора после отправки
  const fileRef = useRef<HTMLInputElement>(null)

  const onErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))
  const mentions = members.map((m) => ({ id: m.user.id, label: m.user.name || m.user.email, avatarUrl: m.user.avatarUrl }))

  const commentsQ = useQuery({
    queryKey: ['task-comments', taskId],
    queryFn: () => api<Comment[]>(`/api/v1/tasks/${taskId}/comments`, {}, 'project'),
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

      <ul className="space-y-2.5">
        {(commentsQ.data ?? []).map((c) => {
          const parent = c.replyToId ? byId.get(c.replyToId) : null
          const mine = c.author?.id === meId
          return (
            <li key={c.id} className="rounded-lg border bg-card px-3 py-2">
              <div className="mb-1 flex items-center gap-2">
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
                  <span className="font-medium">{parent.author?.name ?? 'AI'}:</span> <span className="line-clamp-1">{renderMentions(parent.body)}</span>
                </div>
              )}

              {editing === c.id ? (
                <EditForm initial={c.body} mentions={mentions} onCancel={() => setEditing(null)} onSave={(b) => saveEdit.mutate({ id: c.id, body: b })} />
              ) : (
                <div className="msg-md break-words text-sm">
                  <ReactMarkdown>{renderMentions(c.body)}</ReactMarkdown>
                </div>
              )}

              {c.files.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {c.files.map((f) =>
                    f.deleted ? (
                      <span key={f.id} className="inline-flex items-center gap-1 rounded border border-dashed px-1.5 py-0.5 text-xs text-muted-foreground line-through">
                        🚫 {f.name}
                      </span>
                    ) : (
                      <span key={f.id} className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs">
                        <Paperclip className="size-3" /> {f.name}
                      </span>
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
              <span key={i} className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs">
                <Paperclip className="size-3" /> {f.name}
                <button onClick={() => setPending((p) => p.filter((_, j) => j !== i))} className="hover:text-destructive">
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="mt-1.5 flex items-center justify-between">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) setPending((p) => [...p, ...Array.from(e.target.files!)])
              e.target.value = ''
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
