import { useMemo, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { keys, useMe, useProjects, type CompanyProject, type CompanyRole } from '../data'
import { useUi } from '../ui'
import { Icon } from '../Icon'
import { ProjectLogo } from '../ProjectLogo'
import { firstName, heatOf, letterOf, personColor, shortProject } from '../util'
import { PersonCombo } from './PersonCombo'
import { TeamPanel } from './TeamPanel'
import { OffPanel } from './OffPanel'
import { InviteModal, NewProjectModal } from './Modals'
import { clientOf, coError, isLead, useCoMembers, useCoRefresh, useInvites, useTeams, type CoMember, type OpenTask } from './data'
import '../i18n/company'
import '../styles/company.css'

type Tab = 'proj' | 'people' | 'access'
const ROLE_RANK: Record<CompanyRole, number> = { admin: 0, manager: 1, member: 2 }

/**
 * Управление компанией (меню компании → «Управление компанией»).
 *
 * Видят админы и менеджеры; участника отправляем на главный экран — сервер
 * ему всё равно ничего отсюда не отдаст. Вкладка живёт в адресе
 * (/company, /company/people, /company/access), чтобы «назад» работал.
 */
export function CompanyView() {
  const { company, base } = useUi()
  if (company.myRole !== 'admin' && company.myRole !== 'manager') return <Navigate to={base} replace />
  return <Company />
}

function Company() {
  const { t, i18n } = useTranslation('v2')
  const rtl = i18n.dir() === 'rtl'
  const { companyId, company, base, flash } = useUi()
  const navigate = useNavigate()
  const sub = useParams()['*'] ?? ''
  const tab: Tab = sub.startsWith('people') ? 'people' : sub.startsWith('access') ? 'access' : 'proj'
  const admin = company.myRole === 'admin'
  const me = useMe()
  const myId = me.data?.id
  const projectsQ = useProjects(companyId)
  const membersQ = useCoMembers(companyId)
  const teamsQ = useTeams(companyId)
  const invitesQ = useInvites(companyId)
  const refresh = useCoRefresh()
  const qc = useQueryClient()
  // Архив — отдельным запросом: в общий список проектов законченные не попадают.
  const archivedQ = useQuery({
    queryKey: ['v2', 'archived', companyId],
    queryFn: () => api<CompanyProject[] | { projects: CompanyProject[] }>(`/api/v1/projects?companyId=${encodeURIComponent(companyId)}&archived=1`).then((r) => (Array.isArray(r) ? r : r.projects)),
  })
  const archived = archivedQ.data ?? []
  const unarchive = useMutation({
    mutationFn: (p: CompanyProject) => api(`/api/v1/projects/${p.id}/archive`, { method: 'DELETE' }),
    onSuccess: (_d, p) => flash(t('proj.unarchived', { name: shortProject(p.name) })),
    onError: (e) => flash(coError(t, e)),
    onSettled: () => {
      refresh()
      void qc.invalidateQueries({ queryKey: ['v2', 'archived', companyId] })
      void qc.invalidateQueries({ queryKey: keys.projects(companyId) })
    },
  })
  const [q, setQ] = useState('')
  const [f, setF] = useState('all')
  const [sel, setSel] = useState<string | null>(null)
  const [offId, setOffId] = useState<string | null>(null)
  const [roleMenu, setRoleMenu] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [invite, setInvite] = useState<{ projectId: string | null } | null>(null)

  const projects = useMemo(() => [...(projectsQ.data ?? [])].sort((a, b) => shortProject(a.name).localeCompare(shortProject(b.name))), [projectsQ.data])
  const members = useMemo(
    () => [...(membersQ.data ?? [])].sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.user.name.localeCompare(b.user.name)),
    [membersQ.data],
  )
  const teamRows = teamsQ.data?.members ?? []
  const open = teamsQ.data?.open ?? []
  const invites = invitesQ.data ?? []
  // Состав и/или проекты ведутся во внешней системе: кнопки, которые сервер
  // отклонит, не показываем вовсе.
  const ext = teamsQ.data?.external
  const lockedPeople = Boolean(ext?.members)
  const extName = ext?.name || t('company.extDefault')
  const byProject = useMemo(() => group(teamRows, (m) => m.projectId), [teamRows])
  const openBy = useMemo(() => group(open, (x) => x.projectId), [open])
  const heldBy = useMemo(() => group(open.filter((x) => x.holderId), (x) => x.holderId!), [open])

  const pickTab = (k: Tab) => {
    setQ('')
    setF('all')
    setSel(null)
    setRoleMenu(null)
    navigate(`${base}/company${k === 'proj' ? '' : '/' + k}`)
  }

  const setRole = useMutation({
    mutationFn: (v: { m: CoMember; role: CompanyRole }) =>
      api(`/api/v1/companies/${companyId}/members/${v.m.user.id}`, { method: 'PATCH', body: JSON.stringify({ role: v.role }) }),
    onSuccess: (_d, v) => flash(t('company.roleDone', { name: v.m.user.name, role: t(`company.roles.${v.role}`) })),
    onError: (e) => flash(coError(t, e)),
    onSettled: () => {
      refresh()
      setRoleMenu(null)
    },
  })
  const inviteAct = useMutation({
    mutationFn: (v: { id: string; act: 'resend' | 'revoke' }) =>
      api(`/api/v1/companies/${companyId}/invites/${v.id}${v.act === 'resend' ? '/resend' : ''}`, { method: v.act === 'resend' ? 'POST' : 'DELETE' }),
    onSuccess: (_d, v) => flash(t(v.act === 'resend' ? 'company.resent' : 'company.revoked')),
    onError: (e) => flash(coError(t, e)),
    onSettled: refresh,
  })

  const s = q.trim().toLowerCase()
  const gapLead = projects.filter((p) => !(byProject.get(p.id) ?? []).some((m) => isLead(m.role))).length
  const staff = members.filter((m) => m.role !== 'member').length

  const tabs: [Tab, string, number | ''][] = [
    ['proj', t('company.tabs.proj'), projects.length],
    ['people', t('company.tabs.people'), members.length],
    ['access', t('company.tabs.access'), ''],
  ]
  const filters: [string, string, number, string][] =
    tab === 'proj'
      ? [
          ['all', t('company.f.all'), projects.length, ''],
          ['lead', t('company.f.lead'), gapLead, 'var(--signal)'],
          ...(archived.length ? ([['archive', t('proj.archive'), archived.length, '']] as [string, string, number, string][]) : []),
        ]
      : tab === 'people'
        ? [
            ['all', t('company.f.all'), members.length, ''],
            ['admin', t('company.f.admin'), staff, ''],
            ['invited', t('company.f.invited'), invites.length, ''],
          ]
        : []

  const headSub =
    tab === 'proj'
      ? `${t('company.projN', { count: projects.length })}, ${t('company.peopleN', { count: members.length })}. ${gapLead ? t('company.gapLead', { count: gapLead }) : ''}`
      : t(`company.sub.${tab}`)

  const loading = projectsQ.isLoading || membersQ.isLoading || teamsQ.isLoading
  // Панели живут на своей вкладке: при смене вкладки по адресу они закрываются.
  const selProject = sel && tab === 'proj' ? projects.find((p) => p.id === sel) : null
  const offPerson = offId && tab === 'people' ? members.find((m) => m.user.id === offId) : null

  return (
    <>
      <div className="wrap">
        <div className="rh">
          <div>
            <h1 className="head bidi">{company.name}</h1>
            <p className="sub">{headSub}</p>
          </div>
          <div className="rh-a">
            {tab === 'proj' && !ext?.projects && (
              <button className="btn-moss" onClick={() => setNewOpen(true)}>
                <Icon name="plus" />
                {t('company.newProject')}
              </button>
            )}
            {tab === 'people' && !lockedPeople && (
              <button className="btn-moss" onClick={() => setInvite({ projectId: null })}>
                <Icon name="mail" />
                {t('company.invite')}
              </button>
            )}
          </div>
        </div>
        <div className="co-bar">
          <div className="seg" role="tablist" aria-label={t('company.tabsAria')}>
            {tabs.map(([k, label, n]) => (
              <button key={k} className={tab === k ? 'on' : ''} role="tab" aria-selected={tab === k} onClick={() => pickTab(k)}>
                {label}
                <span className="n">{n}</span>
              </button>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          {tab !== 'access' && (
            <label className="rsearch" style={{ maxWidth: 280, minWidth: 200 }}>
              <Icon name="search" />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={tab === 'people' ? t('company.qPeople') : t('company.qProj')}
                aria-label={tab === 'people' ? t('company.qPeople') : t('company.qProj')}
              />
            </label>
          )}
          {filters.map(([k, label, n, dot]) => (
            <button key={k} className={'fx' + (f === k ? ' on' : '')} aria-pressed={f === k} onClick={() => setF(k)}>
              {dot && <i style={{ background: dot }} />}
              {label}
              <span className="n">{n}</span>
            </button>
          ))}
        </div>

        {lockedPeople && tab !== 'access' && <p className="co-hint" style={{ margin: '-4px 0 12px' }}>{t('company.lockedHint', { name: extName })}</p>}

        {loading && <div className="none">…</div>}

        {!loading && tab === 'proj' && f === 'archive' && (
          <div className="co-tbl">
            {archived
              .filter((p) => !s || p.name.toLowerCase().includes(s))
              .map((p) => (
                <div key={p.id} className="co-prow co-arch">
                  <span className="co-pj">
                    <ProjectLogo project={p} size="md" />
                    <span>
                      <b>{shortProject(p.name)}</b>
                      <small>{clientOf(p.name)}</small>
                    </span>
                  </span>
                  <span className="co-pa">
                    <button className="mini" disabled={unarchive.isPending} onClick={() => unarchive.mutate(p)}>
                      {t('proj.unarchive')}
                    </button>
                  </span>
                </div>
              ))}
          </div>
        )}

        {!loading && tab === 'proj' && f !== 'archive' && (
          <div className="co-tbl">
            <div className="co-hrow">
              <span>{t('company.col.project')}</span>
              <span>{t('company.col.leads')}</span>
              <span>{t('company.col.team')}</span>
              <span>{t('company.col.tasks')}</span>
              <span />
            </div>
            {(() => {
              const rows = projects.filter((p) => {
                const team = byProject.get(p.id) ?? []
                if (f === 'lead' && team.some((m) => isLead(m.role))) return false
                if (s && !`${p.name} ${team.map((m) => m.name).join(' ')}`.toLowerCase().includes(s)) return false
                return true
              })
              if (!rows.length) return <div className="none">{t('company.none')}</div>
              return rows.map((p) => {
                const team = [...(byProject.get(p.id) ?? [])].sort((a, b) => Number(isLead(b.role)) - Number(isLead(a.role)))
                const leads = team.filter((m) => isLead(m.role))
                const tasks = openBy.get(p.id) ?? []
                const long = tasks.filter((x) => x.holderId && heatOf(x.move, x.heldSince) === 'burn').length
                const short = shortProject(p.name)
                return (
                  <button key={p.id} className={'co-row' + (sel === p.id ? ' sel' : '')} onClick={() => setSel(p.id)} aria-label={t('company.teamAria', { name: short })}>
                    <span className="co-pj">
                      <ProjectLogo project={p} size="md" />
                      <span>
                        <b>{short}</b>
                        <small>{clientOf(p.name)}</small>
                      </span>
                    </span>
                    <span className="co-leads">
                      {leads.slice(0, 2).map((m) => (
                        <span className="co-who" key={m.userId}>
                          <span className="av" style={{ background: personColor(m.userId) }}>
                            {letterOf(m.name)}
                          </span>
                          <span className="bidi">{firstName(m.name)}</span>
                        </span>
                      ))}
                      {leads.length > 2 && <span className="co-more">+{leads.length - 2}</span>}
                      {!leads.length && <span className="co-gap bad">{t('company.noLead')}</span>}
                    </span>
                    <span className="co-stack">
                      {team.slice(0, 5).map((m) => (
                        <span key={m.userId} className="av" style={{ background: personColor(m.userId) }} title={m.name}>
                          {letterOf(m.name)}
                        </span>
                      ))}
                      <span className="co-more">{team.length > 5 ? `+${team.length - 5}` : ''}</span>
                    </span>
                    <span className="co-num">
                      {tasks.length}
                      {long > 0 ? <small className="long">{t('company.long', { count: long })}</small> : <small>{t('company.open')}</small>}
                    </span>
                    <span className="co-chev" style={{ display: 'grid' }}>
                      <Icon name={rtl ? 'chevronStart' : 'chevronEnd'} sm />
                    </span>
                  </button>
                )
              })
            })()}
          </div>
        )}

        {!loading && tab === 'people' && (
          <div className="co-tbl">
            <div className="co-phrow">
              <span>{t('company.col.person')}</span>
              <span>{t('company.col.role')}</span>
              <span>{t('company.col.projects')}</span>
              <span>{t('company.col.balls')}</span>
              <span />
            </div>
            {f === 'invited'
              ? (() => {
                  const list = invites.filter((x) => !s || x.email.toLowerCase().includes(s))
                  if (!list.length) return <div className="none">{t('company.none')}</div>
                  return list.map((x) => {
                    const pj = x.projectId ? projects.find((p) => p.id === x.projectId) : null
                    return (
                      <div className="co-prow" key={x.id}>
                        <span className="co-pj">
                          <span className="av lg" style={{ background: 'var(--soft)', color: 'var(--ink3)' }}>
                            {letterOf(x.email)}
                          </span>
                          <span>
                            <b>{x.email}</b>
                            <small>{t('company.invited')}</small>
                          </span>
                        </span>
                        <span>
                          <span className={'co-badge ' + x.role}>{t(`company.roles.${x.role}`)}</span>
                        </span>
                        <span className="co-logos">{pj ? <ProjectLogo project={pj} title={shortProject(pj.name)} /> : <span className="co-more" style={{ margin: 0 }}>—</span>}</span>
                        <span />
                        <span className="co-pa">
                          <button className="mini" disabled={inviteAct.isPending} onClick={() => inviteAct.mutate({ id: x.id, act: 'resend' })}>
                            {t('company.resend')}
                          </button>
                          <button className="mini" disabled={inviteAct.isPending} onClick={() => inviteAct.mutate({ id: x.id, act: 'revoke' })}>
                            {t('company.revoke')}
                          </button>
                        </span>
                      </div>
                    )
                  })
                })()
              : (() => {
                  const list = members.filter((m) => {
                    if (f === 'admin' && m.role === 'member') return false
                    if (s && !`${m.user.name} ${m.user.email}`.toLowerCase().includes(s)) return false
                    return true
                  })
                  if (!list.length) return <div className="none">{t('company.none')}</div>
                  return list.map((m) => (
                    <PersonRow
                      key={m.id}
                      m={m}
                      me={m.user.id === myId}
                      canOff={admin && !lockedPeople}
                      admin={admin}
                      projects={projects.filter((p) => (byProject.get(p.id) ?? []).some((x) => x.userId === m.user.id))}
                      held={heldBy.get(m.user.id) ?? []}
                      menuOpen={roleMenu === m.user.id}
                      onMenu={(v) => setRoleMenu(v ? m.user.id : null)}
                      onRole={(role) => setRole.mutate({ m, role })}
                      onOff={() => setOffId(m.user.id)}
                    />
                  ))
                })()}
          </div>
        )}

        {!loading && tab === 'access' && (
          <Access members={members} myId={myId} admin={admin} onMakeAdmin={(m) => setRole.mutate({ m, role: 'admin' })} />
        )}
      </div>

      {selProject && (
        <TeamPanel
          key={selProject.id}
          project={selProject}
          team={byProject.get(selProject.id) ?? []}
          allTeams={teamRows}
          members={members}
          open={openBy.get(selProject.id) ?? []}
          myId={myId}
          locked={lockedPeople}
          onClose={() => setSel(null)}
          onInvite={(pid) => setInvite({ projectId: pid })}
        />
      )}
      {offPerson && <OffPanel key={offPerson.id} person={offPerson} companyId={companyId} teams={teamRows} open={open} projects={projects} onClose={() => setOffId(null)} />}
      {newOpen && (
        <NewProjectModal
          onClose={() => setNewOpen(false)}
          onCreated={(id) => {
            setNewOpen(false)
            setSel(id)
          }}
        />
      )}
      {invite && <InviteModal projectId={invite.projectId} projects={projects} onClose={() => setInvite(null)} />}
    </>
  )
}

function PersonRow({
  m,
  me,
  canOff,
  admin,
  projects,
  held,
  menuOpen,
  onMenu,
  onRole,
  onOff,
}: {
  m: CoMember
  me: boolean
  canOff: boolean
  admin: boolean
  projects: { id: string; name: string; color: string | null; logoUrl: string | null }[]
  held: OpenTask[]
  menuOpen: boolean
  onMenu: (open: boolean) => void
  onRole: (r: CompanyRole) => void
  onOff: () => void
}) {
  const { t } = useTranslation('v2')
  const role = t(`company.roles.${m.role}`)
  return (
    <div className="co-prow">
      <span className="co-pj">
        <span className="av lg" style={{ background: personColor(m.user.id) }}>
          {letterOf(m.user.name)}
        </span>
        <span>
          <b>
            {m.user.name}
            {me ? t('company.you') : ''}
          </b>
          <small>{m.user.email}</small>
        </span>
      </span>
      <span style={{ position: 'relative' }}>
        {/* Роль меняет только админ компании (сервер так же решает). */}
        {admin ? (
          <button className={'co-badge co-rolebtn ' + m.role} aria-haspopup="menu" aria-expanded={menuOpen} aria-label={t('company.roleAria', { name: m.user.name, role })} onClick={() => onMenu(!menuOpen)}>
            {role}
            <Icon name="chevron" sm />
          </button>
        ) : (
          <span className={'co-badge ' + m.role}>{role}</span>
        )}
        {menuOpen && (
          <>
            <div className="cbx-scrim" onClick={() => onMenu(false)} />
            <div className="co-rmenu co-rmenu-role" role="menu">
              {(['admin', 'manager', 'member'] as const).map((r) => (
                <button key={r} className="co-ri" role="menuitemradio" aria-checked={m.role === r} onClick={() => (m.role === r ? onMenu(false) : onRole(r))}>
                  <span>
                    <b>{t(`company.roles.${r}`)}</b>
                    <small>{t(`company.roleSub.${r}`)}</small>
                  </span>
                  {m.role === r && <Icon name="check" sm />}
                </button>
              ))}
            </div>
          </>
        )}
      </span>
      <span className="co-logos">
        {projects.slice(0, 8).map((p) => (
          <ProjectLogo key={p.id} project={p} title={shortProject(p.name)} />
        ))}
        {projects.length > 8 && (
          <span className="co-more" style={{ marginInlineStart: 2 }} title={projects.slice(8).map((p) => shortProject(p.name)).join(', ')}>
            +{projects.length - 8}
          </span>
        )}
        {!projects.length && (
          <span className="co-more" style={{ margin: 0 }}>
            —
          </span>
        )}
      </span>
      <span className="co-balls">
        {held.length > 0 && <i />}
        {held.length ? t('company.ballsN', { count: held.length }) : t('company.noBalls')}
      </span>
      <span className="co-pa">
        {canOff && !me && (
          <button className="mini" onClick={onOff}>
            {t('company.off')}
          </button>
        )}
      </span>
    </div>
  )
}

function Access({ members, myId, admin, onMakeAdmin }: { members: CoMember[]; myId: string | undefined; admin: boolean; onMakeAdmin: (m: CoMember) => void }) {
  const { t } = useTranslation('v2')
  const admins = members.filter((m) => m.role === 'admin')
  const rest = members.filter((m) => m.role !== 'admin')
  const matrix = t('company.matrix', { returnObjects: true }) as unknown as string[][]
  const cell = (c: string) =>
    c === 'y' ? (
      <span className="y" aria-label={t('company.yes')}>
        ✓
      </span>
    ) : c === 'n' ? (
      <span className="n" aria-label={t('company.no')}>
        —
      </span>
    ) : (
      <span className="p">{c}</span>
    )
  return (
    <>
      <div className="co-adm">
        {admins.map((m) => (
          <div className="co-ac" key={m.id}>
            <span className="av lg" style={{ background: personColor(m.user.id) }}>
              {letterOf(m.user.name)}
            </span>
            <span style={{ minWidth: 0 }}>
              <b className="bidi">
                {m.user.name}
                {m.user.id === myId ? t('company.you') : ''}
              </b>
              <small>{m.user.email}</small>
            </span>
            <span className="co-badge admin">{t('company.roles.admin')}</span>
          </div>
        ))}
        {admin && rest.length > 0 && (
          <PersonCombo
            cur={null}
            pool={rest.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email }))}
            sub={(id) => t(`company.roles.${rest.find((m) => m.user.id === id)?.role ?? 'member'}`)}
            label={() => t('company.makeAdmin')}
            onPick={(id) => {
              const m = rest.find((x) => x.user.id === id)
              if (m) onMakeAdmin(m)
            }}
            trigger={(toggle, expanded) => (
              <button className="co-ac add" style={{ width: '100%', height: '100%' }} aria-haspopup="listbox" aria-expanded={expanded} onClick={toggle}>
                <Icon name="plus" sm />
                {t('company.makeAdmin')}
              </button>
            )}
          />
        )}
      </div>
      <div className="co-tbl" style={{ padding: '4px 6px 6px' }}>
        <table className="co-mx" aria-label={t('company.matrixAria')}>
          <thead>
            <tr>
              <th>{t('company.perm')}</th>
              <th className={admin ? 'co-me' : ''}>{t('company.roles.admin')}</th>
              <th className={!admin ? 'co-me' : ''}>{t('company.roles.manager')}</th>
              <th>{t('company.roles.member')}</th>
            </tr>
          </thead>
          <tbody>
            {matrix.map((r) => (
              <tr key={r[0]}>
                <td>
                  {r[0]}
                  {r[1] && <small>{r[1]}</small>}
                </td>
                <td>{cell(r[2]!)}</td>
                <td>{cell(r[3]!)}</td>
                <td>{cell(r[4]!)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="co-hint">{t('company.accessHint')}</p>
    </>
  )
}

function group<T>(list: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const x of list) {
    const k = key(x)
    const arr = m.get(k)
    if (arr) arr.push(x)
    else m.set(k, [x])
  }
  return m
}

