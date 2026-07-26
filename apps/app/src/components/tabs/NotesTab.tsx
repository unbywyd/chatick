import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Bell,
  Briefcase,
  Building2,
  Check,
  Gavel,
  Lightbulb,
  MessageSquareQuote,
  NotebookPen,
  Plus,
  Search,
  Split,
  Trash2,
  X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RichEditor, type RichMention } from '@/components/ui/rich-editor'
import { useConfirm } from '@/components/ui/confirm'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'

// Заметки проекта (SPEC §8.31): решения, противоречия, договорённости, напоминания.
// Одна лента с типами и тегами вместо трёх отдельных разделов.

export const NOTE_TYPES = ['solution', 'problem', 'decision', 'contradiction', 'reminder', 'business', 'note'] as const
export type NoteType = (typeof NOTE_TYPES)[number]

/** Иконка и цвет держатся за тип: по ленте видно, что перед тобой, без чтения. */
export const NOTE_META: Record<NoteType, { icon: typeof Lightbulb; className: string }> = {
  solution: { icon: Lightbulb, className: 'text-emerald-600 dark:text-emerald-400' },
  problem: { icon: AlertTriangle, className: 'text-amber-600 dark:text-amber-400' },
  decision: { icon: Gavel, className: 'text-blue-600 dark:text-blue-400' },
  contradiction: { icon: Split, className: 'text-rose-600 dark:text-rose-400' },
  reminder: { icon: Bell, className: 'text-violet-600 dark:text-violet-400' },
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
  createdVia: string
  author: { id: string; name: string; avatarUrl: string | null } | null
  createdAt: string
  updatedAt: string
}
type Member = { user: { id: string; name: string; email: string; avatarUrl: string | null } }

export function NotesTab({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [params, setParams] = useSearchParams()

  const [q, setQ] = useState('')
  const [types, setTypes] = useState<NoteType[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [authorId, setAuthorId] = useState('')
  const [mentions, setMentions] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [companyWide, setCompanyWide] = useState(false)
  const [editing, setEditing] = useState<Note | 'new' | null>(null)

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

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/notes/${id}`, { method: 'DELETE' }, 'project'),
    onSuccess: () => {
      toast.success(t('journal.deleted'))
      qc.invalidateQueries({ queryKey: ['notes', projectId] })
    },
    onError: onErr,
  })

  // дип-линк ?note=<id> из уведомления
  const focusId = params.get('note')
  const clearFocus = () => {
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

  if (editing) {
    return (
      <NoteEditor
        projectId={projectId}
        note={editing === 'new' ? null : editing}
        mentions={mentionItems}
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
    <div className="mx-auto w-full max-w-6xl space-y-4 p-6">
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

            <div>
              <p className="mb-1 text-xs font-medium">{t('journal.author')}</p>
              <select
                value={authorId}
                onChange={(e) => setAuthorId(e.target.value)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                <option value="">{t('journal.anyone')}</option>
                {(members.data ?? []).map((m) => (
                  <option key={m.user.id} value={m.user.id}>
                    {m.user.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <p className="mb-1 text-xs font-medium">{t('journal.mentions')}</p>
              <select
                value={mentions}
                onChange={(e) => setMentions(e.target.value)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                <option value="">{t('journal.anyone')}</option>
                {(members.data ?? []).map((m) => (
                  <option key={m.user.id} value={m.user.id}>
                    {m.user.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className="mb-1 text-xs font-medium">{t('journal.from')}</p>
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9" />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium">{t('journal.to')}</p>
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9" />
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
                tags.includes(tag) ? 'bg-brand text-white' : 'bg-muted text-muted-foreground hover:bg-accent',
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
                className={cn(
                  'group rounded-lg border bg-card p-3 transition-colors hover:bg-accent/50',
                  focusId === n.id && 'border-brand ring-1 ring-brand',
                )}
                onClick={() => focusId === n.id && clearFocus()}
              >
                <div className="flex items-start gap-3">
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
                      <div
                        className="prose-sm mt-1 line-clamp-2 text-xs text-muted-foreground [&_p]:m-0"
                        dangerouslySetInnerHTML={{ __html: n.body }}
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
                          <Button variant="ghost" size="icon" className="size-7" onClick={() => setEditing(n)}>
                            <NotebookPen className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
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
  onClose,
  onSaved,
}: {
  projectId: string
  note: Note | null
  mentions: RichMention[]
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const [type, setType] = useState<NoteType>(note?.type ?? 'note')
  const [title, setTitle] = useState(note?.title ?? '')
  const [body, setBody] = useState(note?.body ?? '')
  const [mentionedIds, setMentionedIds] = useState<string[]>(note?.mentionedIds ?? [])
  const [tagInput, setTagInput] = useState((note?.tags ?? []).join(', '))
  const [scope, setScope] = useState<'project' | 'company'>(note?.scope ?? 'project')
  const [remindAt, setRemindAt] = useState(note?.remindAt ? note.remindAt.slice(0, 10) : '')

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        type,
        title,
        body,
        tags: tagInput.split(',').map((s) => s.trim()).filter(Boolean),
        scope,
        mentionedIds,
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
          setMentionedIds(ids)
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

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <p className="mb-1 text-xs font-medium">{t('journal.tags')}</p>
          <Input value={tagInput} onChange={(e) => setTagInput(e.target.value)} placeholder="dns, docker" />
        </div>
        <div>
          <p className="mb-1 text-xs font-medium">{t('journal.scope')}</p>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as 'project' | 'company')}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          >
            <option value="project">{t('journal.scopeProject')}</option>
            <option value="company">{t('journal.scopeCompany')}</option>
          </select>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium">{t('journal.remindAt')}</p>
          <Input type="date" value={remindAt} onChange={(e) => setRemindAt(e.target.value)} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {scope === 'company' ? t('journal.scopeCompanyHint') : t('journal.scopeProjectHint')}
      </p>
    </div>
  )
}
