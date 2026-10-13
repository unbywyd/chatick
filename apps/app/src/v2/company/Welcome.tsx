import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { PROJECT_LANGUAGES } from '@/lib/languages'
import { useUi } from '../ui'
import { Select } from '../ui/Calendar'
import { errText } from '../settings/parts'
import { useCoRefresh } from './data'
import '../i18n/project'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Первые шаги новой компании: завести проект (с языком — на нём ассистент
 * будет писать задачи) и позвать людей сразу списком. Оба шага можно
 * пропустить — всё это есть и потом, в «Управлении компанией».
 */
export function Welcome() {
  const { t, i18n } = useTranslation('v2')
  const { companyId, company, base } = useUi()
  const navigate = useNavigate()
  const refresh = useCoRefresh()
  const [step, setStep] = useState<1 | 2>(1)
  const [name, setName] = useState('')
  const [lang, setLang] = useState(company.locale ?? i18n.resolvedLanguage ?? 'en')
  const [project, setProject] = useState<{ id: string; name: string } | null>(null)
  const [emails, setEmails] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [sent, setSent] = useState<{ ok: string[]; bad: string[] } | null>(null)

  const create = useMutation({
    mutationFn: () => api<{ id: string }>('/api/v1/projects', { method: 'POST', body: JSON.stringify({ companyId, name: name.trim(), aiConfig: { language: lang } }) }),
    onSuccess: (p) => {
      setProject({ id: p.id, name: name.trim() })
      setErr(null)
      refresh()
      setStep(2)
    },
    onError: (e) => setErr(errText(e, t('proj.failed'))),
  })

  const list = [...new Set(emails.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))]
  const valid = list.filter((x) => EMAIL.test(x))
  const invite = useMutation({
    mutationFn: async () => {
      const ok: string[] = []
      const bad: string[] = list.filter((x) => !EMAIL.test(x))
      for (const email of valid) {
        try {
          await api(`/api/v1/companies/${companyId}/invites`, {
            method: 'POST',
            body: JSON.stringify({ email, role: 'member', ...(project ? { projectId: project.id } : {}) }),
          })
          ok.push(email)
        } catch {
          bad.push(email)
        }
      }
      return { ok, bad }
    },
    onSuccess: (r) => {
      setSent(r)
      refresh()
    },
  })

  const done = () => navigate(base, { replace: true })

  return (
    <div className="wrap wl">
      <div className="wl-card">
        <p className="wl-step">{t('wl.step', { n: step, of: 2 })}</p>
        <h1 className="head bidi">{t('wl.hi', { name: company.name })}</h1>
        {step === 1 && (
          <>
            <p className="sub">{t('wl.projLead')}</p>
            <div className="lbl psx-l">{t('wl.projName')}</div>
            <input
              className="nin big bidi"
              autoFocus
              value={name}
              maxLength={120}
              onChange={(e) => {
                setName(e.target.value)
                setErr(null)
              }}
              onKeyDown={(e) => e.key === 'Enter' && name.trim() && !create.isPending && create.mutate()}
              placeholder={t('wl.projPh')}
            />
            <div className="lbl psx-l">{t('proj.lang')}</div>
            <Select
              value={lang}
              searchable
              ariaLabel={t('proj.lang')}
              options={PROJECT_LANGUAGES.map((l) => ({ value: l.code, label: l.label, hint: l.english !== l.label ? l.english : undefined }))}
              onChange={setLang}
            />
            <p className="co-hint">{t('proj.langHint')}</p>
            {err && (
              <p className="co-hint" role="alert" style={{ color: 'var(--signal)' }}>
                {err}
              </p>
            )}
            <div className="co-foot">
              <button className={'btn-acc' + (name.trim() && !create.isPending ? '' : ' dis')} onClick={() => name.trim() && create.mutate()}>
                {t('wl.next')}
              </button>
              <button className="btn" onClick={() => setStep(2)}>
                {t('wl.skip')}
              </button>
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <p className="sub">{project ? t('wl.inviteLeadProj', { name: project.name }) : t('wl.inviteLead')}</p>
            {!sent ? (
              <>
                <textarea
                  className="nin psx-ta"
                  dir="ltr"
                  autoFocus
                  rows={5}
                  value={emails}
                  onChange={(e) => setEmails(e.target.value)}
                  placeholder={'anna@company.com\nboris@company.com'}
                  aria-label={t('wl.emails')}
                />
                <p className="co-hint">{t('wl.emailsHint', { count: valid.length })}</p>
                <div className="co-foot">
                  <button className={'btn-acc' + (valid.length && !invite.isPending ? '' : ' dis')} onClick={() => valid.length && invite.mutate()}>
                    {invite.isPending ? t('wl.sending') : t('wl.invite', { count: valid.length })}
                  </button>
                  <button className="btn" onClick={done}>
                    {t('wl.later')}
                  </button>
                </div>
              </>
            ) : (
              <>
                {sent.ok.length > 0 && <p className="co-hint" style={{ color: 'var(--ink)' }}>{t('wl.sent', { count: sent.ok.length })}</p>}
                {sent.bad.length > 0 && (
                  <p className="co-hint" style={{ color: 'var(--signal)' }} dir="ltr">
                    {t('wl.failed')} {sent.bad.join(', ')}
                  </p>
                )}
                <div className="co-foot">
                  <button className="btn-acc" onClick={done}>
                    {t('wl.start')}
                  </button>
                  <button className="btn" onClick={() => navigate(`${base}/company`, { replace: true })}>
                    {t('wl.manage')}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
