import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { CompanyProject, CompanyRole } from '../data'
import { useUi } from '../ui'
import { Icon } from '../Icon'
import { ProjectLogo } from '../ProjectLogo'
import { shortProject } from '../util'
import { PROJECT_LANGUAGES } from '@/lib/languages'
import { Select } from '../ui/Calendar'
import '../i18n/project'
import { coError, useCoRefresh } from './data'

function Shell({ title, icon, onClose, children }: { title: string; icon: string; onClose: () => void; children: React.ReactNode }) {
  const { t } = useTranslation('v2')
  return (
    <div className="mwrap mwrap-top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="mh">
          <span className="rk">
            <Icon name={icon} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h3 style={{ marginTop: 8 }}>{title}</h3>
          </div>
          <button className="ib" aria-label={t('company.close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

/**
 * Новый проект: название, о чём он и на каком языке работает. Остальное —
 * в панели проекта после создания.
 */
export function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation('v2')
  const { companyId, company, flash } = useUi()
  const refresh = useCoRefresh()
  const [name, setName] = useState('')
  const [about, setAbout] = useState('')
  const [lang, setLang] = useState(company.locale ?? 'en')
  const [err, setErr] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>('/api/v1/projects', {
        method: 'POST',
        body: JSON.stringify({ companyId, name: name.trim(), about: about.trim(), aiConfig: { language: lang } }),
      }),
    onSuccess: (p) => {
      refresh()
      flash(t('company.created', { name: name.trim() }))
      onCreated(p.id)
    },
    onError: (e) => setErr(coError(t, e)),
  })
  const ok = name.trim().length > 0 && !create.isPending
  return (
    <Shell title={t('company.npTitle')} icon="plus" onClose={onClose}>
      <input
        className="nin big bidi"
        autoFocus
        value={name}
        maxLength={120}
        onChange={(e) => {
          setName(e.target.value)
          setErr(null)
        }}
        onKeyDown={(e) => e.key === 'Enter' && ok && create.mutate()}
        placeholder={t('company.npName')}
        aria-label={t('company.npName')}
      />
      <textarea
        className="nin psx-ta bidi"
        value={about}
        rows={3}
        maxLength={5000}
        onChange={(e) => setAbout(e.target.value)}
        placeholder={t('proj.descPh')}
        aria-label={t('proj.desc')}
      />
      <div className="psx-row">
        <span className="lbl" style={{ margin: 0 }}>
          {t('proj.lang')}
        </span>
        <Select
          value={lang}
          searchable
          ariaLabel={t('proj.lang')}
          options={PROJECT_LANGUAGES.map((l) => ({ value: l.code, label: l.label, hint: l.english !== l.label ? l.english : undefined }))}
          onChange={setLang}
        />
      </div>
      <div className="mf">
        <div className="res" role={err ? 'alert' : undefined} style={err ? { color: 'var(--signal)' } : undefined}>
          {err ?? t('company.npHint')}
        </div>
        <button className="btn" onClick={onClose}>
          {t('company.cancel')}
        </button>
        <button className={'btn-acc' + (ok ? '' : ' dis')} aria-disabled={!ok} onClick={() => ok && create.mutate()}>
          {t('company.create')}
        </button>
      </div>
    </Shell>
  )
}

/**
 * Приглашение по почте. Роль выбирает только админ: менеджер зовёт
 * участником — назначать менеджеров и админов он не вправе (матрица доступов).
 */
export function InviteModal({ projectId, projects, onClose }: { projectId: string | null; projects: CompanyProject[]; onClose: () => void }) {
  const { t } = useTranslation('v2')
  const { companyId, company, flash } = useUi()
  const refresh = useCoRefresh()
  const admin = company.myRole === 'admin'
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<CompanyRole>('member')
  const [pid, setPid] = useState<string | null>(projectId)
  const [pick, setPick] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const send = useMutation({
    mutationFn: () =>
      api(`/api/v1/companies/${companyId}/invites`, {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), role: admin ? role : 'member', ...(pid ? { projectId: pid } : {}) }),
      }),
    onSuccess: () => {
      refresh()
      flash(t('company.invSent', { email: email.trim() }))
      onClose()
    },
    onError: (e) => setErr(coError(t, e)),
  })
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const ok = valid && !send.isPending
  const cur = pid ? projects.find((p) => p.id === pid) : null
  return (
    <Shell title={t('company.invTitle')} icon="mail" onClose={onClose}>
      <input
        className="nin big"
        type="email"
        dir="ltr"
        autoFocus
        value={email}
        onChange={(e) => {
          setEmail(e.target.value)
          setErr(null)
        }}
        onKeyDown={(e) => e.key === 'Enter' && ok && send.mutate()}
        placeholder="name@example.com"
        aria-label={t('company.invEmail')}
      />
      {admin && (
        <div>
          <div className="lbl">{t('company.invRole')}</div>
          <div className="seg" role="radiogroup" aria-label={t('company.invRole')}>
            {(['member', 'manager', 'admin'] as const).map((r) => (
              <button key={r} className={role === r ? 'on' : ''} role="radio" aria-checked={role === r} onClick={() => setRole(r)}>
                {t(`company.roles.${r}`)}
              </button>
            ))}
          </div>
          <p className="co-hint">{t(`company.roleSub.${role}`)}</p>
        </div>
      )}
      <div>
        <div className="lbl">{t('company.invProject')}</div>
        <div className="cbx">
          <button className="cbx-f" onClick={() => setPick(!pick)} aria-haspopup="listbox" aria-expanded={pick} aria-label={t('company.invProject')}>
            {cur ? <ProjectLogo project={cur} /> : <span className="logo sm" style={{ background: 'var(--soft)' }} />}
            <span className="cbx-n">{cur ? shortProject(cur.name) : t('company.invNoProject')}</span>
            <Icon name="chevron" sm />
          </button>
          {pick && (
            <>
              <div className="cbx-scrim" onClick={() => setPick(false)} />
              <div className="cbx-pop">
                <div className="cbx-l" role="listbox">
                  {[null, ...projects].map((p) => (
                    <button
                      key={p?.id ?? '-'}
                      className="cbx-o"
                      role="option"
                      aria-selected={(p?.id ?? null) === pid}
                      onClick={() => {
                        setPid(p?.id ?? null)
                        setPick(false)
                      }}
                    >
                      {p ? <ProjectLogo project={p} /> : <span className="logo sm" style={{ background: 'var(--soft)' }} />}
                      <span className="cbx-n">{p ? shortProject(p.name) : t('company.invNoProject')}</span>
                      {(p?.id ?? null) === pid && <Icon name="check" sm />}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="mf">
        <div className="res" role={err ? 'alert' : undefined} style={err ? { color: 'var(--signal)' } : undefined}>
          {err ?? t('company.invHint')}
        </div>
        <button className="btn" onClick={onClose}>
          {t('company.cancel')}
        </button>
        <button className={'btn-acc' + (ok ? '' : ' dis')} aria-disabled={!ok} onClick={() => ok && send.mutate()}>
          {t('company.invSend')}
        </button>
      </div>
    </Shell>
  )
}
