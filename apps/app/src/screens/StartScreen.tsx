import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Building2, Plus, FolderKanban, LogOut, Check, Mail, Search, X } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { TeamTab } from '@/components/company/TeamTab'
import {
  ProjectSettingsForm,
  DEFAULT_AI_CONFIG,
  type ProjectSettings,
} from '@/components/ProjectSettingsForm'

// Страница компании: табы Проекты / Команда (SPEC §5)
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

  const company = companiesQ.data?.companies.find((c) => c.id === companyId)

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <Logo />
          {company && (
            <>
              <span className="text-muted-foreground">/</span>
              <button
                onClick={() => setCompanyId(null)}
                className="text-sm font-medium underline-offset-4 hover:underline"
                title={t('start.changeCompany')}
              >
                {company.name}
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {me.data && <span className="me-2 hidden text-xs text-muted-foreground sm:block">{me.data.email}</span>}
          <LanguageSelect />
          <ThemeToggle />
          <Button
            variant="ghost"
            size="icon"
            title={t('start.logout')}
            onClick={() => {
              logout()
              navigate('/login')
            }}
          >
            <LogOut className="size-3.5" />
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-6 py-8">
        {!companyId ? (
          <CompanyPicker
            data={companiesQ.data}
            loading={companiesQ.isLoading}
            onSelect={setCompanyId}
            onChanged={() => qc.invalidateQueries({ queryKey: ['companies'] })}
          />
        ) : company ? (
          <CompanyHome company={company} meId={me.data?.id} onEntered={(id) => navigate(`/p/${id}`)} />
        ) : null}
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Выбор/создание компании + инвайты
// ---------------------------------------------------------------------------

function CompanyPicker({
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
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const acceptInvite = useMutation({
    mutationFn: (token: string) =>
      api<{ ok: true; company: Company }>(`/api/v1/companies/invites/${token}/accept`, { method: 'POST' }),
    onSuccess: (r) => {
      toast.success(t('start.inviteAccepted'))
      onChanged()
      onSelect(r.company.id)
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
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
                  <p className="text-xs text-muted-foreground">{t(`roles.${inv.role}`)}</p>
                </div>
              </div>
              <Button variant="brand" size="sm" onClick={() => acceptInvite.mutate(inv.token)}>
                <Check className="size-3.5" />
                {t('start.accept')}
              </Button>
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
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('start.companyName')} className="h-10" />
          <Button variant="brand" type="submit" disabled={!name.trim() || createCompany.isPending} className="h-10">
            <Plus className="size-4" />
            {t('start.create')}
          </Button>
        </form>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Компания: табы Проекты / Команда
// ---------------------------------------------------------------------------

function CompanyHome({
  company,
  meId,
  onEntered,
}: {
  company: Company
  meId?: string
  onEntered: (projectId: string) => void
}) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'projects' | 'team'>('projects')
  const canManage = company.myRole === 'admin' || company.myRole === 'manager'

  return (
    <div className="space-y-6">
      <nav className="flex gap-1 border-b pb-0">
        {(['projects', 'team'] as const).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
              tab === key
                ? 'border-brand text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`companyTabs.${key}`)}
          </button>
        ))}
      </nav>

      {tab === 'projects' ? (
        <ProjectsTab company={company} canManage={canManage} onEntered={onEntered} />
      ) : (
        <TeamTab company={company} meId={meId} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Таб «Проекты»: поиск + список + создание с конфигурацией (SPEC §4)
// ---------------------------------------------------------------------------

function ProjectsTab({
  company,
  canManage,
  onEntered,
}: {
  company: Company
  canManage: boolean
  onEntered: (projectId: string) => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<ProjectSettings>({ name: '', about: '', chatRules: '', aiConfig: DEFAULT_AI_CONFIG })
  const [rulesModal, setRulesModal] = useState<{ projectId: string; projectName: string; chatRules: string } | null>(null)

  const projectsQ = useQuery({
    queryKey: ['projects', company.id],
    queryFn: () => api<ProjectListItem[]>(`/api/v1/projects?companyId=${company.id}`),
  })

  const filtered = useMemo(() => {
    const list = projectsQ.data ?? []
    const needle = q.trim().toLowerCase()
    return needle ? list.filter((p) => p.name.toLowerCase().includes(needle)) : list
  }, [projectsQ.data, q])

  const createProject = useMutation({
    mutationFn: (v: ProjectSettings) =>
      api<{ id: string }>('/api/v1/projects', {
        method: 'POST',
        body: JSON.stringify({ companyId: company.id, ...v }),
      }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ['projects', company.id] })
      setCreating(false)
      setForm({ name: '', about: '', chatRules: '', aiConfig: DEFAULT_AI_CONFIG })
      enter.mutate({ projectId: p.id, acceptRules: true })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
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
      if (err.status === 428 && err.body?.needRulesAccept) {
        setRulesModal({ projectId: vars.projectId, projectName: err.body.projectName ?? '', chatRules: err.body.chatRules ?? '' })
      } else {
        toast.error(e instanceof Error ? e.message : String(e))
      }
    },
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('start.searchProjects')} className="ps-9" />
        </div>
        {canManage && !creating && (
          <Button variant="brand" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            {t('start.createProject')}
          </Button>
        )}
      </div>

      {/* Создание проекта — полная форма с правилами и конфигом ИИ */}
      {creating && (
        <div className="rounded-xl border bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-bold">{t('projectForm.createTitle')}</h2>
            <Button variant="ghost" size="icon" onClick={() => setCreating(false)}>
              <X className="size-4" />
            </Button>
          </div>
          <ProjectSettingsForm value={form} onChange={setForm} />
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCreating(false)}>
              {t('rules.decline')}
            </Button>
            <Button variant="brand" disabled={!form.name.trim() || createProject.isPending} onClick={() => createProject.mutate(form)}>
              {t('start.create')}
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {projectsQ.isLoading && <p className="text-sm text-muted-foreground">…</p>}
        {filtered.map((p) => (
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
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{p.name}</span>
              <span className="block text-xs text-muted-foreground">
                {p.isMember ? t(`roles.${p.myRole}`) : t('start.notMember')}
              </span>
            </span>
          </button>
        ))}
        {!projectsQ.isLoading && filtered.length === 0 && (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {q ? t('start.nothingFound') : t('start.noProjects')}
          </p>
        )}
      </div>

      {rulesModal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6">
          <div className="w-full max-w-md rounded-xl border bg-card p-6 shadow-xl">
            <h2 className="text-lg font-bold">{t('rules.title', { project: rulesModal.projectName })}</h2>
            <p className="mt-3 whitespace-pre-wrap rounded-md bg-secondary p-3 text-sm">
              {rulesModal.chatRules || t('rules.empty')}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRulesModal(null)}>
                {t('rules.decline')}
              </Button>
              <Button
                variant="brand"
                onClick={() => {
                  enter.mutate({ projectId: rulesModal.projectId, acceptRules: true })
                  setRulesModal(null)
                }}
              >
                {t('rules.accept')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
