import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ChevronDown, Plus, Search, Trash2, UserPlus, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useConfirm } from '@/components/ui/confirm'

// Таб «Команда» проекта: участники + доменные права инлайн + добавление из компании (SPEC §3.2, §4.3, §8)
const DOMAINS = ['tasks', 'files', 'resources'] as const
type Domain = (typeof DOMAINS)[number]
const LEVELS = ['none', 'read', 'write', 'crud'] as const
type Level = (typeof LEVELS)[number]

type Member = {
  id: string
  role: 'owner' | 'admin' | 'member'
  domains: Record<Domain, Level>
  jobTitle: string
  responsibility: string
  user: { id: string; name: string; email: string; avatarUrl: string | null }
}
type CompanyMember = {
  id: string
  role: string
  user: { id: string; name: string; email: string; avatarUrl: string | null }
}

export function ProjectTeamTab({
  projectId,
  companyId,
  canEdit,
}: {
  projectId: string
  companyId?: string
  canEdit: boolean
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const members = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => api<Member[]>(`/api/v1/projects/${projectId}/members`),
  })

  const filtered = useMemo(() => {
    const list = members.data ?? []
    const needle = q.trim().toLowerCase()
    return needle
      ? list.filter((m) => m.user.name.toLowerCase().includes(needle) || m.user.email.toLowerCase().includes(needle))
      : list
  }, [members.data, q])

  const onErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))
  const refresh = () => qc.invalidateQueries({ queryKey: ['project-members', projectId] })

  const setLevel = useMutation({
    mutationFn: ({ userId, domain, level }: { userId: string; domain: Domain; level: Level }) =>
      api(`/api/v1/projects/${projectId}/members/${userId}/permissions`, {
        method: 'PATCH',
        body: JSON.stringify({ [domain]: level }),
      }),
    onSuccess: refresh,
    onError: onErr,
  })

  const setProfile = useMutation({
    mutationFn: ({ userId, ...body }: { userId: string; jobTitle?: string; responsibility?: string }) =>
      api(`/api/v1/projects/${projectId}/members/${userId}/profile`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: refresh,
    onError: onErr,
  })

  const removeMember = useMutation({
    mutationFn: (userId: string) => api(`/api/v1/projects/${projectId}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t('team.memberRemoved'))
      refresh()
    },
    onError: onErr,
  })

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">{t('projTeam.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('projTeam.subtitle')}</p>
        </div>
        {canEdit && (
          <Button variant="brand" onClick={() => setAdding(true)}>
            <UserPlus className="size-4" />
            {t('projTeam.add')}
          </Button>
        )}
      </div>

      <div className="relative mt-4">
        <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('team.search')} className="ps-9" />
      </div>

      {adding && companyId && (
        <AddFromCompany
          projectId={projectId}
          companyId={companyId}
          existingIds={new Set(members.data?.map((m) => m.user.id))}
          onClose={() => setAdding(false)}
          onAdded={refresh}
        />
      )}

      <ul className="mt-4 space-y-1.5">
        {members.isLoading && <p className="text-sm text-muted-foreground">…</p>}
        {filtered.map((m) => {
          const isOwner = m.role === 'owner'
          const isExpanded = expanded === m.id
          return (
            <li key={m.id} className="rounded-lg border bg-card">
              <div className="flex items-center gap-3 px-3 py-2.5">
                {m.user.avatarUrl ? (
                  <img src={m.user.avatarUrl} alt="" className="size-8 rounded-full" referrerPolicy="no-referrer" />
                ) : (
                  <span className="grid size-8 place-items-center rounded-full bg-secondary text-xs font-semibold">
                    {(m.user.name || m.user.email)[0]?.toUpperCase()}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{m.user.name || m.user.email}</span>
                  <span className="block truncate text-xs text-muted-foreground">{m.user.email}</span>
                </span>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
                  {t(`roles.${m.role}`)}
                </span>
                {canEdit && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setExpanded(isExpanded ? null : m.id)}
                      className="gap-1"
                    >
                      {t('projTeam.permissions')}
                      <ChevronDown className={cn('size-3.5 transition-transform', isExpanded && 'rotate-180')} />
                    </Button>
                    {!isOwner && (
                      <Button
                        variant="destructive"
                        size="icon"
                        title={t('projTeam.remove')}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: t('projTeam.removeConfirm', { name: m.user.name || m.user.email }),
                              description: t('projTeam.removeNote'),
                              destructive: true,
                              confirmLabel: t('projTeam.remove'),
                            })
                          )
                            removeMember.mutate(m.user.id)
                        }}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </>
                )}
              </div>

              {/* Доменные права инлайн: домен → уровень (none/read/write/crud) */}
              {isExpanded && (
                <div className="space-y-2.5 border-t px-4 py-3">
                  {/* Должность и зона ответственности (опрокидывается в ИИ) — SPEC §8.12 */}
                  <ProfileFields
                    member={m}
                    canEdit={canEdit}
                    onSave={(jobTitle, responsibility) => setProfile.mutate({ userId: m.user.id, jobTitle, responsibility })}
                  />
                  {DOMAINS.map((d) => (
                    <div key={d} className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium">{t(`perms.domain.${d}`)}</span>
                      <div className="inline-flex overflow-hidden rounded-md border">
                        {LEVELS.map((lvl) => {
                          const active = m.domains[d] === lvl
                          return (
                            <button
                              key={lvl}
                              type="button"
                              disabled={!canEdit || isOwner}
                              onClick={() => setLevel.mutate({ userId: m.user.id, domain: d, level: lvl })}
                              className={cn(
                                'px-2.5 py-1 text-xs transition-colors disabled:opacity-50',
                                active
                                  ? 'bg-primary text-primary-foreground'
                                  : 'bg-card text-muted-foreground hover:bg-secondary',
                                lvl !== 'none' && 'border-s',
                              )}
                              title={t(`perms.level.${lvl}.hint`)}
                            >
                              {t(`perms.level.${lvl}.label`)}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">{t('perms.aiNote')}</p>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// Должность + зона ответственности участника (SPEC §8.12)
function ProfileFields({
  member,
  canEdit,
  onSave,
}: {
  member: Member
  canEdit: boolean
  onSave: (jobTitle: string, responsibility: string) => void
}) {
  const { t } = useTranslation()
  const [jobTitle, setJobTitle] = useState(member.jobTitle)
  const [responsibility, setResponsibility] = useState(member.responsibility)
  const dirty = jobTitle !== member.jobTitle || responsibility !== member.responsibility

  return (
    <div className="space-y-2 rounded-md bg-muted/30 p-2.5">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="mb-0.5 block text-xs text-muted-foreground">{t('projTeam.jobTitle')}</span>
          <input
            value={jobTitle}
            disabled={!canEdit}
            maxLength={200}
            onChange={(e) => setJobTitle(e.target.value)}
            placeholder={t('projTeam.jobTitlePlaceholder')}
            className="h-8 w-full rounded border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-70"
          />
        </label>
        <label className="block">
          <span className="mb-0.5 block text-xs text-muted-foreground">{t('projTeam.responsibility')}</span>
          <input
            value={responsibility}
            disabled={!canEdit}
            maxLength={400}
            onChange={(e) => setResponsibility(e.target.value)}
            placeholder={t('projTeam.responsibilityPlaceholder')}
            className="h-8 w-full rounded border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-70"
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t('projTeam.profileAiNote')}</p>
      {canEdit && dirty && (
        <Button variant="brand" size="sm" onClick={() => onSave(jobTitle, responsibility)}>
          {t('projectForm.save')}
        </Button>
      )}
    </div>
  )
}

// Добавление участника компании в проект (без подтверждения, письмо постфактум)
function AddFromCompany({
  projectId,
  companyId,
  existingIds,
  onClose,
  onAdded,
}: {
  projectId: string
  companyId: string
  existingIds: Set<string | undefined>
  onClose: () => void
  onAdded: () => void
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')

  const companyMembers = useQuery({
    queryKey: ['company-members', companyId],
    queryFn: () => api<CompanyMember[]>(`/api/v1/companies/${companyId}/members`),
  })

  const available = useMemo(() => {
    const list = (companyMembers.data ?? []).filter((m) => !existingIds.has(m.user.id))
    const needle = q.trim().toLowerCase()
    return needle
      ? list.filter((m) => m.user.name.toLowerCase().includes(needle) || m.user.email.toLowerCase().includes(needle))
      : list
  }, [companyMembers.data, existingIds, q])

  const add = useMutation({
    mutationFn: (userId: string) =>
      api(`/api/v1/projects/${projectId}/members`, { method: 'POST', body: JSON.stringify({ userId }) }),
    onSuccess: () => {
      toast.success(t('projTeam.added'))
      onAdded()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  return (
    <div className="mt-4 rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold">{t('projTeam.addTitle')}</h3>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('team.search')} />
      <ul className="mt-3 max-h-56 space-y-1.5 overflow-y-auto">
        {available.map((m) => (
          <li key={m.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
            {m.user.avatarUrl ? (
              <img src={m.user.avatarUrl} alt="" className="size-7 rounded-full" referrerPolicy="no-referrer" />
            ) : (
              <span className="grid size-7 place-items-center rounded-full bg-secondary text-xs font-semibold">
                {(m.user.name || m.user.email)[0]?.toUpperCase()}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{m.user.name || m.user.email}</span>
              <span className="block truncate text-xs text-muted-foreground">{m.user.email}</span>
            </span>
            <Button variant="brand" size="sm" onClick={() => add.mutate(m.user.id)} disabled={add.isPending}>
              <Plus className="size-3.5" />
              {t('projTeam.addBtn')}
            </Button>
          </li>
        ))}
        {available.length === 0 && (
          <p className="p-3 text-center text-xs text-muted-foreground">{t('projTeam.nobodyToAdd')}</p>
        )}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">{t('projTeam.addNote')}</p>
    </div>
  )
}
