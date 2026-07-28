import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check, Copy, GripVertical, ListChecks, Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

// Чек-лист задачи (SPEC §8.37).
//
// Задача часто не одно действие, а список: пройтись и отметить. К пункту
// иногда нужен ответ («каким ключом подписывать?»), но чаще нет — поэтому
// заметка необязательна и не мешает тем, кому нужен просто список галочек.
//
// Галочки ставятся и снимаются свободно: передумать — обычное дело.
// Автоматического «всё закрыто → задача готова» нет намеренно: закрыть
// пункты и завершить задачу — разные решения, могли остаться другие дела.

type Item = {
  id: string
  text: string
  note: string
  done: boolean
  doneBy: { id: string; name: string } | null
  doneAt: string | null
}

export function TaskChecklist({ taskId, canEdit }: { taskId: string; canEdit: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [adding, setAdding] = useState('')
  // Какой пункт сейчас с раскрытым полем заметки.
  const [noting, setNoting] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  // Какой пункт только что скопирован — галочка вместо иконки на пару секунд.
  const [copied, setCopied] = useState<string | null>(null)

  // Вопрос и ответ одним куском: именно в таком виде их несут в чат или в ИИ.
  // Без ответа — только вопрос, пустая строка снизу мусорит буфер.
  const asText = (it: Item) => (it.note.trim() ? `${it.text}\n${it.note.trim()}` : it.text)

  const copy = async (it: Item) => {
    try {
      await navigator.clipboard.writeText(asText(it))
      setCopied(it.id)
      setTimeout(() => setCopied((c) => (c === it.id ? null : c)), 1500)
    } catch {
      toast.error(t('composer.clipboardDenied'))
    }
  }

  const listQ = useQuery({
    queryKey: ['task-checklist', taskId],
    queryFn: () => api<{ items: Item[] }>(`/api/v1/tasks/${taskId}/checklist`, {}, 'project').then((r) => r.items),
  })

  const items = listQ.data ?? []
  const done = items.filter((i) => i.done).length
  const pct = items.length ? Math.round((done / items.length) * 100) : 0

  const refresh = () => qc.invalidateQueries({ queryKey: ['task-checklist', taskId] })
  const onErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

  const add = useMutation({
    mutationFn: (text: string) =>
      api(`/api/v1/tasks/${taskId}/checklist`, { method: 'POST', body: JSON.stringify({ text }) }, 'project'),
    onSuccess: () => {
      setAdding('')
      refresh()
    },
    onError: onErr,
  })

  const patch = useMutation({
    mutationFn: ({ id, ...body }: { id: string; done?: boolean; note?: string; text?: string }) =>
      api(`/api/v1/tasks/${taskId}/checklist/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, 'project'),
    onSuccess: refresh,
    onError: onErr,
  })

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/tasks/${taskId}/checklist/${id}`, { method: 'DELETE' }, 'project'),
    onSuccess: refresh,
    onError: onErr,
  })

  // Пустой список у того, кто не может править, — просто пустое место.
  if (!items.length && !canEdit) return null

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <ListChecks className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('checklist.title')}</h3>
        {items.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {done}/{items.length}
          </span>
        )}
      </div>

      {/* Полоса прогресса: видно, сколько осталось, не считая галочки глазами */}
      {items.length > 0 && (
        <div className="flex items-center gap-2">
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary">
            <div
              className={cn('h-full rounded-full transition-all', pct === 100 ? 'bg-brand' : 'bg-brand/60')}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className={cn('shrink-0 text-xs tabular-nums', pct === 100 ? 'text-brand' : 'text-muted-foreground')}>
            {pct}%
          </span>
        </div>
      )}

      <ul className="space-y-0.5">
        {items.map((it) => (
          <li key={it.id} className="group rounded-md px-1 py-1.5 hover:bg-secondary/40">
            <div className="flex items-start gap-2">
              {/* Ручка перетаскивания: пункт уносят в чат, чтобы спросить о нём
                  у ассистента, не перенабирая вопрос руками. */}
              <span
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', asText(it))
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                title={t('checklist.dragHint')}
                className="mt-1 shrink-0 cursor-grab text-muted-foreground opacity-0 transition-opacity active:cursor-grabbing group-hover:opacity-60 hover:!opacity-100"
              >
                <GripVertical className="size-4" />
              </span>

              <button
                disabled={!canEdit}
                onClick={() => patch.mutate({ id: it.id, done: !it.done })}
                title={it.doneBy ? t('checklist.doneBy', { name: it.doneBy.name }) : undefined}
                className={cn(
                  'mt-0.5 grid size-5 shrink-0 place-items-center rounded-[5px] border-2 transition-colors',
                  it.done ? 'border-brand bg-brand text-brand-foreground' : 'border-border hover:border-brand',
                  !canEdit && 'cursor-default opacity-60',
                )}
              >
                {it.done && <Check className="size-3.5" strokeWidth={3} />}
              </button>

              <span className="min-w-0 flex-1">
                <span className={cn('block break-words text-sm', it.done && 'text-muted-foreground line-through')}>
                  {it.text}
                </span>

                {/* Заметка под пунктом: ответ на вопрос или пояснение */}
                {noting === it.id ? (
                  <textarea
                    autoFocus
                    rows={2}
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    onBlur={() => {
                      if (noteDraft !== it.note) patch.mutate({ id: it.id, note: noteDraft })
                      setNoting(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setNoting(null)
                      // Enter сохраняет, Shift+Enter переносит строку: ответ
                      // обычно в одну фразу, тянуться к мыши ради неё незачем.
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        e.currentTarget.blur()
                      }
                    }}
                    placeholder={t('checklist.notePlaceholder')}
                    className="mt-1 w-full resize-none rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                ) : it.note ? (
                  // Заметку правят по клику, поэтому она сама и есть кнопка:
                  // на всю ширину и с полем вокруг, чтобы попадать не целясь.
                  <button
                    disabled={!canEdit}
                    onClick={() => {
                      setNoteDraft(it.note)
                      setNoting(it.id)
                    }}
                    className="-mx-1 mt-1 block w-[calc(100%+0.5rem)] whitespace-pre-wrap break-words rounded px-1 py-1 text-start text-sm text-muted-foreground hover:bg-secondary/60 hover:text-foreground disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    {it.note}
                  </button>
                ) : canEdit ? (
                  <button
                    onClick={() => {
                      setNoteDraft('')
                      setNoting(it.id)
                    }}
                    className="mt-1 py-0.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    {t('checklist.addNote')}
                  </button>
                ) : null}
              </span>

              {/* Копировать может любой, кто видит: чтение прав не требует */}
              <span className="mt-0.5 flex shrink-0 items-center gap-0.5">
                <button
                  onClick={() => copy(it)}
                  title={t('checklist.copy')}
                  className={cn(
                    'grid size-6 place-items-center rounded transition-opacity hover:bg-secondary focus-visible:opacity-100',
                    copied === it.id ? 'text-brand opacity-100' : 'text-muted-foreground opacity-0 group-hover:opacity-100',
                  )}
                >
                  {copied === it.id ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                </button>
                {canEdit && (
                  <button
                    onClick={() => remove.mutate(it.id)}
                    title={t('files.delete')}
                    className="grid size-6 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </span>
            </div>
          </li>
        ))}
      </ul>

      {canEdit && (
        <div className="flex items-center gap-1.5">
          <Plus className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              // Enter добавляет и оставляет поле пустым: пункты вносят
              // подряд, и тянуться к кнопке после каждого — лишнее.
              if (e.key === 'Enter' && adding.trim()) add.mutate(adding.trim())
            }}
            placeholder={t('checklist.addPlaceholder')}
            className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground"
          />
          {adding.trim() && (
            <Button variant="ghost" size="sm" onClick={() => add.mutate(adding.trim())} disabled={add.isPending}>
              {t('checklist.add')}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
