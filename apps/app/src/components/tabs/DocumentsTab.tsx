import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowLeft, Download, FileText, Globe, History, Link2, MoreVertical, Plus, RotateCcw, Search, Trash2 } from 'lucide-react'
import { api, API_URL, withDocImageAuth, type Me } from '@/lib/api'
import { useDocPresence } from '@/hooks/useProjectSocket'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DocEditor } from '@/components/documents/DocEditor'
import { useConfirm } from '@/components/ui/confirm'
import { DragHandle } from '@/components/ui/drag-handle'
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
type Member = {
  user: { id: string; name: string; email: string; avatarUrl: string | null }
  role?: 'owner' | 'admin' | 'member'
  permissions?: Record<string, boolean>
}

export function DocumentsTab({ projectId, meId }: { projectId: string; meId?: string }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  // Открытый документ живёт в адресе: ссылкой на документ делятся, и она
  // должна открывать его сразу — раньше это был локальный оверлей, из
  // которого нельзя было ни сослаться, ни вернуться кнопкой «назад».
  const { documentId: openId, companyId } = useParams()
  const navigate = useNavigate()
  const setOpenId = (id: string | null) =>
    navigate(id ? `/c/${companyId}/p/${projectId}/documents/${id}` : `/c/${companyId}/p/${projectId}/documents`)
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

  // Удаление — по тому же праву, что проверяет сервер (documents.delete).
  // Кнопка, которая приведёт к 403, хуже отсутствующей: она обещает то, чего
  // не будет.
  const me = useMemo(() => (members.data ?? []).find((m) => m.user.id === meId), [members.data, meId])
  const canDelete = me?.role === 'owner' || me?.role === 'admin' || Boolean(me?.permissions?.['documents.delete'])

  const create = useMutation({
    mutationFn: () => api<Doc>('/api/v1/documents', { method: 'POST', body: JSON.stringify({ title: t('docs.untitled'), content: '' }) }, 'project'),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['documents', projectId] })
      setOpenId(d.id)
    },
    onError: onErr,
  })

  // ?create=1 — сразу создать документ: так приходит горячая клавиша. Ref
  // защищает от повторного создания, пока адрес не успел очиститься.
  const [params, setParams] = useSearchParams()
  const creatingRef = useRef(false)
  useEffect(() => {
    if (params.get('create') !== '1' || creatingRef.current) return
    creatingRef.current = true
    create.mutate()
    const next = new URLSearchParams(params)
    next.delete('create')
    setParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])

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
    <div className="mx-auto w-full max-w-6xl space-y-4 p-6">
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

      {/* Карточки, а не полосы: у документа есть начало текста, и по нему
          его узнают быстрее, чем по одному заголовку в строке. */}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.isLoading && <p className="text-sm text-muted-foreground">…</p>}
        {(list.data ?? []).map((d) => (
          // group — чтобы «три точки» проявлялись при наведении на карточку
          <li key={d.id} className="group relative">
            <button
              // Перетаскивание в чат: документ — такой же предмет разговора,
              // как задача или файл, и ссылку на него хочется бросить сразу.
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'copy'
                e.dataTransfer.setData('application/x-chatick-document', JSON.stringify({ id: d.id, name: d.title }))
              }}
              onClick={() => setOpenId(d.id)}
              className="flex h-full w-full flex-col gap-2 rounded-lg border bg-card p-3 text-start transition-colors hover:border-brand/50 hover:bg-accent"
            >
              <span className="flex items-start gap-2">
                <DragHandle className="mt-0.5 -ms-1" />
                <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                {/* место под меню, чтобы длинный заголовок не уезжал под него */}
                <span className="min-w-0 flex-1 truncate pe-6 text-sm font-medium">{d.title}</span>
                {d.publicSlug && <Globe className="mt-0.5 size-3 shrink-0 text-brand" />}
              </span>
              {d.preview && <span className="line-clamp-3 flex-1 text-xs text-muted-foreground">{d.preview}</span>}
              <span className="mt-auto flex items-center gap-2 text-xs text-muted-foreground">
                {d.author && <Avatar name={d.author.name} src={d.author.avatarUrl} size={18} />}
                <span className="truncate">{d.author?.name}</span>
                <span className="ms-auto shrink-0">{new Date(d.updatedAt).toLocaleDateString(i18n.language)}</span>
              </span>
            </button>

            {/* Меню — соседом кнопки, а не внутри: вложенная кнопка в кнопку
                невалидна, и клик по ней открывал бы заодно сам документ. */}
            {canDelete && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    title={t('docs.menu')}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute end-2 top-2 cursor-pointer rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                  >
                    <MoreVertical className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={async () => {
                      if (
                        await confirm({
                          title: t('docs.deleteConfirm', { title: d.title }),
                          destructive: true,
                          confirmLabel: t('files.delete'),
                        })
                      )
                        remove.mutate(d.id)
                    }}
                  >
                    <Trash2 className="size-4 text-destructive" />
                    {t('files.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </li>
        ))}
        {list.data && list.data.length === 0 && (
          <p className="col-span-full py-8 text-center text-sm text-muted-foreground">{t('docs.empty')}</p>
        )}
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
  const [showHistory, setShowHistory] = useState(false)
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/v1/auth/me') })
  const viewers = useDocPresence(projectId, docId, me.data?.id)

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
      // без тоаста: сохранение автоматическое и частое, всплывашка на каждое
      // срабатывание только мешает. Статус показываем текстом в шапке.
      qc.invalidateQueries({ queryKey: ['documents', projectId] })
      qc.invalidateQueries({ queryKey: ['document', docId] })
    },
    onError: onErr,
  })

  // актуальные значения для сохранения при размонтировании
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const saveRef = useRef(() => save.mutate())
  saveRef.current = () => save.mutate()

  // HTML-снимок в documents.content (SPEC §8.25 шаг 2).
  // Сам текст синхронизируется через Yjs, снимок нужен для версий, публичной
  // страницы, экспорта и ИИ. Пишем реже (8с) — иначе несколько соредакторов
  // забьют БД конкурирующими PATCH-ами.
  useEffect(() => {
    if (!dirty) return
    const id = setTimeout(() => save.mutate(), 8000)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, title, content])

  // уходя со страницы — дописать снимок, чтобы версия не отстала
  useEffect(() => {
    return () => {
      if (dirtyRef.current) saveRef.current()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const share = useMutation({
    mutationFn: (enabled: boolean) => api<{ publicSlug: string | null }>(`/api/v1/documents/${docId}/share`, { method: 'POST', body: JSON.stringify({ enabled }) }, 'project'),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['document', docId] })
      qc.invalidateQueries({ queryKey: ['documents', projectId] })
      // о выключении не сообщаем — состояние видно по самой кнопке.
      // о включении говорим: ссылка молча уходит в буфер обмена
      if (r.publicSlug) {
        const url = `${API_URL}/d/${r.publicSlug}`
        navigator.clipboard.writeText(url).catch(() => {})
        toast.success(t('docs.shared'))
      }
    },
    onError: onErr,
  })

  // Экспорт. .doc — это HTML с Word-заголовками: Word открывает его как документ,
  // сохраняя форматирование (таблицы, списки, картинки) без внешних зависимостей.
  const download = (kind: 'html' | 'doc') => {
    const safe = (title || 'document').replace(/[^\w\-]+/g, '_').slice(0, 40)
    const esc = (s: string) => s.replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[ch]!)
    // картинки должны открыться и вне приложения → отдаём с токеном
    const body = withDocImageAuth(content)
    const page = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:16px/1.7 system-ui,sans-serif;max-width:48rem;margin:0 auto;padding:2rem}
img{max-width:100%;height:auto;display:block}
img[data-align="center"]{margin-inline:auto}img[data-align="right"]{margin-inline-start:auto}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ddd;padding:.45rem .6rem;text-align:left}th{background:#f4f4f5}
blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:1rem;color:#666}
pre{background:#f4f4f5;padding:.85rem;border-radius:6px;overflow-x:auto}</style>
</head><body><h1>${esc(title)}</h1>${body}</body></html>`
    const blob = new Blob([page], { type: kind === 'doc' ? 'application/msword' : 'text/html' })
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
        {/* статус автосохранения вместо тоаста на каждое срабатывание */}
        <span className="text-xs text-muted-foreground">
          {save.isPending ? t('docs.saving') : dirty ? t('docs.unsaved') : t('docs.allSaved')}
        </span>

        {/* Кто ещё открыл этот документ (SPEC §8.25) */}
        {viewers.length > 0 && (
          <div className="flex items-center -space-x-1.5" title={viewers.map((v) => v.name).join(', ')}>
            {viewers.slice(0, 4).map((v) => (
              <span key={v.id} className="rounded-full ring-2 ring-background">
                <Avatar name={v.name} src={v.avatarUrl} size={22} />
              </span>
            ))}
            {viewers.length > 4 && <span className="ps-2.5 text-xs text-muted-foreground">+{viewers.length - 4}</span>}
          </div>
        )}

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
              <DropdownMenuItem onSelect={() => download('doc')}>Word (.doc)</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => download('html')}>HTML (.html)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant={showHistory ? 'outline' : 'ghost'}
            size="icon"
            title={t('docs.history')}
            onClick={() => setShowHistory((v) => !v)}
          >
            <History className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" title={t('files.delete')} onClick={() => onDelete(docId, title)}>
            <Trash2 className="size-4 text-muted-foreground hover:text-destructive" />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1400px] space-y-3 p-4 sm:p-6">
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
            <DocEditor
              value={doc.data.content}
              onChange={(html) => {
                setContent(html)
                setDirty(true)
              }}
              placeholder={t('docs.contentPlaceholder')}
              mentions={members.map((m) => ({ id: m.user.id, label: m.user.name || m.user.email, avatarUrl: m.user.avatarUrl }))}
              projectId={projectId}
              documentId={docId}
              me={me.data ? { id: me.data.id, name: me.data.name } : null}
            />
          )}
        </div>
        </div>

        {showHistory && (
          <DocHistory
            docId={docId}
            projectId={projectId}
            onClose={() => setShowHistory(false)}
            onRestored={() => {
              qc.invalidateQueries({ queryKey: ['document', docId] })
              qc.invalidateQueries({ queryKey: ['documents', projectId] })
            }}
          />
        )}
      </div>
    </div>
  )
}

// --- История версий документа (SPEC §8.25) ---
type DocVersion = {
  id: string
  version: number
  title: string
  note: string
  createdAt: string
  size: number
  author: { id: string; name: string; avatarUrl: string | null } | null
}

function DocHistory({
  docId,
  projectId,
  onClose,
  onRestored,
}: {
  docId: string
  projectId: string
  onClose: () => void
  onRestored: () => void
}) {
  const { t, i18n } = useTranslation()
  const confirm = useConfirm()
  const [preview, setPreview] = useState<{ version: number; content: string } | null>(null)

  const versions = useQuery({
    queryKey: ['document-versions', docId],
    queryFn: () => api<DocVersion[]>(`/api/v1/documents/${docId}/versions`, {}, 'project'),
  })

  const restore = useMutation({
    mutationFn: (versionId: string) => api(`/api/v1/documents/${docId}/versions/${versionId}/restore`, { method: 'POST' }, 'project'),
    onSuccess: () => {
      toast.success(t('docs.restored'))
      setPreview(null)
      onRestored()
      versions.refetch()
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const open = async (v: DocVersion) => {
    const full = await api<{ content: string }>(`/api/v1/documents/${docId}/versions/${v.id}`, {}, 'project')
    setPreview({ version: v.version, content: full.content })
  }

  return (
    <aside
      className={cn(
        'flex flex-col bg-card/50',
        // мобильный: поверх редактора; десктоп: колонка сбоку
        'fixed inset-0 z-40 sm:static sm:z-0 sm:w-72 sm:shrink-0 sm:border-s',
      )}
    >
      <div className="flex items-center justify-between border-b px-3 py-2.5">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <History className="size-4" />
          {t('docs.history')}
        </h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('docs.close')}
        </Button>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {versions.isLoading && <p className="p-3 text-xs text-muted-foreground">…</p>}
        {(versions.data ?? []).map((v) => (
          <li key={v.id}>
            <div className="rounded-md px-2 py-2 transition-colors hover:bg-accent">
              <button onClick={() => void open(v)} className="w-full text-start">
                <span className="flex items-center gap-2">
                  {v.author && <Avatar name={v.author.name} src={v.author.avatarUrl} size={18} />}
                  <span className="truncate text-xs font-medium">v{v.version}</span>
                  <span className="ms-auto text-[11px] text-muted-foreground">
                    {new Date(v.createdAt).toLocaleString(i18n.language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </span>
                {v.note && <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{v.note}</span>}
              </button>
              <button
                onClick={async () => {
                  if (await confirm({ title: t('docs.restoreConfirm', { version: v.version }), confirmLabel: t('docs.restore') }))
                    restore.mutate(v.id)
                }}
                className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-brand"
              >
                <RotateCcw className="size-3" />
                {t('docs.restore')}
              </button>
            </div>
          </li>
        ))}
        {versions.data && versions.data.length === 0 && <p className="p-3 text-xs text-muted-foreground">{t('docs.noVersions')}</p>}
      </ul>

      {/* Просмотр содержимого выбранной версии */}
      {preview && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setPreview(null)}>
          <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl border bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b px-4 py-2.5">
              <h3 className="text-sm font-semibold">v{preview.version}</h3>
              <Button variant="ghost" size="sm" onClick={() => setPreview(null)}>
                {t('docs.close')}
              </Button>
            </div>
            <div
              className="tiptap-readonly min-h-0 flex-1 overflow-y-auto p-4"
              dangerouslySetInnerHTML={{ __html: withDocImageAuth(preview.content) }}
            />
          </div>
        </div>
      )}
    </aside>
  )
}
