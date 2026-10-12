import { useQueryClient } from '@tanstack/react-query'
import { DateField } from '../ui/Calendar'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { errorCode, type CompanyProject } from '../data'
import { Icon } from '../Icon'
import { projectColor, shortProject } from '../util'
import { ProjectCombo } from './Combo'
import { at, addDays, dayKey, hhmm, hm, minutesOf, parseDur, todayKey, type Entry, type PF } from './timeData'

/** Черновик правки: существующая запись (id) или новая ('new'). */
export type Form = { id: string; sd: string; st: string; ed: string; et: string; du: string; note: string; pf: PF }

export type Notify = (msg: string, undo?: () => Promise<unknown>) => void

/** Проверка черновика — те же пороги, что на сервере: конец позже начала, не дольше суток. */
function calc(f: Form): { err?: string; warn?: string; m?: number } {
  const a = at(f.sd, f.st)
  const b = at(f.ed, f.et)
  if (!a || !b) return { err: 'errFormat' }
  const m = Math.round((b.getTime() - a.getTime()) / 60_000)
  if (m <= 0) return { err: 'errOrder' }
  if (m > 24 * 60) return { err: 'errDay' }
  if (m > 16 * 60) return { warn: 'warnLong', m }
  return { m }
}

export function formOf(e: Entry, now: number): Form {
  const s = new Date(e.startedAt)
  const f = e.endedAt ? new Date(e.endedAt) : new Date(now)
  return { id: e.id, sd: dayKey(s), st: hhmm(s), ed: dayKey(f), et: hhmm(f), du: hm(minutesOf(e, now)), note: e.description ?? '', pf: e.projectId ?? 'none' }
}

/** Новая запись на день: сегодня — последний час до «сейчас», иначе 16:00–17:00, как в макете. */
export function newForm(day: string, pf: PF): Form {
  let st = '16:00'
  let et = '17:00'
  if (day === todayKey()) {
    const end = new Date()
    end.setMinutes(Math.floor(end.getMinutes() / 5) * 5, 0, 0)
    const start = new Date(end.getTime() - 3600_000)
    if (dayKey(start) === day) {
      st = hhmm(start)
      et = hhmm(end)
    }
  }
  return { id: 'new', sd: day, st, ed: day, et, du: '1:00', note: '', pf: pf === 'all' ? 'none' : pf }
}

/**
 * Мои часы (доски Time / TimeEdit): записи по дням, сводка за период,
 * проект прямо в строке, правка дат и времени по клику. Запись через
 * полночь стоит в дне начала с пометкой «+1 д».
 */
export function Mine({
  companyId,
  range,
  entries,
  loading,
  truncated,
  now,
  projects,
  pf,
  pfName,
  form,
  setForm,
  notify,
}: {
  companyId: string
  range: [string, string]
  entries: Entry[]
  loading: boolean
  truncated: boolean
  now: number
  projects: CompanyProject[]
  pf: PF
  pfName: string | null
  form: Form | null
  setForm: (f: Form | null) => void
  notify: Notify
}) {
  const { t, i18n } = useTranslation('v2')
  const lng = i18n.language
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['v2', 'time'] })
  const call = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      return true
    } catch (e) {
      notify(t('time.failed', { e: errorCode(e) }))
      return false
    } finally {
      void refresh()
    }
  }
  const body = (b: unknown) => ({ body: JSON.stringify(b) })

  const inR = entries
    .filter((e) => {
      const k = dayKey(new Date(e.startedAt))
      return k >= range[0] && k <= range[1]
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const total = inR.reduce((s, e) => s + minutesOf(e, now), 0)
  const byP = new Map<string, { p: Entry['project']; m: number }>()
  for (const e of inR) {
    const k = e.projectId ?? ''
    const cur = byP.get(k) ?? { p: e.project, m: 0 }
    cur.m += minutesOf(e, now)
    byP.set(k, cur)
  }
  const parts = [...byP.entries()].sort((a, b) => Number(a[0] === '') - Number(b[0] === '') || b[1].m - a[1].m)
  const isNew = form?.id === 'new'
  const days = [...new Set([...inR.map((e) => dayKey(new Date(e.startedAt))), ...(isNew ? [form.sd] : [])])].sort().reverse()
  const today = todayKey()
  const pname = (p: Entry['project']) => (p ? shortProject(p.name) : t('time.noProject'))
  const pcolor = (p: Entry['project']) => (p ? projectColor(p) : '#9A9E95')

  const save = async (f: Form, e: Entry | null) => {
    const c = calc(f)
    if (c.err) return
    const a = at(f.sd, f.st)!.toISOString()
    const b = at(f.ed, f.et)!.toISOString()
    const ok = e
      ? await call(() => api(`/api/v1/my/time/${e.id}`, { method: 'PATCH', ...body({ startedAt: a, endedAt: b, description: f.note }) }))
      : await call(() =>
          api('/api/v1/my/time', {
            method: 'POST',
            ...body({ ...(f.pf !== 'none' && f.pf !== 'all' ? { projectId: f.pf } : { companyId }), startedAt: a, endedAt: b, description: f.note }),
          }),
        )
    if (!ok) return
    setForm(null)
    notify(t(e ? 'time.saved' : 'time.added', { h: hm(c.m!) }))
  }

  const del = async (e: Entry) => {
    const m = minutesOf(e, now)
    if (!(await call(() => api(`/api/v1/my/time/${e.id}`, { method: 'DELETE' })))) return
    if (form?.id === e.id) setForm(null)
    // «Вернуть» — та же запись заново: задача, заметка, время и проект.
    notify(t('time.deleted', { h: hm(m) }), () =>
      call(() =>
        api('/api/v1/my/time', {
          method: 'POST',
          ...body({
            ...(e.projectId ? { projectId: e.projectId, taskId: e.task?.id ?? null } : { companyId }),
            description: e.description ?? '',
            startedAt: e.startedAt,
            endedAt: e.endedAt,
          }),
        }),
      ),
    )
  }

  const move = async (e: Entry, k: PF) => {
    const to = k === 'none' || k === 'all' ? null : k
    if (to === e.projectId) return
    if (!(await call(() => api(`/api/v1/my/time/${e.id}`, { method: 'PATCH', ...body({ projectId: to }) })))) return
    const p = to ? projects.find((x) => x.id === to) : null
    notify(t('time.moved', { h: hm(minutesOf(e, now)), p: p ? shortProject(p.name) : t('time.noProject') }), () =>
      call(() => api(`/api/v1/my/time/${e.id}`, { method: 'PATCH', ...body({ projectId: e.projectId }) })),
    )
  }

  const stopTimer = async (e: Entry) => {
    if (await call(() => api(`/api/v1/my/time/${e.id}/stop`, { method: 'POST' }))) notify(t('time.stopped'))
  }

  return (
    <>
      <div className="sum">
        <div className="card tot">
          <span className="k">{t('time.total')}</span>
          <div className="v">{hm(total)}</div>
          <div className="d">
            {t('time.entries', { count: inR.length })}
            {pf !== 'all' && pfName ? ` · ${pfName}` : ''}
          </div>
        </div>
        <div className="card bp">
          <div className="stack">
            {parts.map(([k, v]) => (
              <i key={k} style={{ width: `${Math.round((v.m / Math.max(1, total)) * 100)}%`, background: pcolor(v.p) }} title={`${pname(v.p)} · ${hm(v.m)}`} />
            ))}
          </div>
          <div className="leg">
            {parts.map(([k, v]) => (
              <span key={k}>
                <i style={{ background: pcolor(v.p) }} />
                <span className="bidi">{pname(v.p)}</span> <b>{hm(v.m)}</b>
              </span>
            ))}
          </div>
        </div>
      </div>

      {truncated && <p className="note">{t('time.truncated')}</p>}

      {days.map((d) => {
        const list = inR.filter((e) => dayKey(new Date(e.startedAt)) === d)
        return (
          <section className="card dg" key={d}>
            <div className="dh">
              <b>{new Date(`${d}T12:00:00`).toLocaleDateString(lng, { weekday: 'long', month: 'long', day: 'numeric' })}</b>
              {d === today && <span className="td">{t('time.today')}</span>}
              <span className="sp" />
              <span className="t">{hm(list.reduce((s, e) => s + minutesOf(e, now), 0))}</span>
              <button className="add" onClick={() => setForm(newForm(d, pf))} aria-label={t('time.addDay')} title={t('time.addDay')}>
                <Icon name="plus" sm />
              </button>
            </div>
            {list.map((e) => (
              <Row
                key={e.id}
                e={e}
                now={now}
                lng={lng}
                projects={projects}
                form={form?.id === e.id ? form : null}
                onOpen={() => !e.running && form?.id !== e.id && setForm(formOf(e, now))}
                setForm={setForm}
                onSave={(f) => void save(f, e)}
                onDel={() => void del(e)}
                onMove={(k) => void move(e, k)}
                onStop={() => void stopTimer(e)}
              />
            ))}
            {isNew && form.sd === d && (
              <Row e={null} now={now} lng={lng} projects={projects} form={form} onOpen={() => {}} setForm={setForm} onSave={(f) => void save(f, null)} />
            )}
          </section>
        )
      })}
      {!days.length && !loading && <div className="card empty">{pf !== 'all' && pfName ? t('time.noneIn', { p: pfName }) : t('time.none')}</div>}
      {!days.length && loading && <div className="card empty">{t('time.loading')}</div>}
      <p className="note">{t('time.noteMine')}</p>
    </>
  )
}

function Row({
  e,
  now,
  lng,
  projects,
  form,
  onOpen,
  setForm,
  onSave,
  onDel,
  onMove,
  onStop,
}: {
  e: Entry | null
  now: number
  lng: string
  projects: CompanyProject[]
  form: Form | null
  onOpen: () => void
  setForm: (f: Form | null) => void
  onSave: (f: Form) => void
  onDel?: () => void
  onMove?: (k: PF) => void
  onStop?: () => void
}) {
  const { t } = useTranslation('v2')
  const live = Boolean(e?.running)
  const s = e ? new Date(e.startedAt) : null
  const f = e?.endedAt ? new Date(e.endedAt) : null
  const next = Boolean(s && f && dayKey(f) !== dayKey(s))
  const stop = (ev: React.SyntheticEvent) => ev.stopPropagation()
  const range = e ? `${hhmm(s!)} – ${live ? t('time.now') : hhmm(f!)}` : `${form!.st} – ${form!.et}`
  const dur = e ? hm(minutesOf(e, now)) : (form!.du ?? '')
  const pfv: PF = e ? (e.projectId ?? 'none') : form!.pf
  return (
    <div className={'en' + (live ? ' live' : '') + (form ? ' ed' : '')} onClick={onOpen}>
      <span className="tr">
        {range}
        {next && (
          <span className="nx" title={t('time.endedOn', { d: f!.toLocaleDateString(lng, { month: 'short', day: 'numeric' }) })}>
            {t('time.nextDay')}
          </span>
        )}
      </span>
      <span className="du">{dur}</span>
      <div className="pjc" onClick={stop}>
        <ProjectCombo small value={pfv} projects={projects} onPick={(k) => (e ? onMove?.(k) : setForm({ ...form!, pf: k }))} />
      </div>
      <div className="bd">
        <div className={'t1 bidi' + (e?.task ? '' : ' e')}>
          {e?.task && <b>{e.task.number}</b>}
          {e?.task ? e.task.title : t('time.noTask')}
        </div>
        {(live || e?.description) && <div className="t2 bidi">{live ? t('time.running') : e!.description}</div>}
      </div>
      <div className="ea" onClick={stop}>
        {live && (
          <button className="stop" onClick={onStop}>
            {t('time.stop')}
          </button>
        )}
        {e && !live && (
          <>
            <button onClick={() => (form ? setForm(null) : onOpen())} aria-label={t('time.edit')} title={t('time.edit')}>
              <PencilIcon />
            </button>
            <button onClick={onDel} aria-label={t('time.del')} title={t('time.del')}>
              <TrashIcon />
            </button>
          </>
        )}
      </div>
      {form && <EditForm form={form} setForm={setForm} onSave={onSave} lng={lng} isNew={!e} />}
    </div>
  )
}

function EditForm({ form: F, setForm, onSave, lng, isNew }: { form: Form; setForm: (f: Form | null) => void; onSave: (f: Form) => void; lng: string; isNew: boolean }) {
  const { t } = useTranslation('v2')
  const c = calc(F)
  // Пересчёт длительности при правке краёв — как в макете: человек видит итог сразу.
  const setF = (p: Partial<Form>, recalc = true) => {
    const nf = { ...F, ...p }
    if (recalc) {
      const cc = calc(nf)
      if (cc.m != null) nf.du = hm(cc.m)
    }
    setForm(nf)
  }
  const onSd = (v: string) => {
    // Сдвиг даты начала тянет за собой конец: запись через полночь остаётся через полночь.
    const shift = F.sd && F.ed ? Math.round((new Date(`${F.ed}T12:00:00`).getTime() - new Date(`${F.sd}T12:00:00`).getTime()) / 864e5) : 0
    setF({ sd: v, ed: v ? addDays(v, shift) : F.ed })
  }
  const onDu = (v: string) => {
    const m = parseDur(v)
    const a = at(F.sd, F.st)
    if (m != null && a) {
      const end = new Date(a.getTime() + m * 60_000)
      setForm({ ...F, du: v, ed: dayKey(end), et: hhmm(end) })
    } else setForm({ ...F, du: v })
  }
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') onSave(F)
    if (e.key === 'Escape') setForm(null)
  }
  const msg = c.err
    ? t(`time.${c.err}`)
    : c.warn
      ? t(`time.${c.warn}`)
      : t('time.msgTotal', { h: hm(c.m!) }) + (F.ed !== F.sd ? t('time.msgEnds', { d: new Date(`${F.ed}T12:00:00`).toLocaleDateString(lng, { month: 'short', day: 'numeric' }) }) : '')
  return (
    <div className="edf" onClick={(e) => e.stopPropagation()} onKeyDown={keys}>
      <label className="fl">
        <span>{t('time.fStart')}</span>
        <span className="dt">
          <DateField className="d" value={F.sd || null} onChange={(v) => v && onSd(v)} ariaLabel={t('time.startDate')} />
          <input className="t" value={F.st} onChange={(e) => setF({ st: e.target.value })} aria-label={t('time.startTime')} placeholder="09:00" autoFocus={isNew} />
        </span>
      </label>
      <label className="fl">
        <span>{t('time.fEnd')}</span>
        <span className="dt">
          <DateField className="d" value={F.ed || null} onChange={(v) => v && setF({ ed: v })} ariaLabel={t('time.endDate')} />
          <input className="t" value={F.et} onChange={(e) => setF({ et: e.target.value })} aria-label={t('time.endTime')} placeholder="10:30" />
        </span>
      </label>
      <label className="fl">
        <span>{t('time.fDur')}</span>
        <span className="dt">
          <input className="t" value={F.du} onChange={(e) => onDu(e.target.value)} aria-label={t('time.fDur')} placeholder="1:30" />
        </span>
      </label>
      <label className="fl">
        <span>{t('time.fNote')}</span>
        <input className="nt bidi" value={F.note} onChange={(e) => setF({ note: e.target.value }, false)} placeholder={t('time.fNotePh')} />
      </label>
      <div className="edb">
        <span className={'msg' + (c.err ? ' err' : c.warn ? ' warn' : '')}>{msg}</span>
        <span className="sp" />
        <button className="btn sm" onClick={() => setForm(null)}>
          {t('time.cancel')}
        </button>
        <button className={'btn sm pr' + (c.err ? ' dis' : '')} disabled={Boolean(c.err)} onClick={() => onSave(F)}>
          {t('time.save')}
        </button>
      </div>
    </div>
  )
}

/** Карандаш и корзина — из макета; в общем наборе значков их нет. */
function PencilIcon() {
  return (
    <svg className="ic sm" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20h4L19 9l-4-4L4 16z" />
    </svg>
  )
}
function TrashIcon() {
  return (
    <svg className="ic sm" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />
    </svg>
  )
}

