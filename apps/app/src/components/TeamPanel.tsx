import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Mail, RotateCw, Trash2, UserPlus, X } from 'lucide-react'
import { api, type Company } from '@/lib/api'
import { cn } from '@/lib/utils'

type MemberRow = { id: string; role: 'admin' | 'manager' | 'member'; user: { id: string; name: string; email: string; avatarUrl: string | null } }
type InviteRow = { id: string; email: string; role: string; status: string }

const ROLES = ['admin', 'manager', 'member'] as const

// Управление командой компании: участники + роли, инвайты (SPEC §2.1, §3.1)
export function TeamPanel({ company, meId, onClose }: { company: Company; meId?: string; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<(typeof ROLES)[number]>('member')

  const isAdmin = company.myRole === 'admin'
  const base = `/api/v1/companies/${company.id}`

  const members = useQuery({ queryKey: ['company-members', company.id], queryFn: () => api<MemberRow[]>(`${base}/members`) })
  const invites = useQuery({ queryKey: ['company-invites', company.id], queryFn: () => api<InviteRow[]>(`${base}/invites`) })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['company-members', company.id] })
    qc.invalidateQueries({ queryKey: ['company-invites', company.id] })
  }
  const onErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

  const invite = useMutation({
    mutationFn: () => api(`${base}/invites`, { method: 'POST', body: JSON.stringify({ email, role }) }),
    onSuccess: () => {
      toast.success(t('team.inviteSent'))
      setEmail('')
      refresh()
    },
    onError: onErr,
  })
  const resend = useMutation({
    mutationFn: (id: string) => api(`${base}/invites/${id}/resend`, { method: 'POST' }),
    onSuccess: () => toast.success(t('team.inviteResent')),
    onError: onErr,
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api(`${base}/invites/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: onErr,
  })
  const setMemberRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      api(`${base}/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
    onSuccess: refresh,
    onError: onErr,
  })
  const removeMember = useMutation({
    mutationFn: (userId: string) => api(`${base}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t('team.memberRemoved'))
      refresh()
    },
    onError: onErr,
  })

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 sm:p-6">
      <div className="flex max-h-[88dvh] w-full max-w-lg flex-col rounded-xl border bg-card shadow-xl">
        <header className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-base font-bold">{t('team.title', { company: company.name })}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          {/* Приглашение */}
          <section>
            <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{t('team.invite')}</h3>
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (email.trim()) invite.mutate()
              }}
            >
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email@company.com"
                className="h-9 min-w-40 flex-1 rounded-md border bg-transparent px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}
                className="h-9 rounded-md border bg-transparent px-2 text-sm text-foreground"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r} className="bg-background">
                    {t(`roles.${r}`)}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={!email.trim() || invite.isPending}
                className="flex h-9 items-center gap-1.5 rounded-md bg-brand px-3 text-sm font-semibold text-brand-foreground disabled:opacity-40"
              >
                <UserPlus className="size-4" />
                {t('team.send')}
              </button>
            </form>
          </section>

          {/* Pending-инвайты */}
          {(invites.data?.length ?? 0) > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{t('team.pending')}</h3>
              <ul className="space-y-1.5">
                {invites.data!.map((inv) => (
                  <li key={inv.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
                    <Mail className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm">{inv.email}</span>
                    <span className="text-xs text-muted-foreground">{t(`roles.${inv.role}`)}</span>
                    <button
                      onClick={() => resend.mutate(inv.id)}
                      title={t('team.resend')}
                      className="rounded p-1 text-muted-foreground hover:text-foreground"
                    >
                      <RotateCw className="size-3.5" />
                    </button>
                    <button
                      onClick={() => revoke.mutate(inv.id)}
                      title={t('team.revoke')}
                      className="rounded p-1 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Участники */}
          <section>
            <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{t('team.members')}</h3>
            <ul className="space-y-1.5">
              {members.data?.map((m) => {
                const isSelf = m.user.id === meId
                return (
                  <li key={m.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
                    {m.user.avatarUrl ? (
                      <img src={m.user.avatarUrl} alt="" className="size-7 rounded-full" referrerPolicy="no-referrer" />
                    ) : (
                      <span className="grid size-7 place-items-center rounded-full bg-secondary text-xs font-semibold">
                        {(m.user.name || m.user.email)[0]?.toUpperCase()}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {m.user.name || m.user.email}
                        {isSelf && <span className="text-muted-foreground"> · {t('team.you')}</span>}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">{m.user.email}</span>
                    </span>
                    {isAdmin ? (
                      <select
                        value={m.role}
                        onChange={(e) => setMemberRole.mutate({ userId: m.user.id, role: e.target.value })}
                        className={cn('h-8 rounded-md border bg-transparent px-2 text-xs text-foreground')}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r} className="bg-background">
                            {t(`roles.${r}`)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t(`roles.${m.role}`)}</span>
                    )}
                    {isAdmin && !isSelf && (
                      <button
                        onClick={() => {
                          if (confirm(t('team.removeConfirm', { name: m.user.name || m.user.email }))) removeMember.mutate(m.user.id)
                        }}
                        title={t('team.remove')}
                        className="rounded p-1 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}
