import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { BookText, Check, Pencil, Send, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { RichEditor, type RichMention } from '@/components/ui/rich-editor'
import { DatePicker } from '@/components/ui/date-picker'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { useConfirm } from '@/components/ui/confirm'

/**
 * Журнал работы: что человек делал в проекте и где остановился.
 *
 * Две вещи, которые интерфейс обязан говорить громко:
 *
 * 1. Черновик виден только автору. Написать «для себя» и обнаружить, что это
 *    прочла вся команда, — обида, после которой писать перестают. Поэтому у
 *    черновика не бледная метка сбоку, а рамка, подпись и своё место сверху.
 *
 * 2. Опубликованное не правится. Кнопки «изменить» у него нет вовсе — не
 *    заблокированной, а никакой: серая кнопка обещает, что где-то есть
 *    способ, и человек идёт его искать.
 */

type Entry = {
  id: string
  body: string
  status: 'draft' | 'published'
  publishedAt: string | null
  createdAt: string
  author: { id: string; name: string; avatarUrl: string | null } | null
  task: { id: string; number: string; title: string } | null
}

export function WorkLogTab({ projectId, meId }: { projectId: string; meId?: string }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()

  const [authorId, setAuthorId] = useState<string>('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [draftBody, setDraftBody] = useState('')
  const [editing, setEditing] = useState(false)

  const qs = new URLSearchParams()
  if (authorId !== 'all') qs.set('authorId', authorId)
  if (from) qs.set('from', from)
  if (to) qs.set('to', to)

  const listQ = useQuery({
    queryKey: ['worklog', projectId, authorId, from, to],
    queryFn: () => api<{ items: Entry[]; canSeeEveryone: boolean }>(`/api/v1/worklog?${qs}`, {}, 'project'),
  })
  // Упоминания в записи: «ждал ответа от Алекса» — обычное дело в рассказе о
  // том, где встал.
  const members = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => api<{ user: { id: string; name: string; avatarUrl: string | null } }[]>(`/api/v1/projects/${projectId}/members`),
  })
  const mentionItems: RichMention[] = (members.data ?? []).map((m) => ({
    id: m.user.id,
    label: m.user.name,
    avatarUrl: m.user.avatarUrl,
  }))

  const authorsQ = useQuery({
    queryKey: ['worklog-authors', projectId],
    queryFn: () => api<{ items: { id: string; name: string; avatarUrl: string | null }[] }>('/api/v1/worklog/authors', {}, 'project'),
  })

  const items = listQ.data?.items ?? []
  const canSeeEveryone = listQ.data?.canSeeEveryone ?? false
  /** Свой черновик — он один, и он всегда сверху: это то, что дописывают. */
  const draft = items.find((x) => x.status === 'draft' && x.author?.id === meId)
  const published = items.filter((x) => x.status === 'published')

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['worklog', projectId] })
    void qc.invalidateQueries({ queryKey: ['worklog-authors', projectId] })
  }

  const save = useMutation({
    mutationFn: async (body: string) => {
      if (draft) return api(`/api/v1/worklog/${draft.id}`, { method: 'PATCH', body: JSON.stringify({ body }) }, 'project')
      return api('/api/v1/worklog', { method: 'POST', body: JSON.stringify({ body }) }, 'project')
    },
    onSuccess: () => {
      setEditing(false)
      invalidate()
    },
    onError: () => toast.error(t('worklog.saveFailed')),
  })

  const publish = useMutation({
    mutationFn: (id: string) => api(`/api/v1/worklog/${id}/publish`, { method: 'POST' }, 'project'),
    onSuccess: () => {
      setDraftBody('')
      setEditing(false)
      invalidate()
      toast.success(t('worklog.published'))
    },
    onError: () => toast.error(t('worklog.publishFailed')),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/worklog/${id}`, { method: 'DELETE' }, 'project'),
    onSuccess: invalidate,
    onError: () => toast.error(t('worklog.deleteFailed')),
  })

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

  return (
    <div className="page-w space-y-5 p-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <BookText className="size-5" />
          {t('worklog.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('worklog.subtitle')}</p>
      </div>

      {/* Черновик — свой, один, всегда сверху и всегда в рамке. */}
      <section
        className={cn(
          'rounded-lg border p-4',
          // Пунктир и подложка: «это ещё не история». Отличается от карточек
          // ленты с одного взгляда, не читая подписи.
          'border-dashed bg-secondary/30',
        )}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{draft ? t('worklog.yourDraft') : t('worklog.newEntry')}</span>
          <span className="text-xs text-muted-foreground">{t('worklog.draftPrivate')}</span>
        </div>

        {draft && !editing ? (
          <>
            <div
              className="prose prose-sm dark:prose-invert max-w-none"
              dir="auto"
              dangerouslySetInnerHTML={{ __html: draft.body }}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setDraftBody(draft.body)
                  setEditing(true)
                }}
              >
                <Pencil className="size-3.5" />
                {t('worklog.edit')}
              </Button>
              <Button variant="brand" size="sm" onClick={() => publish.mutate(draft.id)} disabled={publish.isPending}>
                <Send className="size-3.5" />
                {t('worklog.publish')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  if (await confirm({ title: t('worklog.deleteDraftConfirm') })) remove.mutate(draft.id)
                }}
              >
                <Trash2 className="size-3.5" />
                {t('worklog.delete')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <RichEditor
              value={draftBody}
              onChange={setDraftBody}
              placeholder={t('worklog.placeholder')}
              mentions={mentionItems}
              preset="minimal"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => save.mutate(draftBody)}
                disabled={!draftBody.replace(/<[^>]*>/g, '').trim() || save.isPending}
              >
                <Check className="size-3.5" />
                {t('worklog.saveDraft')}
              </Button>
              {draft && (
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                  {t('common.cancel')}
                </Button>
              )}
            </div>
          </>
        )}
      </section>

      {/* Фильтры — только тому, кому есть между кем выбирать. */}
      {canSeeEveryone && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={authorId} onValueChange={setAuthorId}>
            <SelectTrigger className="w-52">
              <SelectValue placeholder={t('worklog.everyone')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('worklog.everyone')}</SelectItem>
              {(authorsQ.data?.items ?? []).map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DatePicker value={from} onChange={setFrom} placeholder={t('worklog.from')} className="w-36" />
          <DatePicker value={to} onChange={setTo} placeholder={t('worklog.to')} className="w-36" />
          {(authorId !== 'all' || from || to) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setAuthorId('all')
                setFrom('')
                setTo('')
              }}
            >
              {t('worklog.resetFilters')}
            </Button>
          )}
        </div>
      )}

      {/* Лента опубликованного. */}
      <div className="space-y-3">
        {published.length === 0 && !listQ.isLoading && (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('worklog.empty')}</p>
        )}
        {published.map((e) => (
          <article key={e.id} className="rounded-lg border p-4">
            <div className="mb-2 flex items-center gap-2">
              <Avatar src={e.author?.avatarUrl} name={e.author?.name ?? ''} className="size-6" />
              <span className="text-sm font-medium">{e.author?.name}</span>
              <span className="text-xs text-muted-foreground">{fmt(e.publishedAt ?? e.createdAt)}</span>
              {e.task && (
                <span className="ms-auto text-xs text-muted-foreground">
                  {e.task.number}
                </span>
              )}
            </div>
            <div
              className="prose prose-sm dark:prose-invert max-w-none"
              dir="auto"
              dangerouslySetInnerHTML={{ __html: e.body }}
            />
            {/* Кнопки правки нет вовсе — опубликованное неизменно. Удалить
                своё можно: передумал целиком — убирай, но не переписывай. */}
            {e.author?.id === meId && (
              <div className="mt-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    if (await confirm({ title: t('worklog.deleteConfirm') })) remove.mutate(e.id)
                  }}
                >
                  <Trash2 className="size-3.5" />
                  {t('worklog.delete')}
                </Button>
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  )
}
