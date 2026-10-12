import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { CompanyProject } from '../data'
import { useUi } from '../ui'
import { Icon } from '../Icon'
import { ProjectLogo } from '../ProjectLogo'
import { letterOf, personColor, shortProject } from '../util'
import { PersonCombo } from './PersonCombo'
import { coError, isLead, passAll, useCoRefresh, type CoMember, type OpenTask, type TeamRow } from './data'

/**
 * Команда проекта (панель справа, доска CompanyPanel).
 *
 * Ролей в проекте нет — только галочка «Ведёт проект» (админ проекта на
 * сервере). «×» убирает человека; если у него мячи, сначала выбираешь, кому
 * их отдать (доска CompanyRemove). «Проверяющего по умолчанию» и «владельца
 * новых задач» из макета на сервере нет — блока «По умолчанию» здесь нет.
 */
export function TeamPanel({
  project,
  team,
  allTeams,
  members,
  open,
  myId,
  locked,
  onClose,
  onInvite,
}: {
  project: CompanyProject
  team: TeamRow[]
  allTeams: TeamRow[]
  members: CoMember[]
  open: OpenTask[]
  myId: string | undefined
  /** Состав ведётся во внешней системе: добавлять и убирать нельзя, «Ведёт проект» — можно. */
  locked: boolean
  onClose: () => void
  onInvite: (projectId: string) => void
}) {
  const { t } = useTranslation('v2')
  const { flash } = useUi()
  const refresh = useCoRefresh()
  const [rm, setRm] = useState<string | null>(null)
  const [rmTo, setRmTo] = useState<string | null>(null)
  const [addQ, setAddQ] = useState('')
  const [sure, setSure] = useState(false)
  const pj = shortProject(project.name)
  const heldBy = (k: string) => open.filter((x) => x.holderId === k)
  const nameOf = (k: string) => team.find((m) => m.userId === k)?.name ?? ''
  const others = (k: string) => team.filter((m) => m.userId !== k)
  const sorted = [...team].sort((a, b) => Number(isLead(b.role)) - Number(isLead(a.role)) || a.name.localeCompare(b.name))
  const fail = (e: unknown) => flash(coError(t, e))

  const lead = useMutation({
    mutationFn: (v: { userId: string; on: boolean }) =>
      api(`/api/v1/projects/${project.id}/members/${v.userId}/role`, { method: 'PATCH', body: JSON.stringify({ role: v.on ? 'admin' : 'member' }) }),
    onSuccess: (_d, v) => flash(t(v.on ? 'company.leadOn' : 'company.leadOff', { name: nameOf(v.userId), project: pj })),
    onError: fail,
    onSettled: refresh,
  })

  const remove = useMutation({
    mutationFn: async (v: { userId: string; to: string | null }) => {
      const held = heldBy(v.userId)
      if (v.to && held.length) await passAll(held, v.to, t('company.rmNoteText', { name: nameOf(v.userId) }))
      await api(`/api/v1/projects/${project.id}/members/${v.userId}`, { method: 'DELETE' })
      return held.length
    },
    onSuccess: (n, v) => {
      setRm(null)
      flash(
        v.to && n
          ? t('company.passedRemoved', { balls: t('company.ballsN', { count: n }), to: nameOf(v.to), name: nameOf(v.userId), project: pj })
          : t('company.removed', { name: nameOf(v.userId), project: pj }),
      )
    },
    onError: fail,
    onSettled: refresh,
  })

  const add = useMutation({
    mutationFn: (m: CoMember) => api(`/api/v1/projects/${project.id}/members`, { method: 'POST', body: JSON.stringify({ userId: m.user.id, role: 'member' }) }),
    onSuccess: (_d, m) => flash(t('company.added', { name: m.user.name, project: pj })),
    onError: fail,
    onSettled: refresh,
  })

  const archive = useMutation({
    mutationFn: () => api(`/api/v1/projects/${project.id}/archive`, { method: 'POST' }),
    onSuccess: () => {
      flash(t('company.archived', { project: pj }))
      onClose()
    },
    onError: fail,
    onSettled: refresh,
  })

  const askRemove = (k: string) => {
    if (!heldBy(k).length) return remove.mutate({ userId: k, to: null })
    // Первым предлагаем того, кто ведёт проект: обычно мячи уходящего — ему.
    const rest = others(k)
    setRm(k)
    setRmTo((rest.find((m) => isLead(m.role)) ?? rest[0])?.userId ?? null)
  }

  const inTeam = new Set(team.map((m) => m.userId))
  const aq = addQ.trim().toLowerCase()
  const cands = members.filter((m) => !inTeam.has(m.user.id) && (!aq || `${m.user.name} ${m.user.email}`.toLowerCase().includes(aq)))
  const projCount = (uid: string) => new Set(allTeams.filter((m) => m.userId === uid).map((m) => m.projectId)).size
  const rmHeld = rm ? heldBy(rm).length : 0
  const rmPool = rm ? others(rm).map((m) => ({ id: m.userId, name: m.name, email: m.email })) : []
  const busy = remove.isPending

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <section className="panel" aria-label={t('company.teamAria', { name: pj })}>
        <div className="ph">
          <ProjectLogo project={project} />
          <span className="pn">{project.name}</span>
          <span style={{ flex: 1 }} />
          <button className="ib" aria-label={t('company.close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="pb">
          <div className="co-sec">
            <h3>
              {t('company.team')}
              <span className="co-n">{t('company.peopleN', { count: team.length })}</span>
            </h3>
            {sorted.map((m) => {
              const nb = heldBy(m.userId).length
              const on = isLead(m.role)
              const owner = m.role === 'owner'
              return (
                <div className="co-mem" key={m.userId}>
                  <span className="av lg" style={{ background: personColor(m.userId) }}>
                    {letterOf(m.name)}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <b>
                      {m.name}
                      {m.userId === myId ? t('company.you') : ''}
                    </b>
                    <small>{owner ? t('company.creator') : m.email}</small>
                  </span>
                  <span className="co-balls">
                    {nb > 0 && (
                      <>
                        <i />
                        {t('company.ballsN', { count: nb })}
                      </>
                    )}
                  </span>
                  <button
                    className={'co-lead' + (on ? ' on' : '')}
                    aria-pressed={on}
                    disabled={owner || lead.isPending}
                    title={owner ? t('company.creator') : undefined}
                    onClick={() => lead.mutate({ userId: m.userId, on: !on })}
                  >
                    <span className="co-cb">
                      <Icon name="check" sm />
                    </span>
                    {t('company.leads')}
                  </button>
                  {owner || locked ? (
                    <span />
                  ) : (
                    <button
                      className="co-x"
                      aria-label={t('company.removeAria', { name: m.name })}
                      title={t('company.removeAria', { name: m.name })}
                      disabled={busy}
                      onClick={() => askRemove(m.userId)}
                    >
                      <Icon name="close" sm />
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {rm && (
            <div className="co-warn" role="alert">
              <p>
                <span className="bidi">{t('company.rm1', { name: nameOf(rm) })}</span>
                <b>{t('company.ballsN', { count: rmHeld })}</b>
                {t('company.rm2')}
              </p>
              {rmPool.length ? (
                <div className="co-chips">
                  <PersonCombo
                    cur={rmTo}
                    pool={rmPool}
                    onPick={setRmTo}
                    label={(n) => t('company.rmTo', { name: n })}
                    sub={(id) => (isLead(team.find((m) => m.userId === id)?.role ?? 'member') ? t('company.leadsSub') : '')}
                  />
                </div>
              ) : (
                <p style={{ margin: 0 }}>{t('company.rmAlone')}</p>
              )}
              <div className="co-foot">
                {rmPool.length ? (
                  <button className={'btn-acc' + (rmTo && !busy ? '' : ' dis')} aria-disabled={!rmTo || busy} onClick={() => rmTo && remove.mutate({ userId: rm, to: rmTo })}>
                    {busy ? t('company.working') : rmTo ? t('company.rmCta', { name: nameOf(rmTo) }) : t('company.rmPick')}
                  </button>
                ) : (
                  <button className={'btn-acc' + (busy ? ' dis' : '')} onClick={() => remove.mutate({ userId: rm, to: null })}>
                    {t('company.rmPlain')}
                  </button>
                )}
                <button className="btn" onClick={() => setRm(null)}>
                  {t('company.cancel')}
                </button>
              </div>
            </div>
          )}

          {!locked && (
            <div className="co-sec">
              <h3>{t('company.addFrom')}</h3>
              <label className="rsearch" style={{ maxWidth: 'none', minWidth: 0, height: 40 }}>
                <Icon name="search" />
                <input type="search" value={addQ} onChange={(e) => setAddQ(e.target.value)} placeholder={t('company.qPeople')} aria-label={t('company.findPerson')} />
              </label>
              <div style={{ marginTop: 6 }}>
                {cands.slice(0, 30).map((m) => (
                  <div className="co-cand" key={m.user.id}>
                    <span className="av" style={{ background: personColor(m.user.id), width: 28, height: 28, fontSize: 12 }}>
                      {letterOf(m.user.name)}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <b>{m.user.name}</b>
                      <small>{t('company.inProj', { count: projCount(m.user.id) })}</small>
                    </span>
                    <button className="mini" disabled={add.isPending} onClick={() => add.mutate(m)}>
                      {t('company.add')}
                    </button>
                  </div>
                ))}
                {!cands.length && !aq && <p className="co-hint">{t('company.allIn')}</p>}
                {!cands.length && aq && <p className="co-hint">{t('company.noMatch', { q: addQ })}</p>}
              </div>
              <button className="co-link" onClick={() => onInvite(project.id)}>
                <Icon name="mail" sm />
                {t('company.inviteNew')}
              </button>
            </div>
          )}

          <div className="co-sec">
            {sure ? (
              <div className="co-foot" style={{ marginTop: 0 }}>
                <span style={{ fontWeight: 600 }}>{t('company.archiveSure')}</span>
                <button className={'btn-hot' + (archive.isPending ? ' dis' : '')} onClick={() => archive.mutate()}>
                  {t('company.archiveYes')}
                </button>
                <button className="btn" onClick={() => setSure(false)}>
                  {t('company.cancel')}
                </button>
              </div>
            ) : (
              <button className="co-danger" onClick={() => setSure(true)}>
                <Icon name="archive" sm />
                {t('company.archive')}
              </button>
            )}
            <p className="co-hint">{t('company.archiveHint')}</p>
          </div>
        </div>
      </section>
    </>
  )
}
