import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { PROJECT_LANGUAGES } from '@/lib/languages'
import type { CompanyProject } from '../data'
import { useUi } from '../ui'
import { Icon } from '../Icon'
import { ProjectLogo } from '../ProjectLogo'
import { Select } from '../ui/Calendar'
import { shortProject } from '../util'
import { errText, upload } from '../settings/parts'
import { useCoRefresh } from './data'
import '../i18n/project'

/** Проект целиком: в списке компании нет описания, языка, лимита и внешней связи. */
type ProjectFull = CompanyProject & {
  about: string | null
  locale: string | null
  aiConfig: { language?: string }
  storageLimit: string | null
  externalId: string | null
  externalLink: { name: string; url: string } | null
}

/** Та же палитра, из которой сервер красит новые проекты (PROJECT_COLORS). */
const COLORS = ['#6366f1', '#0ea5e9', '#14b8a6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#64748b']
const GB = 1024 ** 3
const LIMITS = [1, 5, 10, 25, 50]
/** Языки, на которые переведены письма. Остальные — только язык работы ИИ. */
const MAIL_LOCALES = new Set(['en', 'ru', 'he'])

export function useProjectFull(projectId: string) {
  return useQuery({
    queryKey: ['v2', 'project-full', projectId],
    queryFn: () => api<ProjectFull>(`/api/v1/projects/${projectId}`),
  })
}

/**
 * Настройки проекта в его панели: как называется, о чём он (контекст для ИИ),
 * на каком языке работает, как выглядит. Ниже — напоминания, хранилище и
 * опасная зона.
 */
export function ProjectAbout({ project }: { project: CompanyProject }) {
  const { t } = useTranslation('v2')
  const { flash } = useUi()
  const qc = useQueryClient()
  const refresh = useCoRefresh()
  const full = useProjectFull(project.id)
  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(project.name)
  const [about, setAbout] = useState('')
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => setName(project.name), [project.name])
  useEffect(() => {
    if (full.data) setAbout(full.data.about ?? '')
  }, [full.data])

  const reload = () => {
    refresh()
    void qc.invalidateQueries({ queryKey: ['v2', 'project-full', project.id] })
  }
  const patch = useMutation({
    mutationFn: (b: Record<string, unknown>) => api(`/api/v1/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify(b) }),
    onSuccess: () => {
      setErr(null)
      reload()
      flash(t('proj.saved'))
    },
    onError: (e) => setErr(errText(e, t('proj.failed'))),
  })
  const logo = useMutation({
    mutationFn: (f: File) => upload(`/api/v1/projects/${project.id}/logo`, f),
    onSuccess: reload,
    onError: (e) => setErr(errText(e, t('proj.failed'))),
  })
  const dropLogo = useMutation({
    mutationFn: () => api(`/api/v1/projects/${project.id}/logo`, { method: 'DELETE' }),
    onSuccess: reload,
    onError: (e) => setErr(errText(e, t('proj.failed'))),
  })

  const trimmed = name.trim()
  const nameDirty = Boolean(trimmed && trimmed !== project.name)
  const aboutDirty = full.data ? about.trim() !== (full.data.about ?? '').trim() : false
  const lang = full.data?.aiConfig?.language ?? 'en'
  const setLang = (code: string) =>
    patch.mutate({ aiConfig: { language: code }, locale: MAIL_LOCALES.has(code) ? code : null })

  return (
    <div className="co-sec psx">
      <h3>{t('proj.about')}</h3>
      <div className="psx-id">
        <ProjectLogo project={{ ...project, logoUrl: full.data?.logoUrl ?? project.logoUrl, color: full.data?.color ?? project.color }} size="md" />
        <div className="psx-colors" role="radiogroup" aria-label={t('proj.color')}>
          {COLORS.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={(full.data?.color ?? project.color) === c}
              aria-label={c}
              className={'psx-sw' + ((full.data?.color ?? project.color) === c ? ' on' : '')}
              style={{ background: c }}
              onClick={() => patch.mutate({ color: c })}
            />
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <button className="mini" onClick={() => fileRef.current?.click()} disabled={logo.isPending}>
          {logo.isPending ? t('proj.uploading') : t('proj.logoUpload')}
        </button>
        {(full.data?.logoUrl ?? project.logoUrl) && (
          <button className="mini" onClick={() => dropLogo.mutate()} disabled={dropLogo.isPending}>
            {t('proj.logoRemove')}
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) logo.mutate(f)
          }}
        />
      </div>

      <div className="lbl psx-l">{t('proj.name')}</div>
      <div className="psx-row">
        <input
          className="nin bidi"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && nameDirty && patch.mutate({ name: trimmed })}
          aria-label={t('proj.name')}
        />
        {nameDirty && (
          <button className="btn-acc" onClick={() => patch.mutate({ name: trimmed })} disabled={patch.isPending}>
            {t('proj.save')}
          </button>
        )}
      </div>

      <div className="lbl psx-l">{t('proj.desc')}</div>
      <textarea
        className="nin psx-ta bidi"
        value={about}
        maxLength={5000}
        rows={4}
        onChange={(e) => setAbout(e.target.value)}
        placeholder={t('proj.descPh')}
        aria-label={t('proj.desc')}
      />
      {aboutDirty && (
        <div className="co-foot" style={{ marginTop: 8 }}>
          <button className="btn-acc" onClick={() => patch.mutate({ about: about.trim() })} disabled={patch.isPending}>
            {t('proj.save')}
          </button>
          <button className="btn" onClick={() => setAbout(full.data?.about ?? '')}>
            {t('proj.cancel')}
          </button>
        </div>
      )}

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
    </div>
  )
}

type Reminder = {
  enabled: boolean
  cadence: 'hourly' | 'daily' | 'weekly'
  everyHours: number
  hourOfDay: number
  dayOfWeek: number
  audience: 'all_members' | 'assignees'
  statuses: string[]
}
const REM_DEFAULT: Reminder = { enabled: false, cadence: 'daily', everyHours: 12, hourOfDay: 9, dayOfWeek: 1, audience: 'assignees', statuses: ['todo', 'in_progress'] }
const REM_STATUSES = ['todo', 'in_progress', 'review'] as const

/** Напоминания об открытых задачах проекта: по расписанию, кому и о каких. */
export function ProjectReminders({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation('v2')
  const { flash } = useUi()
  const qc = useQueryClient()
  const key = ['v2', 'reminder', projectId]
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<{ reminder: (Omit<Reminder, 'statuses' | 'everyHours' | 'hourOfDay' | 'dayOfWeek'> & Record<string, unknown>) | null }>('/api/v1/notifications/reminders', { headers: { 'X-Project': projectId } }),
  })
  const [f, setF] = useState<Reminder>(REM_DEFAULT)
  useEffect(() => {
    const r = q.data?.reminder
    if (!r) return
    // Сервер хранит числа и статусы строками — приводим к форме.
    setF({
      enabled: Boolean(r.enabled),
      cadence: (r.cadence as Reminder['cadence']) ?? 'daily',
      everyHours: Number(r.everyHours) || 12,
      hourOfDay: Number(r.hourOfDay) || 0,
      dayOfWeek: Number(r.dayOfWeek) || 0,
      audience: (r.audience as Reminder['audience']) ?? 'assignees',
      statuses: String(r.statuses ?? 'todo').split(',').filter(Boolean),
    })
  }, [q.data])
  const save = useMutation({
    mutationFn: (v: Reminder) => api('/api/v1/notifications/reminders', { method: 'PUT', body: JSON.stringify(v), headers: { 'X-Project': projectId } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key })
      flash(t('proj.saved'))
    },
    onError: (e) => flash(errText(e, t('proj.failed'))),
  })
  const set = (patch: Partial<Reminder>) => {
    const next = { ...f, ...patch }
    setF(next)
    save.mutate(next)
  }
  const hours = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }))
  const days = Array.from({ length: 7 }, (_, d) => ({
    value: String(d),
    // 4 января 1970 — воскресенье: отсюда день недели на языке интерфейса.
    label: new Date(Date.UTC(1970, 0, 4 + d)).toLocaleDateString(i18n.language, { weekday: 'long', timeZone: 'UTC' }),
  }))
  return (
    <div className="co-sec psx">
      <h3 className="psx-h">
        {t('proj.rem')}
        <button type="button" className={'psx-tg' + (f.enabled ? ' on' : '')} aria-pressed={f.enabled} aria-label={t('proj.rem')} onClick={() => set({ enabled: !f.enabled })} />
      </h3>
      <p className="co-hint" style={{ marginTop: 0 }}>{t('proj.remHint')}</p>
      {f.enabled && (
        <div className="psx-grid">
          <span className="lbl">{t('proj.remWhen')}</span>
          <div className="psx-row">
            <Select
              value={f.cadence}
              ariaLabel={t('proj.remWhen')}
              options={(['daily', 'weekly', 'hourly'] as const).map((c) => ({ value: c, label: t(`proj.cad.${c}`) }))}
              onChange={(v) => set({ cadence: v })}
            />
            {f.cadence === 'weekly' && <Select value={String(f.dayOfWeek)} ariaLabel={t('proj.remDay')} options={days} onChange={(v) => set({ dayOfWeek: Number(v) })} />}
            {f.cadence !== 'hourly' && <Select value={String(f.hourOfDay)} ariaLabel={t('proj.remHour')} options={hours} onChange={(v) => set({ hourOfDay: Number(v) })} />}
            {f.cadence === 'hourly' && (
              <Select
                value={String(f.everyHours)}
                ariaLabel={t('proj.remEvery')}
                options={[12, 24].map((h) => ({ value: String(h), label: t('proj.everyH', { count: h }) }))}
                onChange={(v) => set({ everyHours: Number(v) })}
              />
            )}
          </div>
          <span className="lbl">{t('proj.remWho')}</span>
          <div className="seg">
            {(['assignees', 'all_members'] as const).map((a) => (
              <button key={a} className={f.audience === a ? 'on' : ''} aria-pressed={f.audience === a} onClick={() => set({ audience: a })}>
                {t(`proj.aud.${a}`)}
              </button>
            ))}
          </div>
          <span className="lbl">{t('proj.remWhat')}</span>
          <div className="psx-row" style={{ flexWrap: 'wrap' }}>
            {REM_STATUSES.map((s) => {
              const on = f.statuses.includes(s)
              return (
                <button
                  key={s}
                  className={'fx' + (on ? ' on' : '')}
                  aria-pressed={on}
                  onClick={() => {
                    const next = on ? f.statuses.filter((x) => x !== s) : [...f.statuses, s]
                    if (next.length) set({ statuses: next })
                  }}
                >
                  {t(`proj.st.${s}`)}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/** Хранилище и внешняя система: лимит места и отвязка от учётной системы. */
export function ProjectStorage({ projectId }: { projectId: string }) {
  const { t } = useTranslation('v2')
  const { flash } = useUi()
  const qc = useQueryClient()
  const full = useProjectFull(projectId)
  const [unlinkSure, setUnlinkSure] = useState(false)
  const reload = () => void qc.invalidateQueries({ queryKey: ['v2', 'project-full', projectId] })
  const patch = useMutation({
    mutationFn: (b: Record<string, unknown>) => api(`/api/v1/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify(b) }),
    onSuccess: () => {
      reload()
      flash(t('proj.saved'))
    },
    onError: (e) => flash(errText(e, t('proj.failed'))),
  })
  const unlink = useMutation({
    mutationFn: () => api(`/api/v1/projects/${projectId}/unlink-external`, { method: 'POST' }),
    onSuccess: () => {
      setUnlinkSure(false)
      reload()
      flash(t('proj.unlinked'))
    },
    onError: (e) => flash(errText(e, t('proj.failed'))),
  })
  const limit = full.data?.storageLimit == null ? 'inherit' : String(Math.round(Number(full.data.storageLimit) / GB))
  const ext = full.data?.externalId ? full.data.externalLink?.name || t('proj.extSystem') : null
  return (
    <div className="co-sec psx">
      <h3>{t('proj.storage')}</h3>
      <Select
        value={limit}
        ariaLabel={t('proj.storage')}
        options={[{ value: 'inherit', label: t('proj.limitInherit') }, ...LIMITS.map((g) => ({ value: String(g), label: t('proj.limitGb', { n: g }) }))]}
        onChange={(v) => patch.mutate({ storageLimit: v === 'inherit' ? null : Number(v) * GB })}
      />
      <p className="co-hint">{t('proj.storageHint')}</p>
      {ext && (
        <>
          <div className="lbl psx-l">{t('proj.ext', { name: ext })}</div>
          {unlinkSure ? (
            <div className="co-warn">
              <p>{t('proj.unlinkSure', { name: ext })}</p>
              <div className="co-foot" style={{ marginTop: 0 }}>
                <button className={'btn-hot' + (unlink.isPending ? ' dis' : '')} onClick={() => unlink.mutate()}>
                  {t('proj.unlink')}
                </button>
                <button className="btn" onClick={() => setUnlinkSure(false)}>
                  {t('proj.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <button className="co-link" style={{ marginTop: 0 }} onClick={() => setUnlinkSure(true)}>
              <Icon name="link" sm />
              {t('proj.unlink')}
            </button>
          )}
        </>
      )}
    </div>
  )
}

/**
 * Удалить проект насовсем. Сначала предлагаем архив (он рядом): удаление
 * стирает задачи, документы и файлы. Подтверждение — названием проекта.
 */
export function ProjectDelete({ project, onDone }: { project: CompanyProject; onDone: () => void }) {
  const { t } = useTranslation('v2')
  const { flash } = useUi()
  const refresh = useCoRefresh()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const short = shortProject(project.name)
  const del = useMutation({
    mutationFn: () => api(`/api/v1/projects/${project.id}`, { method: 'DELETE', body: JSON.stringify({ confirm: typed.trim() }) }),
    onSuccess: () => {
      flash(t('proj.deleted', { name: short }))
      refresh()
      onDone()
    },
    onError: (e) => flash(errText(e, t('proj.failed'))),
  })
  const ok = typed.trim() === project.name.trim()
  if (!open)
    return (
      <button className="co-danger" onClick={() => setOpen(true)}>
        <Icon name="close" sm />
        {t('proj.delete')}
      </button>
    )
  return (
    <div className="co-warn" role="alert">
      <p>{t('proj.deleteWarn')}</p>
      <div className="lbl">{t('proj.deleteType', { name: project.name })}</div>
      <input className="nin bidi" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={t('proj.deleteType', { name: project.name })} />
      <div className="co-foot">
        <button className={'btn-hot' + (ok && !del.isPending ? '' : ' dis')} aria-disabled={!ok} onClick={() => ok && del.mutate()}>
          {t('proj.deleteYes')}
        </button>
        <button className="btn" onClick={() => setOpen(false)}>
          {t('proj.cancel')}
        </button>
      </div>
    </div>
  )
}
