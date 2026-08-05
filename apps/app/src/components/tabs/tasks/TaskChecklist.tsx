import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Check, Copy, GripVertical, ListChecks, Plus, Trash2, X } from 'lucide-react'
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
//
// Отметить и ответить может каждый, кто задачу ВИДИТ: спрашивает один, а
// знает ответ обычно другой, и требовать от него права править задачу значит
// закрыть единственный путь, ради которого пункт и заведён. Состав списка —
// добавить, переписать, переставить, удалить — остаётся за canEdit.

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

// Вопрос и ответ одним куском: именно в таком виде их несут в чат или в ИИ.
// Без ответа — только вопрос, пустая строка снизу мусорит буфер. В буфер
// уходит текст, а не разметка: её вставят в чат и увидят теги.
const asText = (it: Item) => (isBlank(it.note) ? it.text : `${it.text}\n${plain(it.note)}`)

export function TaskChecklist({ taskId, canEdit }: { taskId: string; canEdit: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [adding, setAdding] = useState('')
  // Какой пункт сейчас с раскрытым полем заметки.
  const [noting, setNoting] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  // Какой пункт только что скопирован — галочка вместо иконки на пару секунд.
  const [copied, setCopied] = useState<string | null>(null)
  // distance: 4 — тот же порог, что в таблице задач: без него клик по галочке
  // считался бы началом перетаскивания.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

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
    mutationFn: ({ id, ...body }: { id: string; done?: boolean; note?: string; text?: string; sortOrder?: number }) =>
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
    setNoteDraft(
      looksLikeHtml(it.note)
        ? it.note
        : it.note
          ? `<p>${it.note.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`
          : '',
    )
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

  /** Стереть ответ одним движением — из просмотра и из правки одинаково. */
  const clearNote = (it: Item) => {
    if (it.note) patch.mutate({ id: it.id, note: '' })
    setNoting(null)
  }

  const reorder = useMutation({
    mutationFn: (ids: string[]) =>
      api(`/api/v1/tasks/${taskId}/checklist/order`, { method: 'PATCH', body: JSON.stringify({ ids }) }, 'project'),
    onSuccess: refresh,
    onError: (e) => {
      // Порядок вернём с сервера: показывать перестановку, которой не
      // случилось, хуже, чем откатить её на глазах.
      refresh()
      onErr(e)
    },
  })

  const onDragEnd = (e: DragEndEvent) => {
    const from = items.findIndex((x) => x.id === e.active.id)
    const to = items.findIndex((x) => x.id === e.over?.id)
    if (from < 0 || to < 0 || from === to) return
    const moved = arrayMove(items, from, to)
    // Новый порядок показываем сразу, не дожидаясь ответа: иначе пункт прыгает
    // обратно на время запроса, и кажется, что перетаскивание не сработало.
    qc.setQueryData(['task-checklist', taskId], moved)
    reorder.mutate(moved.map((x) => x.id))
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

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          <ul className="space-y-0.5">
            {items.map((it) => (
              <Row
                key={it.id}
                item={it}
                canEdit={canEdit}
                editing={noting === it.id}
                copied={copied === it.id}
                noteDraft={noteDraft}
                onDraft={setNoteDraft}
                onToggle={() => patch.mutate({ id: it.id, done: !it.done })}
                onOpenNote={() => openNote(it)}
                onSaveNote={() => saveNote(it)}
                onClearNote={() => clearNote(it)}
                onCancelNote={() => setNoting(null)}
                onCopy={() => copy(it)}
                onRemove={() => remove.mutate(it.id)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

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

function Row({
  item: it,
  canEdit,
  editing,
  copied,
  noteDraft,
  onDraft,
  onToggle,
  onOpenNote,
  onSaveNote,
  onClearNote,
  onCancelNote,
  onCopy,
  onRemove,
}: {
  item: Item
  canEdit: boolean
  editing: boolean
  copied: boolean
  noteDraft: string
  onDraft: (html: string) => void
  onToggle: () => void
  onOpenNote: () => void
  onSaveNote: () => void
  onClearNote: () => void
  onCancelNote: () => void
  onCopy: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const { setNodeRef, transform, transition, isDragging, attributes, listeners } = useSortable({
    id: it.id,
    disabled: !canEdit,
  })
  const hasNote = !isBlank(it.note)
  // Полоса «ответить» нужна, только пока ответа нет и его не пишут.
  const flap = !hasNote && !editing

  return (
    // relative + hover:z-10 — под строку «ответить», которая висит на absolute
    // под пунктом и при наведении ложится ПОВЕРХ соседнего. Нижние углы при
    // наведении срезаем: подложка пункта и подложка этой строки должны
    // читаться одним блоком, а не двумя пластинами.
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group relative rounded-md px-1 py-0.5 hover:z-10 hover:bg-secondary/40',
        flap && 'hover:rounded-b-none',
        isDragging && 'z-20 opacity-60',
      )}
    >
      <div className="flex items-start gap-2">
        {/* Ручка: пункт переставляют внутри списка. Драг браузерный отключён
            намеренно — им пункт «уносили» в чат текстом, но той же кнопкой
            теперь меняют порядок, и два жеста на одной ручке путались. */}
        {canEdit ? (
          <button
            {...attributes}
            {...listeners}
            title={t('checklist.dragHint')}
            className="mt-1 shrink-0 cursor-grab text-muted-foreground opacity-0 transition-opacity active:cursor-grabbing group-hover:opacity-60 hover:!opacity-100"
          >
            <GripVertical className="size-4" />
          </button>
        ) : (
          <span className="mt-1 size-4 shrink-0" />
        )}

        {/* Отметить может каждый, кто видит задачу: галочка — это доклад о
            сделанном, а не правка её содержания. */}
        <button
          onClick={onToggle}
          title={it.doneBy ? t('checklist.doneBy', { name: it.doneBy.name }) : undefined}
          className={cn(
            'mt-0.5 grid size-5 shrink-0 place-items-center rounded-[5px] border-2 transition-colors',
            it.done ? 'border-brand bg-brand text-brand-foreground' : 'border-border hover:border-brand',
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
          {editing ? (
            <div className="mt-1 rounded-md border">
              <RichEditor
                value={noteDraft}
                onChange={onDraft}
                onSubmit={onSaveNote}
                mentions={[]}
                preset="minimal"
                placeholder={t('checklist.notePlaceholder')}
              />
              <div className="flex items-center gap-1 border-t p-1">
                <Button size="sm" variant="brand" onClick={onSaveNote}>
                  {t('checklist.saveNote')}
                </Button>
                <Button size="sm" variant="ghost" onClick={onCancelNote}>
                  {t('common.cancel')}
                </Button>
                {/* Стереть написанное одним движением, а не «выделить всё,
                    удалить, сохранить». */}
                <Button
                  size="sm"
                  variant="ghost"
                  className="ms-auto text-muted-foreground hover:text-destructive"
                  title={t('checklist.clearNote')}
                  onClick={onClearNote}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          ) : hasNote ? (
            // Заметку правят по клику, поэтому она сама и есть кнопка:
            // на всю ширину и с полем вокруг, чтобы попадать не целясь.
            <div
              role="button"
              tabIndex={0}
              onClick={onOpenNote}
              onKeyDown={(e) => (e.key === 'Enter' ? onOpenNote() : undefined)}
              className="group/note relative -mx-1 mt-1 block cursor-text break-words rounded px-1 py-0.5 pe-7 text-sm text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            >
              {looksLikeHtml(it.note) ? (
                <RichEditor value={it.note} onChange={() => {}} mentions={[]} preset="minimal" readOnly />
              ) : (
                <span className="block whitespace-pre-wrap">{it.note}</span>
              )}
              {/* Убрать ответ одним кликом, не открывая редактор. */}
              <button
                title={t('checklist.clearNote')}
                onClick={(e) => {
                  e.stopPropagation()
                  onClearNote()
                }}
                className="absolute end-0.5 top-0.5 grid size-5 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-destructive focus-visible:opacity-100 group-hover/note:opacity-100"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ) : null}
        </div>

        {/* Копировать может любой, кто видит: чтение прав не требует */}
        <span className="mt-0.5 flex shrink-0 items-center gap-0.5">
          <button
            onClick={onCopy}
            title={t('checklist.copy')}
            className={cn(
              'grid size-6 place-items-center rounded transition-opacity hover:bg-secondary focus-visible:opacity-100',
              copied ? 'text-brand opacity-100' : 'text-muted-foreground opacity-0 group-hover:opacity-100',
            )}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
          {canEdit && (
            <button
              onClick={onRemove}
              title={t('files.delete')}
              className="grid size-6 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </span>
      </div>

      {/* Строка «ответить» — продолжение самого пункта, а не кнопка рядом.
          В потоке она не стоит: пустая полоска под каждым пунктом раздвигала
          список так, что читать его было нельзя. Поэтому висит под пунктом на
          absolute, а при наведении подложка пункта и её подложка сходятся в
          один блок, накрывающий соседей.

          Двойная подложка не для красоты: та же bg-secondary/40, что у пункта,
          полупрозрачна, и сквозь неё просвечивал бы текст снизу. Нижний слой —
          сплошной фон, верхний повторяет оттенок строки. */}
      {flap && (
        <div
          // pointer-events-none в невидимом состоянии обязательны: полоса висит
          // НАД соседним пунктом и иначе перехватывала бы клики по нему.
          className="pointer-events-none absolute inset-x-0 top-full z-10 opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
        >
          <div className="rounded-b-md bg-background">
            <div className="rounded-b-md bg-secondary/40 px-1 pb-1 ps-14">
              <button onClick={onOpenNote} className="text-xs text-muted-foreground hover:text-foreground">
                {t('checklist.addNote')}
              </button>
            </div>
          </div>
        </div>
      )}
    </li>
  )
}
