import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Plus, Search, Sparkles, Tag as TagIcon, Trash2, Pencil, X, FolderKanban } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RichEditor } from '@/components/ui/rich-editor'
import { TagInput } from '@/components/ui/tag-input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { useConfirm } from '@/components/ui/confirm'
import { NOTE_TYPES, NOTE_META, type NoteType } from '@/components/tabs/NotesTab'

/**
 * База знаний компании.
 *
 * Отдельный экран, а не вкладка внутри проекта: знание про Cardcom нужно
 * всем, кто с ним столкнётся, а искать его, перебирая проекты, никто не
 * станет. Проект здесь — метка происхождения и необязательный фильтр, а не
 * граница: «это выяснилось там».
 *
 * Поиск понимает смысл: «не проходит оплата» находит «Cardcom отклоняет
 * иностранные карты» без единого общего слова, и так же работает на иврите.
 */

type Entry = {
  id: string
  type: NoteType
  title: string
  body: string
  tags: string[]
  projectId: string | null
  project: { id: string; name: string } | null
  author: { id: string; name: string } | null
  matchedByMeaning?: boolean
  createdAt: string
  updatedAt: string
}

export function KnowledgeTab({ companyId, meId }: { companyId: string; meId: string | null }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()

  const [q, setQ] = useState('')
  // Отдельно от q: запрос уходит по Enter, а не на каждую букву. Поиск по
  // смыслу стоит денег и времени модели — дёргать его на каждый символ значит
  // платить за то, чего человек не просил.
  const [applied, setApplied] = useState('')
  const [type, setType] = useState<string>('')
  const [tag, setTag] = useState('')
  const [editing, setEditing] = useState<Entry | 'new' | null>(null)

  const list = useQuery({
    queryKey: ['company-notes', companyId, applied, type, tag],
    queryFn: () =>
      api<{ items: Entry[] }>(
        `/api/v1/company/${companyId}/notes?` +
          new URLSearchParams({
            ...(applied ? { q: applied } : {}),
            ...(type ? { type } : {}),
            ...(tag ? { tag } : {}),
          }),
      ),
  })
  const tags = useQuery({
    queryKey: ['company-note-tags', companyId],
    queryFn: () => api<{ tag: string; count: number }[]>(`/api/v1/company/${companyId}/note-tags`),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/company/${companyId}/notes/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t('journal.deleted'))
      void qc.invalidateQueries({ queryKey: ['company-notes', companyId] })
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const items = list.data?.items ?? []

  return (
    <div className="space-y-4">
      {/* Строка поиска и фильтры */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setApplied(q.trim())
              if (e.key === 'Escape') {
                setQ('')
                setApplied('')
              }
            }}
            placeholder={t('knowledge.searchPlaceholder')}
            className="ps-8"
          />
          {applied && (
            <button
              type="button"
              onClick={() => {
                setQ('')
                setApplied('')
              }}
              className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              title={t('common.clear')}
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        <Select value={type || 'all'} onValueChange={(v) => setType(v === 'all' ? '' : v)}>
          <SelectTrigger className="w-auto min-w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('knowledge.allTypes')}</SelectItem>
            {NOTE_TYPES.map((k) => (
              <SelectItem key={k} value={k}>
                {t(`journal.type.${k}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button variant="brand" onClick={() => setEditing('new')}>
          <Plus className="size-4" />
          {t('knowledge.add')}
        </Button>
      </div>

      {/* Теги: щёлкнул — сузил. Их пишут руками, и они ловят то, чего смысл не
          ловит: «cardcom» — это Cardcom, а не «что-то про платежи». */}
      {(tags.data?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.data!.slice(0, 20).map((x) => (
            <button
              key={x.tag}
              type="button"
              onClick={() => setTag(tag === x.tag ? '' : x.tag)}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors',
                tag === x.tag ? 'border-brand bg-brand/10 text-brand-ink' : 'hover:border-brand/50',
              )}
            >
              <TagIcon className="size-3" />
              {x.tag}
              <span className="text-muted-foreground">{x.count}</span>
            </button>
          ))}
        </div>
      )}

      {/* Подсказка про смысловой поиск — один раз, когда искали и нашли */}
      {applied && items.some((n) => n.matchedByMeaning) && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Sparkles className="size-3.5" />
          {t('knowledge.meaningHint')}
        </p>
      )}

      {list.isLoading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {applied ? t('knowledge.nothingFound') : t('knowledge.empty')}
          </p>
          {!applied && (
            <Button variant="outline" className="mt-3" onClick={() => setEditing('new')}>
              <Plus className="size-4" />
              {t('knowledge.addFirst')}
            </Button>
          )}
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((n) => {
            const meta = NOTE_META[n.type] ?? NOTE_META.note
            const Icon = meta.icon
            const mine = n.author?.id === meId
            return (
              <li key={n.id} className="rounded-xl border bg-card p-4 transition-colors hover:border-brand/40">
                <div className="flex items-start gap-3">
                  <Icon className={cn('mt-0.5 size-4 shrink-0', meta.className)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium">{n.title || t('journal.untitled')}</h3>
                      <span className={cn('rounded px-1.5 py-0.5 text-[11px]', meta.className, 'bg-muted')}>
                        {t(`journal.type.${n.type}`)}
                      </span>
                      {/* Найдено по смыслу: общих слов с запросом может не
                          быть вовсе, и без пометки такой ответ выглядит
                          случайным. */}
                      {n.matchedByMeaning && (
                        <span className="inline-flex items-center gap-1 rounded bg-brand/10 px-1.5 py-0.5 text-[11px] text-brand-ink">
                          <Sparkles className="size-3" />
                          {t('knowledge.byMeaning')}
                        </span>
                      )}
                    </div>

                    <div
                      className="msg-md mt-1.5 line-clamp-3 break-words text-sm text-muted-foreground"
                      dangerouslySetInnerHTML={{ __html: n.body }}
                    />

                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {n.tags.map((x) => (
                        <button
                          key={x}
                          type="button"
                          onClick={() => setTag(x)}
                          className="rounded bg-muted px-1.5 py-0.5 hover:text-foreground"
                        >
                          {x}
                        </button>
                      ))}
                      {/* Метка происхождения: где это выяснилось. Не граница —
                          запись видна всем в компании. */}
                      {n.project && (
                        <span className="inline-flex items-center gap-1">
                          <FolderKanban className="size-3" />
                          {n.project.name}
                        </span>
                      )}
                      {n.author && (
                        <span className="inline-flex items-center gap-1">
                          <Avatar name={n.author.name} className="size-4" />
                          {n.author.name}
                        </span>
                      )}
                      <span>{new Date(n.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>

                  {/* Своё правит автор; чужое — админ компании, и сервер это
                      проверяет. Здесь просто не показываем кнопки тому, кто
                      упрётся в отказ. */}
                  {mine && (
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="icon" title={t('common.edit')} onClick={() => setEditing(n)}>
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title={t('common.delete')}
                        onClick={async () => {
                          if (await confirm({ title: t('journal.deleteConfirm'), confirmLabel: t('common.delete'), destructive: true })) {
                            remove.mutate(n.id)
                          }
                        }}
                      >
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {editing && (
        <EntryEditor
          companyId={companyId}
          entry={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void qc.invalidateQueries({ queryKey: ['company-notes', companyId] })
            void qc.invalidateQueries({ queryKey: ['company-note-tags', companyId] })
          }}
        />
      )}
    </div>
  )
}

function EntryEditor({
  companyId,
  entry,
  onClose,
  onSaved,
}: {
  companyId: string
  entry: Entry | null
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const [type, setType] = useState<NoteType>(entry?.type ?? 'solution')
  const [title, setTitle] = useState(entry?.title ?? '')
  const [body, setBody] = useState(entry?.body ?? '')
  const [tags, setTags] = useState<string[]>(entry?.tags ?? [])

  const save = useMutation({
    mutationFn: () =>
      api(
        entry ? `/api/v1/company/${companyId}/notes/${entry.id}` : `/api/v1/company/${companyId}/notes`,
        { method: entry ? 'PATCH' : 'POST', body: JSON.stringify({ type, title, body, tags }) },
      ),
    onSuccess: () => {
      toast.success(entry ? t('journal.saved') : t('journal.created'))
      onSaved()
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-16">
      <div className="w-full max-w-2xl rounded-xl border bg-card p-5 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{entry ? t('knowledge.editTitle') : t('knowledge.newTitle')}</h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="space-y-3">
          <div className="flex gap-2">
            <Select value={type} onValueChange={(v) => setType(v as NoteType)}>
              <SelectTrigger className="w-auto min-w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NOTE_TYPES.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(`journal.type.${k}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('knowledge.titlePlaceholder')}
              className="flex-1"
            />
          </div>

          <RichEditor value={body} onChange={setBody} mentions={[]} placeholder={t('knowledge.bodyPlaceholder')} />

          {/* Теги — не украшение: они ловят то, чего смысл не ловит. «cardcom»
              это Cardcom, а не «что-то про платежи». */}
          <TagInput value={tags} onChange={setTags} placeholder={t('knowledge.tagsPlaceholder')} />
          <p className="text-xs text-muted-foreground">{t('knowledge.tagsHint')}</p>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="brand"
            disabled={save.isPending || (!title.trim() && !body.trim())}
            onClick={() => save.mutate()}
          >
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}
