import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { keys } from '../data'
import { useUi } from '../ui'
import { Select } from '../ui/Calendar'
import { Sw, useFail } from './parts'
import '../i18n/project'

/**
 * Разделы настроек компании, которых не было в первой сборке v2: язык,
 * учёт времени, внешняя система, ИИ при создании задач, удаление компании.
 */

const LOCALES = [
  { value: 'ru', label: 'Русский' },
  { value: 'en', label: 'English' },
  { value: 'he', label: 'עברית' },
]

/** Язык компании: письма приглашённым и язык новых проектов. */
export function CompanyLocaleRow() {
  const { t } = useTranslation('v2')
  const { company, companyId, flash } = useUi()
  const qc = useQueryClient()
  const fail = useFail()
  const save = useMutation({
    mutationFn: (locale: string) => api(`/api/v1/companies/${companyId}`, { method: 'PATCH', body: JSON.stringify({ locale }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.companies })
      flash(t('settings.saved'))
    },
    onError: fail,
  })
  return (
    <div className="row">
      <span className="l">
        {t('coset.lang')}
        <small>{t('coset.langHint')}</small>
      </span>
      <div className="inl">
        <Select value={company.locale ?? 'en'} options={LOCALES} ariaLabel={t('coset.lang')} onChange={(v) => save.mutate(v)} />
      </div>
    </div>
  )
}

type TimeCfg = { timezone: string; weekStart: number; workDayStart: number; workDayEnd: number; idleAction: 'remind' | 'stop'; idleHours: number }

/** Учёт времени: часовой пояс, начало недели, рабочий день, забытый таймер. Таймер всегда один. */
export function CompanyTime() {
  const { t, i18n } = useTranslation('v2')
  const { companyId, flash } = useUi()
  const qc = useQueryClient()
  const fail = useFail()
  const key = ['v2', 'co-time-config', companyId]
  const q = useQuery({ queryKey: key, queryFn: () => api<{ config: TimeCfg }>(`/api/v1/companies/${companyId}/time-config`) })
  const save = useMutation({
    mutationFn: (b: Partial<TimeCfg>) => api(`/api/v1/companies/${companyId}/time-config`, { method: 'PATCH', body: JSON.stringify(b) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key })
      flash(t('settings.saved'))
    },
    onError: fail,
  })
  const c = q.data?.config
  if (!c) return null
  const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [c.timezone]
  const zoneOpts = (zones.includes(c.timezone) ? zones : [c.timezone, ...zones]).map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))
  const hour = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  const hours = Array.from({ length: 25 }, (_, h) => ({ value: String(h * 60), label: hour(h * 60) }))
  // 4 января 1970 — воскресенье: отсюда названия дней на языке интерфейса.
  const day = (d: number) => new Date(Date.UTC(1970, 0, 4 + d)).toLocaleDateString(i18n.language, { weekday: 'long', timeZone: 'UTC' })
  return (
    <section className="card sec">
      <h2>
        {t('coset.time')} <small>{t('settings.adminOnly')}</small>
      </h2>
      <p className="d">{t('coset.timeSub')}</p>
      <div className="row first">
        <span className="l">{t('coset.tz')}</span>
        <div className="inl">
          <Select value={c.timezone} searchable options={zoneOpts} ariaLabel={t('coset.tz')} onChange={(v) => save.mutate({ timezone: v })} />
        </div>
      </div>
      <div className="row">
        <span className="l">{t('coset.week')}</span>
        <div className="radio">
          {[1, 0, 6].map((d) => (
            <button key={d} className={c.weekStart === d ? 'on' : ''} aria-pressed={c.weekStart === d} onClick={() => save.mutate({ weekStart: d })}>
              {day(d)}
            </button>
          ))}
        </div>
      </div>
      <div className="row">
        <span className="l">
          {t('coset.workday')}
          <small>{t('coset.workdayHint')}</small>
        </span>
        <div className="inl">
          <Select value={String(c.workDayStart)} options={hours.slice(0, 24)} ariaLabel={t('coset.from')} onChange={(v) => save.mutate({ workDayStart: Number(v) })} />
          <span className="hint">—</span>
          <Select value={String(c.workDayEnd)} options={hours.slice(1)} ariaLabel={t('coset.to')} onChange={(v) => save.mutate({ workDayEnd: Number(v) })} />
        </div>
      </div>
      <div className="row">
        <span className="l">
          {t('coset.idle')}
          <small>{t('coset.idleHint')}</small>
        </span>
        <div className="inl">
          <div className="radio">
            {(['remind', 'stop'] as const).map((a) => (
              <button key={a} className={c.idleAction === a ? 'on' : ''} aria-pressed={c.idleAction === a} onClick={() => save.mutate({ idleAction: a })}>
                {t(`coset.idleAct.${a}`)}
              </button>
            ))}
          </div>
          <Select
            value={String(c.idleHours)}
            options={[1, 2, 3, 4, 6, 8, 10, 12, 16, 24].map((h) => ({ value: String(h), label: t('coset.afterH', { count: h }) }))}
            ariaLabel={t('coset.idle')}
            onChange={(v) => save.mutate({ idleHours: Number(v) })}
          />
        </div>
      </div>
    </section>
  )
}

/** Связь с внешней системой: как называется, где открыть проект, что ведётся только там. */
export function CompanyIntegration() {
  const { t } = useTranslation('v2')
  const { company, companyId, flash } = useUi()
  const qc = useQueryClient()
  const fail = useFail()
  const [name, setName] = useState(company.externalSystemName ?? '')
  const [url, setUrl] = useState(company.externalProjectUrl ?? '')
  useEffect(() => {
    setName(company.externalSystemName ?? '')
    setUrl(company.externalProjectUrl ?? '')
  }, [company.externalSystemName, company.externalProjectUrl])
  const save = useMutation({
    mutationFn: (b: Record<string, unknown>) => api(`/api/v1/companies/${companyId}/integration`, { method: 'PATCH', body: JSON.stringify(b) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.companies })
      void qc.invalidateQueries({ queryKey: ['v2', 'co'] })
      flash(t('settings.saved'))
    },
    onError: fail,
  })
  const dirty = name.trim() !== (company.externalSystemName ?? '') || url.trim() !== (company.externalProjectUrl ?? '')
  const badUrl = Boolean(url.trim()) && !url.includes('{externalId}')
  return (
    <section className="card sec">
      <h2>
        {t('coset.ext')} <small>{t('settings.adminOnly')}</small>
      </h2>
      <p className="d">{t('coset.extSub')}</p>
      <div className="row first">
        <span className="l">{t('coset.extName')}</span>
        <label className="f" style={{ width: 320 }}>
          <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Atlas, CRM…" aria-label={t('coset.extName')} />
        </label>
      </div>
      <div className="row">
        <span className="l">
          {t('coset.extUrl')}
          <small>{t('coset.extUrlHint')}</small>
        </span>
        <label className="f mono" style={{ width: 420 }}>
          <input value={url} maxLength={500} onChange={(e) => setUrl(e.target.value)} placeholder="https://crm.example.com/projects/{externalId}" dir="ltr" aria-label={t('coset.extUrl')} />
        </label>
      </div>
      {dirty && (
        <div className="row">
          <span className="l" />
          <div className="inl">
            <button
              className="btn sm pr"
              disabled={badUrl || save.isPending}
              onClick={() => save.mutate({ externalSystemName: name.trim() || null, externalProjectUrl: url.trim() || null })}
            >
              {t('settings.save')}
            </button>
            {badUrl && <span className="hint" style={{ color: 'var(--signal)' }}>{t('coset.extUrlBad')}</span>}
          </div>
        </div>
      )}
      <div className="row">
        <span className="l">{t('coset.extProjects')}</span>
        <div className="inl">
          <Sw on={Boolean(company.projectsViaApiOnly)} label={t('coset.extProjects')} disabled={save.isPending} onChange={(v) => save.mutate({ projectsViaApiOnly: v })} />
          <span className="hint">{t('coset.extProjectsHint')}</span>
        </div>
      </div>
      <div className="row">
        <span className="l">{t('coset.extMembers')}</span>
        <div className="inl">
          <Sw on={Boolean(company.membersViaApiOnly)} label={t('coset.extMembers')} disabled={save.isPending} onChange={(v) => save.mutate({ membersViaApiOnly: v })} />
          <span className="hint">{t('coset.extMembersHint')}</span>
        </div>
      </div>
    </section>
  )
}

/** ИИ при создании задачи: улучшать формулировку и дописывать заметки. Для всей компании. */
export function TaskAiRows() {
  const { t } = useTranslation('v2')
  const { companyId } = useUi()
  const qc = useQueryClient()
  const fail = useFail()
  const key = ['v2', 'co-ai-tasks', companyId]
  const q = useQuery({ queryKey: key, queryFn: () => api<{ improveTasks: boolean; generateTaskNotes: boolean }>(`/api/v1/companies/${companyId}/ai-tasks`) })
  const save = useMutation({
    mutationFn: (b: { improveTasks?: boolean; generateTaskNotes?: boolean }) => api(`/api/v1/companies/${companyId}/ai-tasks`, { method: 'PATCH', body: JSON.stringify(b) }),
    onError: fail,
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  })
  if (!q.data) return null
  return (
    <>
      <div className="row">
        <span className="l">
          {t('coset.improve')}
          <small>{t('coset.improveHint')}</small>
        </span>
        <div className="inl">
          <Sw on={q.data.improveTasks} label={t('coset.improve')} disabled={save.isPending} onChange={(v) => save.mutate({ improveTasks: v })} />
        </div>
      </div>
      <div className="row">
        <span className="l">
          {t('coset.notes')}
          <small>{t('coset.notesHint')}</small>
        </span>
        <div className="inl">
          <Sw on={q.data.generateTaskNotes} label={t('coset.notes')} disabled={save.isPending} onChange={(v) => save.mutate({ generateTaskNotes: v })} />
        </div>
      </div>
    </>
  )
}

/** Опасная зона: удалить компанию целиком. Подтверждение — названием. */
export function CompanyDanger() {
  const { t } = useTranslation('v2')
  const { company, companyId } = useUi()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const fail = useFail()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const del = useMutation({
    mutationFn: () => api(`/api/v1/companies/${companyId}`, { method: 'DELETE', body: JSON.stringify({ confirm: typed.trim() }) }),
    onSuccess: () => {
      localStorage.removeItem('chatick_v2_company')
      void qc.invalidateQueries({ queryKey: keys.companies })
      navigate('/start', { replace: true })
    },
    onError: fail,
  })
  const ok = typed.trim() === company.name.trim()
  return (
    <section className="card sec">
      <h2>{t('coset.danger')}</h2>
      <div className="row first">
        <span className="l">
          {t('coset.delete')}
          <small>{t('coset.deleteHint')}</small>
        </span>
        {!open ? (
          <button className="btn sm red" style={{ justifySelf: 'start' }} onClick={() => setOpen(true)}>
            {t('coset.delete')}
          </button>
        ) : (
          <div className="conf" role="alert">
            <span>{t('coset.deleteType', { name: company.name })}</span>
            <label className="f" style={{ width: 240, color: 'var(--ink)' }}>
              <input className="bidi" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={t('coset.deleteType', { name: company.name })} />
            </label>
            <button className="btn sm red" disabled={!ok || del.isPending} onClick={() => del.mutate()}>
              {t('coset.deleteYes')}
            </button>
            <button
              className="btn sm"
              onClick={() => {
                setOpen(false)
                setTyped('')
              }}
            >
              {t('settings.cancel')}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

type UsageRow = { calls: number; tokensIn: number; tokensOut: number; costUsd: number }
type Usage = {
  totalUsd: number
  byModel: (UsageRow & { model: string; source: string })[]
  byFeature: (UsageRow & { feature: string })[]
  log: { id: string; model: string; source: string; feature: string | null; tokensIn: number; tokensOut: number; costUsd: number | null; createdAt: string; project: string | null }[]
}
const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`

/** Расход ИИ компании за 30 дней: итог, по задачам ИИ, по моделям, последние вызовы. */
export function CompanyAiUsage() {
  const { t, i18n } = useTranslation('v2')
  const { companyId } = useUi()
  const [log, setLog] = useState(false)
  const q = useQuery({ queryKey: ['v2', 'co-ai-usage', companyId], queryFn: () => api<Usage>(`/api/v1/companies/${companyId}/ai-usage?days=30`) })
  const d = q.data
  if (!d) return null
  return (
    <section className="card sec">
      <h2>
        {t('aiu.title')} <small>{t('settings.adminOnly')}</small>
      </h2>
      <p className="d">{t('aiu.sub', { total: usd(d.totalUsd) })}</p>
      {!d.byFeature.length && <p className="d">{t('aiu.none')}</p>}
      {d.byFeature.length > 0 && (
        <table className="aiu">
          <thead>
            <tr>
              <th>{t('aiu.feature')}</th>
              <th>{t('aiu.calls')}</th>
              <th>{t('aiu.tokens')}</th>
              <th>{t('aiu.cost')}</th>
            </tr>
          </thead>
          <tbody>
            {d.byFeature.map((r) => (
              <tr key={r.feature}>
                <td>{t(`aiu.f.${r.feature}`, { defaultValue: r.feature })}</td>
                <td>{r.calls}</td>
                <td>{(r.tokensIn + r.tokensOut).toLocaleString(i18n.language)}</td>
                <td>{usd(r.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {d.byModel.length > 0 && (
        <table className="aiu">
          <thead>
            <tr>
              <th>{t('aiu.model')}</th>
              <th>{t('aiu.calls')}</th>
              <th>{t('aiu.tokens')}</th>
              <th>{t('aiu.cost')}</th>
            </tr>
          </thead>
          <tbody>
            {d.byModel.map((r) => (
              <tr key={r.model + r.source}>
                <td dir="ltr">
                  {r.model} {r.source === 'trial' && <span className="aiu-tag">{t('aiu.trial')}</span>}
                </td>
                <td>{r.calls}</td>
                <td>{(r.tokensIn + r.tokensOut).toLocaleString(i18n.language)}</td>
                <td>{usd(r.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {d.log.length > 0 && (
        <button className="btn sm" onClick={() => setLog(!log)}>
          {log ? t('aiu.hideLog') : t('aiu.showLog', { count: d.log.length })}
        </button>
      )}
      {log && (
        <table className="aiu">
          <tbody>
            {d.log.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.createdAt).toLocaleString(i18n.language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                <td>{t(`aiu.f.${r.feature ?? 'other'}`, { defaultValue: r.feature ?? '—' })}</td>
                <td className="bidi">{r.project ?? t('aiu.company')}</td>
                <td dir="ltr">{r.model}</td>
                <td>{r.costUsd === null ? '—' : usd(r.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
