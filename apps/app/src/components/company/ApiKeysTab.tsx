import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check, Copy, KeyRound, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useConfirm } from '@/components/ui/confirm'

// Ключи API компании (SPEC-INTEGRATION §2).
//
// Ключ позволяет заводить людей и проекты без подтверждения — это ключ от всей
// компании. Поэтому здесь всё устроено вокруг одного: понимать, что у тебя
// есть, и уметь мгновенно это отозвать.

type ApiKey = {
  id: string
  name: string
  prefix: string
  scopes: string[]
  allowedIps: string[]
  lastUsedAt: string | null
  createdAt: string
}

const SCOPES = ['users:write', 'projects:write', 'read:all'] as const

export function ApiKeysTab({ companyId, isAdmin }: { companyId: string; isAdmin: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()

  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>(['read:all'])
  // Ключ показывается ОДИН раз — сразу после создания. Дальше в базе только
  // хеш, и достать его оттуда невозможно даже нам.
  const [fresh, setFresh] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const keys = useQuery({
    queryKey: ['api-keys', companyId],
    enabled: isAdmin,
    queryFn: () => api<{ items: ApiKey[] }>(`/api/v1/companies/${companyId}/api-keys`),
  })

  const create = useMutation({
    mutationFn: () =>
      api<{ key: string }>(`/api/v1/companies/${companyId}/api-keys`, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), scopes }),
      }),
    onSuccess: (res) => {
      setFresh(res.key)
      setCreating(false)
      setName('')
      setScopes(['read:all'])
      qc.invalidateQueries({ queryKey: ['api-keys', companyId] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/v1/companies/${companyId}/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['api-keys', companyId] })
      toast.success(t('apiKeys.revoked'))
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  if (!isAdmin) return <p className="p-6 text-sm text-muted-foreground">{t('apiKeys.adminOnly')}</p>

  const copy = async () => {
    if (!fresh) return
    try {
      await navigator.clipboard.writeText(fresh)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(t('composer.clipboardDenied'))
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <KeyRound className="size-5" />
          {t('apiKeys.title')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('apiKeys.subtitle')}</p>
      </div>

      {/* Только что созданный ключ. Показываем крупно и с предупреждением:
          второй возможности увидеть его не будет. */}
      {fresh && (
        <div className="rounded-xl border border-brand bg-brand/5 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <TriangleAlert className="size-4 text-brand-ink" />
            {t('apiKeys.onceTitle')}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{t('apiKeys.onceHint')}</p>
          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-secondary px-3 py-2 font-mono text-xs">
              {fresh}
            </code>
            <Button variant="outline" size="sm" onClick={copy}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? t('apiKeys.copied') : t('apiKeys.copy')}
            </Button>
          </div>
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => setFresh(null)}>
            {t('apiKeys.hide')}
          </Button>
        </div>
      )}

      {creating ? (
        <div className="space-y-3 rounded-xl border bg-card p-4">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('apiKeys.namePlaceholder')}
          />
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('apiKeys.scopes')}</p>
            <div className="flex flex-wrap gap-2">
              {SCOPES.map((s) => (
                <button
                  key={s}
                  onClick={() => setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))}
                  className={cn(
                    'rounded-full border px-3 py-1.5 font-mono text-xs transition-colors',
                    scopes.includes(s) ? 'border-brand bg-brand/10' : 'text-muted-foreground hover:bg-accent',
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{t('apiKeys.scopesHint')}</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="brand"
              size="sm"
              disabled={!name.trim() || !scopes.length || create.isPending}
              onClick={() => create.mutate()}
            >
              {t('apiKeys.create')}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          {t('apiKeys.new')}
        </Button>
      )}

      <ul className="space-y-2">
        {(keys.data?.items ?? []).map((k) => (
          <li key={k.id} className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5">
            <KeyRound className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{k.name}</p>
              <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <code className="font-mono">{k.prefix}…</code>
                <span>{k.scopes.join(', ')}</span>
                {/* «Не использовался» — повод отозвать: живой ключ, которым
                    никто не пользуется, это лишний риск без пользы. */}
                <span>
                  {k.lastUsedAt
                    ? t('apiKeys.lastUsed', { when: new Date(k.lastUsedAt).toLocaleDateString() })
                    : t('apiKeys.neverUsed')}
                </span>
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:text-destructive"
              title={t('apiKeys.revoke')}
              onClick={async () => {
                if (
                  await confirm({
                    title: t('apiKeys.revokeConfirm', { name: k.name }),
                    // Отзыв мгновенный и необратимый: интеграция, которая им
                    // пользуется, встанет сразу.
                    description: t('apiKeys.revokeHint'),
                    destructive: true,
                    confirmLabel: t('apiKeys.revoke'),
                  })
                )
                  revoke.mutate(k.id)
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          </li>
        ))}
        {keys.data && !keys.data.items.length && (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('apiKeys.empty')}</p>
        )}
      </ul>
    </div>
  )
}
