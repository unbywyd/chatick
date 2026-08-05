import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check, Copy, GripVertical, ListChecks, Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { RichEditor } from '@/components/ui/rich-editor'

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

// Заметки, написанные до перехода на редактор, лежат в базе обычным текстом.
// Прогонять их через разбор HTML нельзя: переносы строк схлопнутся, а «5 < 10»
// превратится в обрывок тега. Поэтому старое показываем как текст, новое — как
// разметку.
const looksLikeHtml = (s: string) => /<(p|ul|ol|li|h[1-6]|blockquote|pre|strong|em|code|a|br)\b/i.test(s)
const stripTags = (s: string) =>
  s
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
const plain = (s: string) => (looksLikeHtml(s) ? stripTags(s) : s)
const isBlank = (s: string) => !plain(s).trim()

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
  // В буфер уходит текст, а не разметка: её вставят в чат и увидят теги.
  const asText = (it: Item) => (isBlank(it.note) ? it.text : `${it.text}\n${plain(it.note)}`)

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

  const openNote = (it: Item) => {
    // Старую текстовую заметку отдаём редактору абзацем, иначе он покажет её
    // одной строкой и переносы пропадут при первом же сохранении.
    setNoteDraft(looksLikeHtml(it.note) ? it.note : it.note ? `<p>${it.note.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>` : '')
    setNoting(it.id)
  }

  /**
   * Закрыть редактор ответа.
   *
   * Пустой черновик сохраняем как пустую строку, а не как `<p></p>`: иначе
   * «стёр и ушёл» оставлял бы заметку, которая выглядит пустой, но занимает
   * место в потоке и не даёт кнопке вернуться под пункт.
   */
  const saveNote = (it: Item) => {
    const next = isBlank(noteDraft) ? '' : noteDraft
    if (next !== it.note) patch.mutate({ id: it.id, note: next })
    setNoting(null)
  }

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
          // relative + hover:z-10 — под кнопку «ответить», которая висит на
          // absolute под пунктом и при наведении должна лечь ПОВЕРХ соседнего.
          <li key={it.id} className="group relative rounded-md px-1 py-0.5 hover:z-10 hover:bg-secondary/40">
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

              {/* relative — точка отсчёта для «ответить»: она встаёт ровно под
                  текстом пункта и по его левому краю, какой бы длины он ни был. */}
              <div className="relative min-w-0 flex-1">
                <span className={cn('block break-words text-sm', it.done && 'text-muted-foreground line-through')}>
                  {it.text}
                </span>

                {/* Заметка под пунктом: ответ на вопрос или пояснение */}
                {noting === it.id ? (
                  <div className="mt-1 rounded-md border">
                    <RichEditor
                      value={noteDraft}
                      onChange={(html) => setNoteDraft(html)}
                      onSubmit={() => saveNote(it)}
                      mentions={[]}
                      preset="minimal"
                      placeholder={t('checklist.notePlaceholder')}
                    />
                    <div className="flex gap-1 border-t p-1">
                      <Button size="sm" variant="brand" onClick={() => saveNote(it)}>
                        {t('checklist.saveNote')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setNoting(null)}>
                        {t('common.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : !isBlank(it.note) ? (
                  // Заметку правят по клику, поэтому она сама и есть кнопка:
                  // на всю ширину и с полем вокруг, чтобы попадать не целясь.
                  <div
                    role={canEdit ? 'button' : undefined}
                    tabIndex={canEdit ? 0 : undefined}
                    onClick={canEdit ? () => openNote(it) : undefined}
                    onKeyDown={canEdit ? (e) => (e.key === 'Enter' ? openNote(it) : undefined) : undefined}
                    className={cn(
                      '-mx-1 mt-1 block break-words rounded px-1 py-0.5 text-sm text-muted-foreground',
                      canEdit && 'cursor-text hover:bg-secondary/60 hover:text-foreground',
                    )}
                  >
                    {looksLikeHtml(it.note) ? (
                      <RichEditor value={it.note} onChange={() => {}} mentions={[]} preset="minimal" readOnly />
                    ) : (
                      <span className="block whitespace-pre-wrap">{it.note}</span>
                    )}
                  </div>
                ) : canEdit ? (
                  // Кнопка не занимает места в потоке: пустая полоска под каждым
                  // пунктом раздвигала список так, что читать его было нельзя.
                  // Висит под текстом, появляется при наведении и накрывает
                  // соседний пункт — но только пока курсор здесь.
                  <button
                    onClick={() => openNote(it)}
                    // pointer-events-none в невидимом состоянии обязательны:
                    // прозрачная кнопка висит НАД соседним пунктом и иначе
                    // перехватывала бы клики по нему.
                    className="pointer-events-none absolute start-0 top-full z-10 mt-1 rounded border bg-background px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
                  >
                    {t('checklist.addNote')}
                  </button>
                ) : null}
              </div>

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
