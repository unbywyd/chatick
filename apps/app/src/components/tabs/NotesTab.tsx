import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useProjectCtx } from '@/screens/project-context'
import { ShareDialog } from '@/components/ShareDialog'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Bell,
  Briefcase,
  Building2,
  Check,
  CheckSquare,
  Gavel,
  GitCompareArrows,
  Lightbulb,
  MessageSquareQuote,
  NotebookPen,
  Plus,
  Puzzle as PuzzleIcon,
  Search,
  Split,
  Trash2,
  X,
  Share2,
} from 'lucide-react'
import { api, withInlineImageAuth } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RichEditor, type RichMention } from '@/components/ui/rich-editor'
import { TagInput } from '@/components/ui/tag-input'
import { PeoplePicker } from '@/components/ui/people-picker'
import { DatePicker } from '@/components/ui/date-picker'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { useConfirm } from '@/components/ui/confirm'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { DragHandle } from '@/components/ui/drag-handle'

// Заметки проекта (SPEC §8.31): решения, противоречия, договорённости, напоминания.
// Одна лента с типами и тегами вместо трёх отдельных разделов.

/**
 * Типы записей базы знаний.
 *
 * Было девять, и они описывали НАБЛЮДЕНИЯ ассистента в чате: contradiction —
 * люди сказали противоречащее, mismatch — код разошёлся с макетом, gap — в
 * спеке случай не описан. Свидетельства о моменте: вне своего разговора они
 * бессмысленны.
 *
 * База знаний отвечает на другой вопрос — не «что я заметил», а «что команде
 * надо знать». Отсюда bug, requirement, attention.
 */
export const NOTE_TYPES = ['solution', 'bug', 'requirement', 'attention', 'decision', 'business', 'note'] as const
export type NoteType = (typeof NOTE_TYPES)[number]

/** Иконка и цвет держатся за тип: по ленте видно, что перед тобой, без чтения. */
export const NOTE_META: Record<NoteType, { icon: typeof Lightbulb; className: string }> = {
  solution: { icon: Lightbulb, className: 'text-emerald-600 dark:text-emerald-400' },
  // Красный у бага, янтарный у ловушки: сломанное и опасное различаются с
  // одного взгляда, не читая.
  bug: { icon: AlertTriangle, className: 'text-rose-600 dark:text-rose-400' },
  requirement: { icon: Gavel, className: 'text-blue-600 dark:text-blue-400' },
  attention: { icon: Bell, className: 'text-amber-600 dark:text-amber-400' },
  decision: { icon: Split, className: 'text-violet-600 dark:text-violet-400' },
  business: { icon: Briefcase, className: 'text-cyan-600 dark:text-cyan-400' },
  note: { icon: NotebookPen, className: 'text-muted-foreground' },
}

type Source = { messageId?: string | null; text: string; authorName?: string; sentAt?: string }
type Note = {
  id: string
  projectId: string
  projectName: string | null
  type: NoteType
  title: string
  body: string
  tags: string[]
  scope: 'project' | 'company'
  sources: Source[]
  mentionedIds: string[]
  remindAt: string | null
  taskId: string | null
  /** Задача, выросшая из заметки, — с номером и названием, чтобы было куда перейти. */
  task: { id: string; number: string; title: string; status: string } | null
  createdVia: string
  author: { id: string; name: string; avatarUrl: string | null } | null
  createdAt: string
  updatedAt: string
}
type Member = { user: { id: string; name: string; email: string; avatarUrl: string | null } }

export function NotesTab({ projectId }: { projectId: string }) {
  // Публиковать наружу может только руководство проекта — см. ShareDialog.
  const { project } = useProjectCtx()
  const isAdmin = project?.myRole === 'owner' || project?.myRole === 'admin'
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()

  const [q, setQ] = useState('')
  const [types, setTypes] = useState<NoteType[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [authorId, setAuthorId] = useState('')
  const [mentions, setMentions] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [companyWide, setCompanyWide] = useState(false)
  const [editing, setEditing] = useState<Note | 'new' | null>(null)
  // Какие заметки раскрыты целиком. По id, а не одна на весь список:
  // заметки сравнивают между собой, и схлопывать соседнюю незачем.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const onErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

  const query = useMemo(() => {
    const p = new URLSearchParams()
    if (q.trim()) p.set('q', q.trim())
    if (types.length) p.set('type', types.join(','))
    if (tags.length) p.set('tag', tags.join(','))
    if (authorId) p.set('authorId', authorId)
    if (mentions) p.set('mentions', mentions)
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    if (companyWide) p.set('scope', 'company')
    return p.toString()
  }, [q, types, tags, authorId, mentions, from, to, companyWide])

  const list = useQuery({
    queryKey: ['notes', projectId, query],
    queryFn: () => api<Note[]>(`/api/v1/notes${query ? `?${query}` : ''}`, {}, 'project'),
  })
  const tagList = useQuery({
    queryKey: ['note-tags', projectId],
    queryFn: () => api<{ tag: string; count: number }[]>('/api/v1/notes/tags', {}, 'project'),
  })
  const members = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => api<Member[]>(`/api/v1/projects/${projectId}/members`),
  })
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<{ id: string }>('/api/v1/auth/me') })

  // Заметка → задача: наблюдение обсудили, пора делать. Заметка остаётся —
  // она объясняет, почему задача такая, и хранит цитаты.
  const toTask = useMutation({
    mutationFn: (id: string) => api<{ number: string }>(`/api/v1/notes/${id}/task`, { method: 'POST', body: '{}' }, 'project'),
    onSuccess: (created) => {
      toast.success(t('journal.taskCreated', { number: created.number }))
      qc.invalidateQueries({ queryKey: ['notes', projectId] })
      qc.invalidateQueries({ queryKey: ['tasks', projectId] })
    },
    onError: onErr,
  })

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/notes/${id}`, { method: 'DELETE' }, 'project'),
    onSuccess: () => {
      toast.success(t('journal.deleted'))
      qc.invalidateQueries({ queryKey: ['notes', projectId] })
    },
    onError: onErr,
  })

  // Прямая ссылка на заметку: /c/<companyId>/p/<id>/notes/<noteId>. Старый вид
  // ?note=<id> продолжает работать — он разошёлся в уведомлениях и письмах.
  const { noteId, companyId } = useParams()
  const [sharing, setSharing] = useState<Note | null>(null)
  const focusId = noteId ?? params.get('note')
  const clearFocus = () => {
    if (noteId) {
      navigate(`/c/${companyId}/p/${projectId}/notes`, { replace: true })
      return
    }
    const next = new URLSearchParams(params)
    next.delete('note')
    setParams(next, { replace: true })
  }

  const mentionItems: RichMention[] = (members.data ?? []).map((m) => ({
    id: m.user.id,
    label: m.user.name,
    avatarUrl: m.user.avatarUrl,
  }))

  const toggle = <T,>(arr: T[], v: T): T[] => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])
  const hasFilters = Boolean(q || types.length || tags.length || authorId || mentions || from || to || companyWide)

  const shareDialog = sharing && (
    <ShareDialog
      type="note"
      id={sharing.id}
      title={sharing.title || t('journal.untitled')}
      appPath={`/c/${companyId}/p/${projectId}/notes/${sharing.id}`}
      canPublish={isAdmin}
      onClose={() => setSharing(null)}
    />
  )

  if (editing) {
    return (
      <NoteEditor
        projectId={projectId}
        note={editing === 'new' ? null : editing}
        mentions={mentionItems}
        meId={me.data?.id}
        tagSuggestions={(tagList.data ?? []).map((x) => x.tag)}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          qc.invalidateQueries({ queryKey: ['notes', projectId] })
          qc.invalidateQueries({ queryKey: ['note-tags', projectId] })
        }}
      />
    )
  }

  return (
    <div className="page-w space-y-4 p-6">
      {shareDialog}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            <NotebookPen className="size-5" />
            {t('journal.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('journal.subtitle')}</p>
        </div>
        <Button variant="brand" onClick={() => setEditing('new')}>
          <Plus className="size-4" />
          {t('journal.new')}
        </Button>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('journal.search')} className="ps-9" />
      </div>

      {/* типы — основной фильтр, поэтому всегда на виду */}
      <div className="flex flex-wrap items-center gap-1.5">
        {NOTE_TYPES.map((type) => {
          const { icon: Icon, className } = NOTE_META[type]
          const active = types.includes(type)
          return (
            <button
              key={type}
              onClick={() => setTypes(toggle(types, type))}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                active ? 'border-brand bg-brand/10 text-foreground' : 'text-muted-foreground hover:bg-accent',
              )}
            >
              <Icon className={cn('size-3.5', active ? className : '')} />
              {t(`journal.type.${type}`)}
            </button>
          )
        })}

        <span className="mx-1 h-4 w-px bg-border" />

        {/* остальные фильтры прячем: нужны редко, но нужны */}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className={cn(hasFilters && 'border-brand')}>
              {t('journal.filters')}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 space-y-3 p-3">
            <label className="flex items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-1.5">
                <Building2 className="size-3.5 text-muted-foreground" />
                {t('journal.companyWide')}
              </span>
              <input
                type="checkbox"
                checked={companyWide}
                onChange={(e) => setCompanyWide(e.target.checked)}
                className="size-4 accent-[var(--brand)]"
              />
            </label>
            <p className="-mt-2 text-xs text-muted-foreground">{t('journal.companyWideHint')}</p>

            {/* Люди — с поиском и лицами: в команде на два десятка человек
                выпадающий список имён бесполезен. */}
            <div>
              <p className="mb-1 text-xs font-medium">{t('journal.author')}</p>
              <PeoplePicker
                single
                people={(members.data ?? []).map((m) => m.user)}
                value={authorId ? [authorId] : []}
                onChange={(ids) => setAuthorId(ids[0] ?? '')}
                placeholder={t('journal.anyone')}
                clearLabel={t('journal.anyone')}
              />
            </div>

            <div>
              <p className="mb-1 text-xs font-medium">{t('journal.mentions')}</p>
              <PeoplePicker
                single
                people={(members.data ?? []).map((m) => m.user)}
                value={mentions ? [mentions] : []}
                onChange={(ids) => setMentions(ids[0] ?? '')}
                placeholder={t('journal.anyone')}
                clearLabel={t('journal.anyone')}
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className="mb-1 text-xs font-medium">{t('journal.from')}</p>
                <DatePicker value={from} onChange={setFrom} />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium">{t('journal.to')}</p>
                <DatePicker value={to} onChange={setTo} />
              </div>
            </div>

            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={() => {
                  setQ('')
                  setTypes([])
                  setTags([])
                  setAuthorId('')
                  setMentions('')
                  setFrom('')
                  setTo('')
                  setCompanyWide(false)
                }}
              >
                <X className="size-3.5" />
                {t('journal.clearFilters')}
              </Button>
            )}
          </PopoverContent>
        </Popover>
      </div>

      {/* теги проекта — по популярности */}
      {(tagList.data ?? []).length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {(tagList.data ?? []).slice(0, 20).map(({ tag, count }) => (
            <button
              key={tag}
              onClick={() => setTags(toggle(tags, tag))}
              className={cn(
                'rounded-md px-2 py-0.5 text-xs transition-colors',
                tags.includes(tag) ? 'bg-brand font-medium text-brand-foreground' : 'bg-muted text-muted-foreground hover:bg-accent',
              )}
            >
              #{tag}
              <span className="ms-1 opacity-60">{count}</span>
            </button>
          ))}
        </div>
      )}

      <ul className="space-y-2">
        {list.isLoading && <p className="text-sm text-muted-foreground">…</p>}
        {(list.data ?? []).map((n) => {
          const { icon: Icon, className } = NOTE_META[n.type] ?? NOTE_META.note
          const foreign = n.projectId !== projectId
          return (
            <li key={n.id}>
              <div
                // Перетаскивание в чат: на заметку ссылаются в разговоре чаще
                // всего — «мы же договорились» становится ссылкой.
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'copy'
                  e.dataTransfer.setData(
                    'application/x-chatick-note',
                    JSON.stringify({ id: n.id, name: n.title || t('journal.untitled') }),
                  )
                }}
                className={cn(
                  'group rounded-lg border bg-card p-3 transition-colors hover:bg-accent/50',
                  focusId === n.id && 'border-brand ring-1 ring-brand',
                )}
                onClick={() => focusId === n.id && clearFocus()}
              >
                <div className="flex items-start gap-3">
                  <DragHandle className="mt-0.5 -ms-1" />
                  <Icon className={cn('mt-0.5 size-4 shrink-0', className)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{n.title || t('journal.untitled')}</span>
                      {n.scope === 'company' && (
                        <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          <Building2 className="size-3" />
                          {t('journal.company')}
                        </span>
                      )}
                      {foreign && n.projectName && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {n.projectName}
                        </span>
                      )}
                    </div>
                    {n.body && (
                      // Токен подставляем на рендере: в теле он не хранится,
                      // иначе картинки отдают 401 и мигают на каждой перерисовке.
                      //
                      // Свёрнутая заметка ужимает текст до двух строк, но
                      // картинку показывает всегда — скриншот и есть содержание
                      // такой заметки, прятать его до раскрытия бессмысленно.
                      // Поэтому обрезаем абзацы, а не блок целиком: line-clamp
                      // на всём теле схлопнул бы и картинки.
                      <div
                        onClick={(e) => {
                          // Клик по картинке забирает просмотрщик — не сворачиваем.
                          if ((e.target as HTMLElement).closest('img')) return
                          e.stopPropagation()
                          setExpanded((prev) => ({ ...prev, [n.id]: !prev[n.id] }))
                        }}
                        className={cn(
                          'prose prose-sm mt-1 max-w-none cursor-pointer text-xs text-muted-foreground [&_img]:my-1 [&_img]:cursor-zoom-in [&_img]:rounded [&_p]:m-0',
                          expanded[n.id]
                            ? '[&_img]:max-h-96'
                            : // Превью: видно, что за картинка, но карточка остаётся карточкой.
                              '[&_img]:max-h-28 [&_p]:line-clamp-2',
                        )}
                        title={expanded[n.id] ? t('journal.collapse') : t('journal.expand')}
                        dangerouslySetInnerHTML={{ __html: withInlineImageAuth(n.body) }}
                      />
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {n.tags.map((tag) => (
                        <button
                          key={tag}
                          onClick={(e) => {
                            e.stopPropagation()
                            setTags(toggle(tags, tag))
                          }}
                          className="rounded bg-muted px-1.5 py-0.5 hover:bg-accent"
                        >
                          #{tag}
                        </button>
                      ))}
                      {n.sources.length > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <MessageSquareQuote className="size-3" />
                          {n.sources.length}
                        </span>
                      )}
                      {/* Не «задача создана», а какая именно: номер и название,
                          по клику — переход. Без этого метка сообщает о факте,
                          из которого некуда пойти. */}
                      {n.task && !foreign && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            navigate(`/c/${companyId}/p/${projectId}/tasks/${n.task!.id}`)
                          }}
                          title={t('journal.openTask', { number: n.task.number })}
                          className="inline-flex max-w-[22rem] items-center gap-1 rounded bg-brand/10 px-1.5 py-0.5 text-brand-ink hover:bg-brand/20"
                        >
                          <CheckSquare className="size-3 shrink-0" />
                          <span className="font-medium">{n.task.number}</span>
                          <span className="truncate opacity-80">{n.task.title}</span>
                        </button>
                      )}
                      {/* Задача была, но её удалили: молчать нельзя — заметка
                          выглядела бы необработанной и её завели бы заново. */}
                      {n.taskId && !n.task && (
                        <span className="inline-flex items-center gap-1 opacity-70">
                          <CheckSquare className="size-3" />
                          {t('journal.taskGone')}
                        </span>
                      )}
                      {n.remindAt && (
                        <span className="inline-flex items-center gap-1">
                          <Bell className="size-3" />
                          {new Date(n.remindAt).toLocaleDateString(i18n.language)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    {n.author && <Avatar name={n.author.name} src={n.author.avatarUrl} size={18} />}
                    <span>{new Date(n.createdAt).toLocaleDateString(i18n.language)}</span>
                    {/* opacity, а не hidden: иначе строка прыгает при наведении */}
                    <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      {!foreign && (
                        <>
                          {/* Задача уже есть — кнопка ведёт к ней, а не делает
                              вторую. Раньше она молча возвращала прежнюю, и
                              нажатие выглядело как бездействие. */}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            title={n.task ? t('journal.openTask', { number: n.task.number }) : t('journal.toTask')}
                            disabled={toTask.isPending}
                            onClick={() =>
                              n.task ? navigate(`/c/${companyId}/p/${projectId}/tasks/${n.task.id}`) : toTask.mutate(n.id)
                            }
                          >
                            <CheckSquare className={cn('size-3.5', n.task && 'text-brand-ink')} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            title={t('tasks.share')}
                            onClick={() => setSharing(n)}
                          >
                            <Share2 className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            title={t('journal.edit')}
                            onClick={() => setEditing(n)}
                          >
                            <NotebookPen className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            title={t('files.delete')}
                            onClick={async () => {
                              if (
                                await confirm({
                                  title: t('journal.deleteConfirm', { title: n.title || t('journal.untitled') }),
                                  destructive: true,
                                  confirmLabel: t('files.delete'),
                                })
                              )
                                remove.mutate(n.id)
                            }}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* цитаты — то, ради чего заводят «противоречие» */}
                {n.sources.length > 0 && (
                  <ol className="mt-2 space-y-1 border-s-2 ps-3 text-xs">
                    {n.sources.map((s, i) => (
                      <li key={i} className="text-muted-foreground">
                        <span className="font-medium text-foreground">{s.authorName ?? '—'}</span>
                        {s.sentAt && <span className="ms-1.5 opacity-70">{new Date(s.sentAt).toLocaleString(i18n.language)}</span>}
                        <span className="ms-1.5">— {s.text.slice(0, 220)}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </li>
          )
        })}
        {list.data && list.data.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('journal.empty')}</p>
        )}
      </ul>
    </div>
  )
}

function NoteEditor({
  projectId,
  note,
  mentions,
  meId,
  tagSuggestions,
  onClose,
  onSaved,
}: {
  projectId: string
  note: Note | null
  mentions: RichMention[]
  /** автор: по умолчанию заметка касается его самого */
  meId?: string
  tagSuggestions: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const [type, setType] = useState<NoteType>(note?.type ?? 'note')
  const [title, setTitle] = useState(note?.title ?? '')
  const [body, setBody] = useState(note?.body ?? '')
  // Кого касается заметка. Два источника: упомянутые прямо в тексте и выбранные
  // явно — храним раздельно, иначе редактор затирал бы выбор на каждой букве.
  const [textMentions, setTextMentions] = useState<string[]>([])
  const [assignees, setAssignees] = useState<string[]>(note?.mentionedIds ?? (meId ? [meId] : []))
  const [tags, setTags] = useState<string[]>(note?.tags ?? [])
  const [scope, setScope] = useState<'project' | 'company'>(note?.scope ?? 'project')
  const [remindAt, setRemindAt] = useState(note?.remindAt ? note.remindAt.slice(0, 10) : '')

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        type,
        title,
        body,
        tags,
        scope,
        mentionedIds: [...new Set([...assignees, ...textMentions])],
        remindAt: remindAt || null,
      }
      return note
        ? api(`/api/v1/notes/${note.id}`, { method: 'PATCH', body: JSON.stringify(payload) }, 'project')
        : api('/api/v1/notes', { method: 'POST', body: JSON.stringify(payload) }, 'project')
    },
    onSuccess: onSaved,
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">{note ? t('journal.edit') : t('journal.new')}</h1>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="brand" onClick={() => save.mutate()} disabled={save.isPending}>
            <Check className="size-4" />
            {t('common.save')}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {NOTE_TYPES.map((tp) => {
          const { icon: Icon, className } = NOTE_META[tp]
          return (
            <button
              key={tp}
              onClick={() => setType(tp)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                type === tp ? 'border-brand bg-brand/10 text-foreground' : 'text-muted-foreground hover:bg-accent',
              )}
            >
              <Icon className={cn('size-3.5', type === tp ? className : '')} />
              {t(`journal.type.${tp}`)}
            </button>
          )
        })}
      </div>

      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('journal.titlePlaceholder')} />

      <RichEditor
        value={body}
        onChange={(html, ids) => {
          setBody(html)
          setTextMentions(ids)
        }}
        mentions={mentions}
        placeholder={t('journal.bodyPlaceholder')}
        className="min-h-60"
      />

      {note && note.sources.length > 0 && (
        <div className="rounded-lg border bg-muted/30 p-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
            <MessageSquareQuote className="size-3.5" />
            {t('journal.sources')}
          </p>
          <ol className="space-y-1 text-xs text-muted-foreground">
            {note.sources.map((s, i) => (
              <li key={i}>
                <span className="font-medium text-foreground">{s.authorName ?? '—'}</span> — {s.text.slice(0, 300)}
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Кого касается: по умолчанию автор, но заметка часто заводится ради
          другого человека — он и должен о ней узнать. Поиск, а не ряд кнопок:
          на двадцати участниках ряд перестаёт читаться. */}
      <div>
        <p className="mb-1.5 text-xs font-medium">{t('journal.concerns')}</p>
        <PeoplePicker
          people={mentions.map((m) => ({ id: m.id, name: m.label, avatarUrl: m.avatarUrl }))}
          value={assignees}
          onChange={setAssignees}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <p className="mb-1 text-xs font-medium">{t('journal.tags')}</p>
          <TagInput value={tags} onChange={setTags} suggestions={tagSuggestions} placeholder="dns, docker" />
        </div>
        <div>
          <p className="mb-1 text-xs font-medium">{t('journal.scope')}</p>
          <Select value={scope} onValueChange={(v) => setScope(v as 'project' | 'company')}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="project">{t('journal.scopeProject')}</SelectItem>
              <SelectItem value="company">{t('journal.scopeCompany')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium">{t('journal.remindAt')}</p>
          <DatePicker value={remindAt} onChange={setRemindAt} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {scope === 'company' ? t('journal.scopeCompanyHint') : t('journal.scopeProjectHint')}
      </p>
    </div>
  )
}
