import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Building2, Plus, FolderKanban, LogOut, Check, Mail, Users } from 'lucide-react'
import { TeamPanel } from '@/components/TeamPanel'
import {
  api,
  logout,
  setProjectToken,
  getSessionToken,
  type Company,
  type CompanyInvite,
  type ProjectListItem,
  type Me,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { Logo } from '@/components/Logo'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LanguageSelect } from '@/components/LanguageSelect'

// Онбординг (SPEC §5): компания (создать/выбрать/принять инвайт) → проект → enter → /p/:id
export function StartScreen() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [companyId, setCompanyId] = useState<string | null>(null)

  useEffect(() => {
    if (!getSessionToken()) navigate('/login', { replace: true })
  }, [navigate])

  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/v1/auth/me') })

  const companiesQ = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<{ companies: Company[]; invites: CompanyInvite[] }>('/api/v1/companies'),
  })

  // авто-выбор единственной компании
  useEffect(() => {
    const list = companiesQ.data?.companies
    if (list && list.length === 1 && !companyId) setCompanyId(list[0]!.id)
  }, [companiesQ.data, companyId])

  useEffect(() => {
    if (me.error) {
      logout()
      navigate('/login', { replace: true })
    }
  }, [me.error, navigate])

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <Logo />
        <div className="flex items-center gap-2">
          {me.data && <span className="me-2 hidden text-xs text-muted-foreground sm:block">{me.data.email}</span>}
          <LanguageSelect />
          <ThemeToggle />
          <button
            onClick={() => {
              logout()
              navigate('/login')
            }}
            title={t('start.logout')}
            className="rounded-md border p-1.5 text-muted-foreground hover:text-foreground"
          >
            <LogOut className="size-3.5" />
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 overflow-y-auto px-6 py-10">
        {!companyId ? (
          <CompanyStep
            data={companiesQ.data}
            loading={companiesQ.isLoading}
            onSelect={setCompanyId}
            onChanged={() => qc.invalidateQueries({ queryKey: ['companies'] })}
          />
        ) : (
          <ProjectStep
            companyId={companyId}
            company={companiesQ.data?.companies.find((c) => c.id === companyId)}
            meId={me.data?.id}
            onBack={() => setCompanyId(null)}
            onEntered={(projectId) => navigate(`/p/${projectId}`)}
          />
        )}
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------

function CompanyStep({
  data,
  loading,
  onSelect,
  onChanged,
}: {
  data?: { companies: Company[]; invites: CompanyInvite[] }
  loading: boolean
  onSelect: (id: string) => void
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')

  const createCompany = useMutation({
    mutationFn: (name: string) => api<Company>('/api/v1/companies', { method: 'POST', body: JSON.stringify({ name }) }),
    onSuccess: (c) => {
      toast.success(t('start.companyCreated'))
      onChanged()
      onSelect(c.id)
    },
    onError: (e) => toast.error(String(e)),
  })

  const acceptInvite = useMutation({
    mutationFn: (token: string) =>
      api<{ ok: true; company: Company }>(`/api/v1/companies/invites/${token}/accept`, { method: 'POST' }),
    onSuccess: (r) => {
      toast.success(t('start.inviteAccepted'))
      onChanged()
      onSelect(r.company.id)
    },
    onError: (e) => toast.error(String(e)),
  })

  if (loading) return <p className="text-center text-sm text-muted-foreground">…</p>

  const companies = data?.companies ?? []
  const invites = data?.invites ?? []

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-bold tracking-tight">{t('start.companyTitle')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('start.companySubtitle')}</p>
      </div>

      {invites.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{t('start.invitesTitle')}</h2>
          {invites.map((inv) => (
            <div key={inv.id} className="flex items-center justify-between rounded-lg border bg-card p-3">
              <div className="flex items-center gap-3">
                <Mail className="size-4 text-brand" />
                <div>
                  <p className="text-sm font-medium">{inv.company.name}</p>
                  <p className="text-xs text-muted-foreground">{inv.role}</p>
                </div>
              </div>
              <button
                onClick={() => acceptInvite.mutate(inv.token)}
                className="flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-foreground"
              >
                <Check className="size-3.5" />
                {t('start.accept')}
              </button>
            </div>
          ))}
        </section>
      )}

      {companies.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{t('start.yourCompanies')}</h2>
          {companies.map((c) => (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className="flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-start transition-colors hover:bg-accent"
            >
              {c.logoUrl ? (
                <img src={c.logoUrl} alt="" className="size-9 rounded-md object-cover" />
              ) : (
                <span className="grid size-9 place-items-center rounded-md bg-secondary">
                  <Building2 className="size-4" />
                </span>
              )}
              <span className="flex-1">
                <span className="block text-sm font-medium">{c.name}</span>
                <span className="block text-xs text-muted-foreground">{t(`roles.${c.myRole}`)}</span>
              </span>
            </button>
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">
          {companies.length ? t('start.orCreateCompany') : t('start.createFirstCompany')}
        </h2>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) createCompany.mutate(name.trim())
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('start.companyName')}
            className="h-10 flex-1 rounded-md border bg-transparent px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="submit"
            disabled={!name.trim() || createCompany.isPending}
            className="flex items-center gap-1.5 rounded-md bg-brand px-4 text-sm font-semibold text-brand-foreground disabled:opacity-40"
          >
            <Plus className="size-4" />
            {t('start.create')}
          </button>
        </form>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------

function ProjectStep({
  companyId,
  company,
  meId,
  onBack,
  onEntered,
}: {
  companyId: string
  company?: Company
  meId?: string
  onBack: () => void
  onEntered: (projectId: string) => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [rulesModal, setRulesModal] = useState<{ projectId: string; projectName: string; chatRules: string } | null>(null)
  const [teamOpen, setTeamOpen] = useState(false)

  const projectsQ = useQuery({
    queryKey: ['projects', companyId],
    queryFn: () => api<ProjectListItem[]>(`/api/v1/projects?companyId=${companyId}`),
  })

  const canCreate = company?.myRole === 'admin' || company?.myRole === 'manager'

  const createProject = useMutation({
    mutationFn: (name: string) =>
      api<{ id: string }>('/api/v1/projects', { method: 'POST', body: JSON.stringify({ companyId, name }) }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ['projects', companyId] })
      enter.mutate({ projectId: p.id, acceptRules: true })
    },
    onError: (e) => toast.error(String(e)),
  })

  const enter = useMutation({
    mutationFn: ({ projectId, acceptRules }: { projectId: string; acceptRules?: boolean }) =>
      api<{ token: string; project: { id: string } }>(`/api/v1/projects/${projectId}/enter`, {
        method: 'POST',
        body: JSON.stringify({ acceptRules: acceptRules ?? false }),
      }),
    onSuccess: (r) => {
      setProjectToken(r.token)
      onEntered(r.project.id)
    },
    onError: (e: unknown, vars) => {
      const err = e as { status?: number; body?: { needRulesAccept?: boolean; chatRules?: string; projectName?: string } }
      // 428 — надо подтвердить правила чата (SPEC §4.2)
      if (err.status === 428 && err.body?.needRulesAccept) {
        setRulesModal({ projectId: vars.projectId, projectName: err.body.projectName ?? '', chatRules: err.body.chatRules ?? '' })
      } else {
        toast.error(String(e))
      }
    },
  })

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">{company?.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('start.projectSubtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {(company?.myRole === 'admin' || company?.myRole === 'manager') && (
            <button
              onClick={() => setTeamOpen(true)}
              className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent"
            >
              <Users className="size-3.5" />
              {t('team.button')}
            </button>
          )}
          <button onClick={onBack} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
            {t('start.changeCompany')}
          </button>
        </div>
      </div>

      {teamOpen && company && <TeamPanel company={company} meId={meId} onClose={() => setTeamOpen(false)} />}

      <section className="space-y-2">
        {projectsQ.isLoading && <p className="text-sm text-muted-foreground">…</p>}
        {projectsQ.data?.map((p) => (
          <button
            key={p.id}
            onClick={() => enter.mutate({ projectId: p.id })}
            disabled={!p.isMember}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-start transition-colors',
              p.isMember ? 'hover:bg-accent' : 'opacity-50',
            )}
          >
            <span className="grid size-9 place-items-center rounded-md bg-secondary">
              <FolderKanban className="size-4" />
            </span>
            <span className="flex-1">
              <span className="block text-sm font-medium">{p.name}</span>
              <span className="block text-xs text-muted-foreground">
                {p.isMember ? t(`roles.${p.myRole}`) : t('start.notMember')}
              </span>
            </span>
          </button>
        ))}
        {projectsQ.data?.length === 0 && (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t('start.noProjects')}
          </p>
        )}
      </section>

      {canCreate && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{t('start.createProject')}</h2>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (name.trim()) createProject.mutate(name.trim())
            }}
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('start.projectName')}
              className="h-10 flex-1 rounded-md border bg-transparent px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="submit"
              disabled={!name.trim() || createProject.isPending}
              className="flex items-center gap-1.5 rounded-md bg-brand px-4 text-sm font-semibold text-brand-foreground disabled:opacity-40"
            >
              <Plus className="size-4" />
              {t('start.create')}
            </button>
          </form>
        </section>
      )}

      {/* Модал подтверждения правил чата перед первым входом */}
      {rulesModal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6">
          <div className="w-full max-w-md rounded-xl border bg-card p-6 shadow-xl">
            <h2 className="text-lg font-bold">{t('rules.title', { project: rulesModal.projectName })}</h2>
            <p className="mt-3 whitespace-pre-wrap rounded-md bg-secondary p-3 text-sm">
              {rulesModal.chatRules || t('rules.empty')}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setRulesModal(null)}
                className="rounded-md border px-4 py-2 text-sm hover:bg-accent"
              >
                {t('rules.decline')}
              </button>
              <button
                onClick={() => {
                  enter.mutate({ projectId: rulesModal.projectId, acceptRules: true })
                  setRulesModal(null)
                }}
                className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-brand-foreground"
              >
                {t('rules.accept')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
