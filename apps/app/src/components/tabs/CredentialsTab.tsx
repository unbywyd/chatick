import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Copy, Eye, EyeOff, KeyRound, Pencil, Plus, ScrollText, Search, Trash2, X } from 'lucide-react'
import { api } from '@/lib/api'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm'

type CredRow = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  creator: { id: string; name: string } | null
}
type AuditRow = {
  id: string
  action: 'reveal' | 'create' | 'update' | 'delete'
  credentialName: string
  createdAt: string
  user: { id: string; name: string; email: string } | null
}

const REVEAL_TTL_MS = 30_000 // автоскрытие раскрытого значения

// Таб «Кредишены»: значения скрыты, reveal по клику (аудируется), автоскрытие 30с
export function CredentialsTab({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<CredRow | null>(null)
  const [showAudit, setShowAudit] = useState(false)
  // раскрытые значения живут только в локальном стейте, не в react-query кэше
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), [])

  const credsQ = useQuery({
    queryKey: ['credentials', projectId],
    queryFn: () => api<CredRow[]>('/api/v1/credentials', {}, 'project'),
  })

  const filtered = useMemo(() => {
    const list = credsQ.data ?? []
    const needle = q.trim().toLowerCase()
    return needle ? list.filter((c) => c.name.toLowerCase().includes(needle)) : list
  }, [credsQ.data, q])

  const onErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

  const hide = (id: string) => {
    setRevealed((r) => {
      const { [id]: _, ...rest } = r
      return rest
    })
    clearTimeout(timers.current[id])
    delete timers.current[id]
  }

  const reveal = useMutation({
    mutationFn: (id: string) => api<{ value: string }>(`/api/v1/credentials/${id}/reveal`, { method: 'POST' }, 'project'),
    onSuccess: (r, id) => {
      setRevealed((prev) => ({ ...prev, [id]: r.value }))
      clearTimeout(timers.current[id])
      timers.current[id] = setTimeout(() => hide(id), REVEAL_TTL_MS)
    },
    onError: onErr,
  })

  const copyValue = async (id: string) => {
    try {
      // копирование = reveal на сервере (аудит), но без показа на экран
      const { value } = await api<{ value: string }>(`/api/v1/credentials/${id}/reveal`, { method: 'POST' }, 'project')
      await navigator.clipboard.writeText(value)
      toast.success(t('creds.copied'))
    } catch (e) {
      onErr(e)
    }
  }

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/credentials/${id}`, { method: 'DELETE' }, 'project'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['credentials', projectId] }),
    onError: onErr,
  })

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('creds.search')} className="ps-9" />
        </div>
        {isAdmin && (
          <Button variant="outline" onClick={() => setShowAudit((v) => !v)}>
            <ScrollText className="size-4" />
            {t('creds.audit')}
          </Button>
        )}
        <Button variant="brand" onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          {t('creds.add')}
        </Button>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">{t('creds.securityNote')}</p>

      {showAudit && isAdmin && <AuditLog projectId={projectId} onClose={() => setShowAudit(false)} />}

      {(creating || editing) && (
        <CredForm
          projectId={projectId}
          editing={editing}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
        />
      )}

      <ul className="mt-4 space-y-1.5">
        {credsQ.isLoading && <p className="text-sm text-muted-foreground">…</p>}
        {filtered.map((cred) => {
          const value = revealed[cred.id]
          const isOpen = value !== undefined
          return (
            <li key={cred.id} className="rounded-lg border bg-card px-3 py-2.5">
              <div className="flex items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-md bg-secondary">
                  <KeyRound className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{cred.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {cred.creator?.name && <>{cred.creator.name} · </>}
                    {new Date(cred.createdAt).toLocaleDateString(i18n.language)}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  title={isOpen ? t('creds.hide') : t('creds.reveal')}
                  onClick={() => (isOpen ? hide(cred.id) : reveal.mutate(cred.id))}
                >
                  {isOpen ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
                <Button variant="ghost" size="icon" title={t('creds.copy')} onClick={() => copyValue(cred.id)}>
                  <Copy className="size-4" />
                </Button>
                <Button variant="ghost" size="icon" title={t('about.edit')} onClick={() => setEditing(cred)}>
                  <Pencil className="size-4" />
                </Button>
                <Button
                  variant="destructive"
                  size="icon"
                  title={t('files.delete')}
                  onClick={async () => {
                    if (await confirm({ title: t('creds.deleteConfirm', { name: cred.name }), destructive: true, confirmLabel: t('files.delete') }))
                      remove.mutate(cred.id)
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
              {isOpen && (
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-secondary p-3 font-mono text-xs">
                  {value}
                </pre>
              )}
            </li>
          )
        })}
        {!credsQ.isLoading && filtered.length === 0 && (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {q ? t('start.nothingFound') : t('creds.empty')}
          </p>
        )}
      </ul>
    </div>
  )
}

function CredForm({ projectId, editing, onClose }: { projectId: string; editing: CredRow | null; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [name, setName] = useState(editing?.name ?? '')
  const [value, setValue] = useState('')

  const save = useMutation({
    mutationFn: () =>
      editing
        ? api(`/api/v1/credentials/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ name, ...(value ? { value } : {}) }) }, 'project')
        : api('/api/v1/credentials', { method: 'POST', body: JSON.stringify({ name, value }) }, 'project'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['credentials', projectId] })
      toast.success(t('projectForm.saved'))
      onClose()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  return (
    <div className="mt-4 rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold">{editing ? t('creds.editTitle') : t('creds.addTitle')}</h3>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() && (editing || value)) save.mutate()
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('creds.namePlaceholder')} />
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={3}
          placeholder={editing ? t('creds.valueKeepPlaceholder') : t('creds.valuePlaceholder')}
          autoComplete="off"
          spellCheck={false}
          className="w-full resize-none rounded-md border bg-transparent px-3 py-2 font-mono text-xs outline-none placeholder:font-sans placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
        />
        <div className="flex justify-end">
          <Button variant="brand" type="submit" disabled={!name.trim() || (!editing && !value) || save.isPending}>
            {t('projectForm.save')}
          </Button>
        </div>
      </form>
    </div>
  )
}

function AuditLog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const auditQ = useQuery({
    queryKey: ['credentials-audit', projectId],
    queryFn: () => api<AuditRow[]>('/api/v1/credentials/audit', {}, 'project'),
  })

  return (
    <div className="mt-4 rounded-xl border bg-card p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-bold">{t('creds.auditTitle')}</h3>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <ul className="max-h-64 space-y-1 overflow-y-auto">
        {auditQ.data?.map((row) => (
          <li key={row.id} className="flex items-center gap-2 rounded px-2 py-1 text-xs">
            <span className="w-32 shrink-0 text-muted-foreground">
              {new Date(row.createdAt).toLocaleString(i18n.language)}
            </span>
            <span className="truncate font-medium">{row.user?.name ?? row.user?.email ?? '—'}</span>
            <span className="rounded-full bg-secondary px-1.5 py-0.5">{t(`creds.actions.${row.action}`)}</span>
            <span className="truncate text-muted-foreground">{row.credentialName}</span>
          </li>
        ))}
        {auditQ.data?.length === 0 && <p className="text-xs text-muted-foreground">{t('creds.auditEmpty')}</p>}
      </ul>
    </div>
  )
}
