import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import ReactMarkdown from 'react-markdown'
import { AlertTriangle, Info, Lightbulb, Loader2, RefreshCw, Sparkles, X, XCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

// Заметки ИИ к задаче (SPEC §8.14): факт / проблема / рекомендация / опровержение.
type NoteKind = 'fact' | 'issue' | 'recommendation' | 'rebuttal'
type Note = { id: string; kind: NoteKind; body: string; createdAt: string }

const KIND: Record<NoteKind, { icon: typeof Info; className: string; dot: string }> = {
  fact: { icon: Info, className: 'border-sky-500/30 bg-sky-500/5', dot: 'text-sky-500' },
  issue: { icon: AlertTriangle, className: 'border-orange-500/30 bg-orange-500/5', dot: 'text-orange-500' },
  recommendation: { icon: Lightbulb, className: 'border-brand/30 bg-brand/5', dot: 'text-brand' },
  rebuttal: { icon: XCircle, className: 'border-destructive/30 bg-destructive/5', dot: 'text-destructive' },
}

export function TaskNotes({ taskId, canEdit, notesPending }: { taskId: string; canEdit: boolean; notesPending?: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const onErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

  const notesQ = useQuery({
    queryKey: ['task-notes', taskId],
    queryFn: () => api<Note[]>(`/api/v1/tasks/${taskId}/notes`, {}, 'project'),
    // если заметки генерируются в фоне — опрашиваем, пока не появятся
    refetchInterval: (q) => (notesPending && (q.state.data?.length ?? 0) === 0 ? 2500 : false),
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ['task-notes', taskId] })

  const regenerate = useMutation({
    mutationFn: () => api<{ count: number }>(`/api/v1/tasks/${taskId}/notes/regenerate`, { method: 'POST' }, 'project'),
    onSuccess: (r) => {
      toast.success(t('notes.regenerated', { count: r.count }))
      refresh()
    },
    onError: onErr,
  })

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/tasks/${taskId}/notes/${id}`, { method: 'DELETE' }, 'project'),
    onSuccess: refresh,
    onError: onErr,
  })

  const notes = notesQ.data ?? []
  const loading = notesPending && notes.length === 0

  if (!loading && notes.length === 0 && !canEdit) return null

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="size-3.5 text-brand" />
          {t('notes.title')}
        </h3>
        {canEdit && (
          <Button variant="ghost" size="sm" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
            {regenerate.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            {t('notes.regenerate')}
          </Button>
        )}
      </div>

      {loading && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin text-brand" />
          {t('notes.generating')}
        </p>
      )}

      {!loading && notes.length === 0 && <p className="text-xs text-muted-foreground">{t('notes.empty')}</p>}

      <ul className="space-y-2">
        {notes.map((n) => {
          const meta = KIND[n.kind]
          const Icon = meta.icon
          return (
            <li key={n.id} className={cn('rounded-lg border p-2.5', meta.className)}>
              <div className="mb-1 flex items-center gap-1.5">
                <Icon className={cn('size-3.5', meta.dot)} />
                <span className="text-xs font-medium">{t(`notes.kind.${n.kind}`)}</span>
                {canEdit && (
                  <button className="ms-auto text-muted-foreground hover:text-destructive" title={t('files.delete')} onClick={() => remove.mutate(n.id)}>
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
              <div className="msg-md break-words text-sm">
                <ReactMarkdown>{n.body}</ReactMarkdown>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
