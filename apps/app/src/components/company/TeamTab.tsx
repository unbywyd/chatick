import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ChevronDown, Lock, Mail, MoreHorizontal, RotateCw, Search, Trash2, UserPlus } from 'lucide-react'
import { api, type Company } from '@/lib/api'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

type MemberRow = {
  id: string
  role: 'admin' | 'manager' | 'member'
  user: { id: string; name: string; email: string; avatarUrl: string | null }
}
type InviteRow = { id: string; email: string; role: string; status: string }

const ROLES = ['admin', 'manager', 'member'] as const
type Role = (typeof ROLES)[number]

// Таб «Команда»: поиск, инвайты, инлайн-редактор ролей (SPEC §2.1, §3.1)
export function TeamTab({ company, meId }: { company: Company; meId?: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [q, setQ] = useState('')
  const [email, setEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<Role>('member')

  // Состав ведётся во внешней системе: смотреть можно всем, у кого и раньше,
  // а править нельзя никому — сервер всё равно откажет (SPEC §8.42).
  const locked = Boolean(company.membersViaApiOnly)
  const isAdmin = company.myRole === 'admin' && !locked
  const base = `/api/v1/companies/${company.id}`

  const members = useQuery({ queryKey: ['company-members', company.id], queryFn: () => api<MemberRow[]>(`${base}/members`) })
  const invites = useQuery({ queryKey: ['company-invites', company.id], queryFn: () => api<InviteRow[]>(`${base}/invites`) })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['company-members', company.id] })
    qc.invalidateQueries({ queryKey: ['company-invites', company.id] })
  }
  const onErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

  const invite = useMutation({
    mutationFn: () => api(`${base}/invites`, { method: 'POST', body: JSON.stringify({ email, role: inviteRole }) }),
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
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
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

  const filteredMembers = useMemo(() => {
    const list = members.data ?? []
    const needle = q.trim().toLowerCase()
    return needle
      ? list.filter((m) => m.user.name.toLowerCase().includes(needle) || m.user.email.toLowerCase().includes(needle))
      : list
  }, [members.data, q])

  const filteredInvites = useMemo(() => {
    const list = invites.data ?? []
    const needle = q.trim().toLowerCase()
    return needle ? list.filter((i) => i.email.toLowerCase().includes(needle)) : list
  }, [invites.data, q])

  return (
    <div className="space-y-6">
      {/* Поиск */}
      <div className="relative">
        <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('team.search')} className="ps-9" />
      </div>

      {/* Состав приходит извне: объясняем, почему нет кнопок. Пустое место
          без причины читается как поломка. */}
      {locked && (
        <p className="flex items-start gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          <Lock className="mt-0.5 size-3.5 shrink-0" />
          {t('team.managedExternally', { system: company.externalSystemName || t('team.yourSystem') })}
        </p>
      )}

      {/* Приглашение */}
      {!locked && (
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (email.trim()) invite.mutate()
        }}
      >
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email@company.com"
          className="min-w-44 flex-1"
        />
        <RolePicker value={inviteRole} onChange={setInviteRole} />
        <Button variant="brand" type="submit" disabled={!email.trim() || invite.isPending}>
          <UserPlus className="size-4" />
          {t('team.send')}
        </Button>
      </form>
      )}

      {/* Pending-инвайты */}
      {filteredInvites.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{t('team.pending')}</h3>
          <ul className="space-y-1.5">
            {filteredInvites.map((inv) => (
              <li key={inv.id} className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5">
                <Mail className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{inv.email}</span>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
                  {t(`roles.${inv.role}`)}
                </span>
                <Button variant="ghost" size="sm" onClick={() => resend.mutate(inv.id)} disabled={resend.isPending}>
                  <RotateCw className="size-3.5" />
                  {t('team.resend')}
                </Button>
                <Button
                  variant="destructive"
                  size="icon"
                  title={t('team.revoke')}
                  onClick={async () => {
                    if (await confirm({ title: t('team.revokeConfirm', { email: inv.email }), destructive: true, confirmLabel: t('team.revoke') }))
                      revoke.mutate(inv.id)
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Участники */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
          {t('team.members')} {members.data && <span className="tabular-nums">({members.data.length})</span>}
        </h3>
        <ul className="space-y-1.5">
          {filteredMembers.map((m) => {
            const isSelf = m.user.id === meId
            return (
              <li key={m.id} className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5">
                {m.user.avatarUrl ? (
                  <img src={m.user.avatarUrl} alt="" className="size-8 rounded-full" referrerPolicy="no-referrer" />
                ) : (
                  <span className="grid size-8 place-items-center rounded-full bg-secondary text-xs font-semibold">
                    {(m.user.name || m.user.email)[0]?.toUpperCase()}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {m.user.name || m.user.email}
                    {isSelf && <span className="font-normal text-muted-foreground"> · {t('team.you')}</span>}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{m.user.email}</span>
                </span>

                {/* Инлайн-смена роли */}
                {isAdmin ? (
                  <RolePicker value={m.role} onChange={(role) => setMemberRole.mutate({ userId: m.user.id, role })} />
                ) : (
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
                    {t(`roles.${m.role}`)}
                  </span>
                )}

                {/* Действия */}
                {isAdmin && !isSelf && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon">
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuSeparator className="hidden first:hidden" />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onSelect={async () => {
                          if (
                            await confirm({
                              title: t('team.removeConfirm', { name: m.user.name || m.user.email }),
                              destructive: true,
                              confirmLabel: t('team.remove'),
                            })
                          )
                            removeMember.mutate(m.user.id)
                        }}
                      >
                        <Trash2 className="size-3.5" />
                        {t('team.remove')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </li>
            )
          })}
          {!members.isLoading && filteredMembers.length === 0 && (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              {t('start.nothingFound')}
            </p>
          )}
        </ul>
      </section>
    </div>
  )
}

// Кастомный выбор роли — вместо нативного <select>
function RolePicker({ value, onChange }: { value: Role; onChange: (r: Role) => void }) {
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          {t(`roles.${value}`)}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {ROLES.map((r) => (
          <DropdownMenuCheckItem key={r} checked={r === value} onSelect={() => onChange(r)}>
            {t(`roles.${r}`)}
          </DropdownMenuCheckItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
