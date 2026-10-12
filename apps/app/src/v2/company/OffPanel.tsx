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
 * Отключить человека (доска CompanyOff) — только админ компании.
 *
 * Сначала его мячи: по каждому проекту выбираешь, кому их отдать, и они
 * уходят ходом «передать» с запиской. Потом человек убирается из команд всех
 * проектов и из компании. Отдельного «отключён, но числится» на сервере нет:
 * отключение — это удаление из компании, вернуть — пригласить заново.
 */
export function OffPanel({
  person,
  companyId,
  teams,
  open,
  projects,
  onClose,
}: {
  person: CoMember
  companyId: string
  teams: TeamRow[]
  open: OpenTask[]
  projects: CompanyProject[]
  onClose: () => void
}) {
  const { t } = useTranslation('v2')
  const { flash } = useUi()
  const refresh = useCoRefresh()
  const k = person.user.id
  const name = person.user.name
  const [to, setTo] = useState<Record<string, string>>({})

  const held = open.filter((x) => x.holderId === k)
  const pids = [...new Set(held.map((x) => x.projectId))]
  const teamOf = (pid: string) => teams.filter((m) => m.projectId === pid && m.userId !== k)
  // По умолчанию — тот, кто ведёт проект, иначе первый из команды.
  const choice = (pid: string) => to[pid] ?? (teamOf(pid).find((m) => isLead(m.role)) ?? teamOf(pid)[0])?.userId ?? null
  const pjOf = (pid: string) => projects.find((p) => p.id === pid)
  const mine = teams.filter((m) => m.userId === k)
  const owned = mine.filter((m) => m.role === 'owner').map((m) => shortProject(pjOf(m.projectId)?.name ?? ''))
  const total = held.length
  const balls = t('company.ballsN', { count: total })
  const note = t('company.offNoteText', { name })

  const off = useMutation({
    mutationFn: async () => {
      for (const pid of pids) {
        const who = choice(pid)
        if (who) await passAll(held.filter((x) => x.projectId === pid), who, note)
      }
      // Создателя проекта сервер из команды не убирает — его пропускаем.
      for (const m of mine) if (m.role !== 'owner') await api(`/api/v1/projects/${m.projectId}/members/${k}`, { method: 'DELETE' })
      await api(`/api/v1/companies/${companyId}/members/${k}`, { method: 'DELETE' })
    },
    onSuccess: () => {
      flash(total ? t('company.offDoneBalls', { name, balls }) : t('company.offDone', { name }))
      onClose()
    },
    onError: (e) => flash(coError(t, e)),
    onSettled: refresh,
  })

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <section className="panel" aria-label={t('company.offAria')}>
        <div className="ph">
          <span className="av" style={{ background: personColor(k) }}>
            {letterOf(name)}
          </span>
          <span className="pn">{person.user.email}</span>
          <span style={{ flex: 1 }} />
          <button className="ib" aria-label={t('company.close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="pb">
          <div>
            <h2 className="pt bidi">{t('company.offTitle', { name })}</h2>
            <p className="co-hint" style={{ fontSize: 15, color: 'var(--ink2)' }}>
              {t('company.offHint')}
            </p>
          </div>
          <div className="co-sec">
            <h3>
              {total ? t('company.holding', { balls }) : t('company.noHeld')}
              {total > 0 && <span className="co-n">{t('company.holdingSub')}</span>}
            </h3>
            {pids.map((pid) => {
              const pj = pjOf(pid)
              const list = held.filter((x) => x.projectId === pid)
              const pool = teamOf(pid).map((m) => ({ id: m.userId, name: m.name, email: m.email }))
              return (
                <div className="co-bg" key={pid}>
                  <div className="co-bgh">
                    <ProjectLogo project={pj ?? { id: pid, name: '?', color: null }} />
                    <b>{pj ? shortProject(pj.name) : '—'}</b>
                    <small>{t('company.ballsN', { count: list.length })}</small>
                  </div>
                  <div className="co-bgt" title={list.map((x) => `${x.number} · ${x.title}`).join('\n')}>
                    {list.map((x) => `${x.number} · ${x.title}`).join('  ·  ')}
                  </div>
                  {pool.length ? (
                    <PersonCombo
                      cur={choice(pid)}
                      pool={pool}
                      onPick={(id) => setTo({ ...to, [pid]: id })}
                      label={(n) => t('company.rmTo', { name: n })}
                      sub={(id) => (isLead(teams.find((m) => m.projectId === pid && m.userId === id)?.role ?? 'member') ? t('company.leadsSub') : '')}
                    />
                  ) : (
                    <p className="co-hint" style={{ margin: 0 }}>
                      {t('company.rmAlone')}
                    </p>
                  )}
                </div>
              )
            })}
            {total > 0 && <p className="co-hint">{t('company.offNoteHint', { note })}</p>}
            {owned.length > 0 && <p className="co-hint">{t('company.offOwner', { projects: owned.join(', ') })}</p>}
          </div>
          <div className="co-foot" style={{ marginTop: 0 }}>
            <button className={'btn-hot' + (off.isPending ? ' dis' : '')} aria-disabled={off.isPending} onClick={() => off.mutate()}>
              {off.isPending ? t('company.working') : total ? t('company.offCta', { balls }) : t('company.offPlain')}
            </button>
            <button className="btn" onClick={onClose}>
              {t('company.cancel')}
            </button>
          </div>
        </div>
      </section>
    </>
  )
}
