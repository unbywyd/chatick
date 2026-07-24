import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowLeft, Download, FileText, Globe, Link2, Plus, Search, Trash2 } from 'lucide-react'
import { api, API_URL } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RichEditor } from '@/components/ui/rich-editor'
import { useConfirm } from '@/components/ui/confirm'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'

// Документы проекта (SPEC §8.24): список + Tiptap-редактор + публичная ссылка + экспорт.
type DocListItem = {
  id: string
  title: string
  preview: string
  publicSlug: string | null
  updatedAt: string
  author: { id: string; name: string; avatarUrl: string | null } | null
}
type Doc = { id: string; title: string; content: string; publicSlug: string | null; updatedAt: string }
type Member = { user: { id: string; name: string; email: string; avatarUrl: string | null } }

export function DocumentsTab({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [openId, setOpenId] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const onErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

  const list = useQuery({
    queryKey: ['documents', projectId, q],
    queryFn: () => api<DocListItem[]>(`/api/v1/documents${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`, {}, 'project'),
  })
  const members = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => api<Member[]>(`/api/v1/projects/${projectId}/members`),
  })

  const create = useMutation({
    mutationFn: () => api<Doc>('/api/v1/documents', { method: 'POST', body: JSON.stringify({ title: t('docs.untitled'), content: '' }) }, 'project'),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['documents', projectId] })
      setOpenId(d.id)
    },
    onError: onErr,
  })

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/documents/${id}`, { method: 'DELETE' }, 'project'),
    onSuccess: () => {
      toast.success(t('docs.deleted'))
      setOpenId(null)
      qc.invalidateQueries({ queryKey: ['documents', projectId] })
    },
    onError: onErr,
  })

  if (openId) {
    return (
      <DocumentEditor
        projectId={projectId}
        docId={openId}
        members={members.data ?? []}
        onBack={() => setOpenId(null)}
        onDelete={async (id, title) => {
          if (await confirm({ title: t('docs.deleteConfirm', { title }), destructive: true, confirmLabel: t('files.delete') })) remove.mutate(id)
        }}
      />
    )
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            <FileText className="size-5" />
            {t('docs.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('docs.subtitle')}</p>
        </div>
        <Button variant="brand" onClick={() => create.mutate()} disabled={create.isPending}>
          <Plus className="size-4" />
          {t('docs.new')}
        </Button>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('docs.search')} className="ps-9" />
      </div>

      <ul className="space-y-2">
        {list.isLoading && <p className="text-sm text-muted-foreground">…</p>}
        {(list.data ?? []).map((d) => (
          <li key={d.id}>
            <button
              onClick={() => setOpenId(d.id)}
              className="flex w-full items-start gap-3 rounded-lg border bg-card px-3 py-2.5 text-start transition-colors hover:bg-accent"
            >
              <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{d.title}</span>
                  {d.publicSlug && <Globe className="size-3 shrink-0 text-brand" />}
                </span>
                {d.preview && <span className="line-clamp-1 text-xs text-muted-foreground">{d.preview}</span>}
              </span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                {d.author && <Avatar name={d.author.name} src={d.author.avatarUrl} size={18} />}
                {new Date(d.updatedAt).toLocaleDateString(i18n.language)}
              </span>
            </button>
          </li>
        ))}
        {list.data && list.data.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">{t('docs.empty')}</p>}
      </ul>
    </div>
  )
}

function DocumentEditor({
  projectId,
  docId,
  members,
  onBack,
  onDelete,
}: {
  projectId: string
  docId: string
  members: Member[]
  onBack: () => void
  onDelete: (id: string, title: string) => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const onErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

  const doc = useQuery({ queryKey: ['document', docId], queryFn: () => api<Doc>(`/api/v1/documents/${docId}`, {}, 'project') })
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (doc.data) {
      setTitle(doc.data.title)
      setContent(doc.data.content)
      setDirty(false)
    }
  }, [doc.data?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: () => api<Doc>(`/api/v1/documents/${docId}`, { method: 'PATCH', body: JSON.stringify({ title, content }) }, 'project'),
    onSuccess: () => {
      setDirty(false)
      toast.success(t('docs.saved'))
      qc.invalidateQueries({ queryKey: ['documents', projectId] })
      qc.invalidateQueries({ queryKey: ['document', docId] })
    },
    onError: onErr,
  })

  // автосохранение через 2с после последнего изменения
  useEffect(() => {
    if (!dirty) return
    const id = setTimeout(() => save.mutate(), 2000)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, title, content])

  const share = useMutation({
    mutationFn: (enabled: boolean) => api<{ publicSlug: string | null }>(`/api/v1/documents/${docId}/share`, { method: 'POST', body: JSON.stringify({ enabled }) }, 'project'),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['document', docId] })
      qc.invalidateQueries({ queryKey: ['documents', projectId] })
      if (r.publicSlug) {
        const url = `${API_URL}/d/${r.publicSlug}`
        navigator.clipboard.writeText(url).catch(() => {})
        toast.success(t('docs.shared'))
      } else {
        toast.success(t('docs.unshared'))
      }
    },
    onError: onErr,
  })

  const download = (kind: 'md' | 'html') => {
    const safe = (title || 'document').replace(/[^\w\-]+/g, '_').slice(0, 40)
    const body =
      kind === 'md'
        ? `# ${title}\n\n${content}`
        : `<!doctype html><meta charset="utf-8"><title>${title}</title><body><h1>${title}</h1><pre style="white-space:pre-wrap;font-family:system-ui">${content.replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[ch]!)}</pre></body>`
    const blob = new Blob([body], { type: kind === 'md' ? 'text/markdown' : 'text/html' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${safe}.${kind}`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const publicUrl = doc.data?.publicSlug ? `${API_URL}/d/${doc.data.publicSlug}` : null

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="size-4 rtl:-scale-x-100" />
          <span className="hidden sm:inline">{t('docs.back')}</span>
        </Button>
        {dirty && <span className="text-xs text-muted-foreground">{t('docs.unsaved')}</span>}
        <div className="ms-auto flex items-center gap-1">
          {publicUrl && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => {
                navigator.clipboard.writeText(publicUrl).catch(() => {})
                toast.success(t('docs.linkCopied'))
              }}
            >
              <Link2 className="size-4" />
              <span className="hidden sm:inline">{t('docs.copyLink')}</span>
            </Button>
          )}
          <Button
            variant={doc.data?.publicSlug ? 'brand' : 'outline'}
            size="sm"
            className="gap-1.5"
            onClick={() => share.mutate(!doc.data?.publicSlug)}
          >
            <Globe className="size-4" />
            <span className="hidden sm:inline">{doc.data?.publicSlug ? t('docs.public') : t('docs.makePublic')}</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="rounded-md p-2 text-muted-foreground hover:text-foreground" title={t('docs.export')}>
                <Download className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => download('md')}>Markdown (.md)</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => download('html')}>HTML (.html)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon" title={t('files.delete')} onClick={() => onDelete(docId, title)}>
            <Trash2 className="size-4 text-muted-foreground hover:text-destructive" />
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-3 p-4 sm:p-6">
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              setDirty(true)
            }}
            placeholder={t('docs.titlePlaceholder')}
            className={cn('w-full border-0 bg-transparent text-2xl font-bold outline-none placeholder:text-muted-foreground')}
          />
          {doc.data && (
            <RichEditor
              value={doc.data.content}
              onChange={(md) => {
                setContent(md)
                setDirty(true)
              }}
              placeholder={t('docs.contentPlaceholder')}
              mentions={members.map((m) => ({ id: m.user.id, label: m.user.name || m.user.email, avatarUrl: m.user.avatarUrl }))}
              preset="full"
            />
          )}
        </div>
      </div>
    </div>
  )
}
