import { useCallback, useEffect, useRef, useState } from 'react'
import { DateField } from '../ui/Calendar'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMe, useProjects } from '../data'
import { useUi } from '../ui'
import { Icon } from '../Icon'
import { shortProject } from '../util'
import { ProjectCombo } from './Combo'
import { Mine, newForm, type Form } from './Mine'
import { PersonDrawer, Sheet } from './Sheet'
import { ExportDialog, type ExPerson } from './Export'
import { addDays, hm, parseDay, rangeOf, todayKey, useEntries, useMembers, useNow, useReport, useTimeSocket, useWeekStart, type PF, type Per } from './timeData'
import '../i18n/time'
import '../styles/time.css'

const PERS: Per[] = ['day', 'week', 'month', 'custom']

/**
 * «Часы» (v2): мои часы и — для менеджера и админа компании — часы по людям.
 *
 * Адреса: time — мои часы; time/people — по людям; time/people/:userId —
 * все записи человека поверх таблицы. Участнику «по людям» не показываем:
 * в v2 одна лестница ролей, чужие часы видит только руководство компании
 * (сервер решает то же самое, это лишь не рисует лишнего).
 *
 * Проект-фильтр — тот же ?p=, что и на остальных экранах; «Без проекта»
 * живёт только здесь, другим экранам такой фильтр не нужен.
 */
export function TimeView() {
  const { t, i18n } = useTranslation('v2')
  const lng = i18n.language
  const { companyId, company, base, project, setProject } = useUi()
  const navigate = useNavigate()
  const location = useLocation()
  const rest = (useParams()['*'] ?? '').split('/')
  const lead = company.myRole === 'admin' || company.myRole === 'manager'
  const isSheet = lead && rest[0] === 'people'
  const openId = isSheet ? (rest[1] ?? null) : null
  useTimeSocket()
  const now = useNow()
  const me = useMe()
  const projects = useProjects(companyId)
  const weekStart = useWeekStart(companyId)

  const [per, setPer] = useState<Per>(() => {
    try {
      const v = localStorage.getItem('chatick_v2_time_per') as Per | null
      return v && PERS.includes(v) ? v : 'week'
    } catch {
      return 'week'
    }
  })
  const [anchor, setAnchor] = useState(todayKey)
  const [cFrom, setCFrom] = useState(() => addDays(todayKey(), -6))
  const [cTo, setCTo] = useState(todayKey)
  const [noneOn, setNoneOn] = useState(false)
  const [form, setForm] = useState<Form | null>(null)
  const [pq, setPq] = useState('')
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set())
  // null — закрыто; 'mine' — свои часы; 'many' — выбранные люди; иначе — id человека.
  const [ex, setEx] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; undo?: () => Promise<unknown> } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  const plist = projects.data ?? []
  const pf: PF = noneOn ? 'none' : project && plist.some((p) => p.id === project) ? project : 'all'
  const setPf = (k: PF) => {
    setNoneOn(k === 'none')
    setProject(k === 'all' || k === 'none' ? null : k)
  }
  const pfName = pf === 'none' ? t('time.noProject') : pf === 'all' ? null : shortProject(plist.find((p) => p.id === pf)?.name ?? '')

  const range = rangeOf(per, anchor, cFrom, cTo, weekStart)
  const mine = useEntries(companyId, range, { userId: me.data?.id, pf, enabled: !isSheet && Boolean(me.data) })
  const report = useReport(companyId, range, pf, isSheet)
  const members = useMembers(companyId, lead)

  const notify = useCallback((msg: string, undo?: () => Promise<unknown>) => {
    setToast({ msg, undo })
    window.clearTimeout(toastTimer.current)
    // С «Вернуть» — подольше: человеку нужно успеть понять, что удалил не то.
    toastTimer.current = window.setTimeout(() => setToast(null), undo ? 6000 : 3200)
  }, [])
  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  const choosePer = (p: Per) => {
    setPer(p)
    setAnchor(todayKey())
    try {
      localStorage.setItem('chatick_v2_time_per', p)
    } catch {
      /* без хранилища просто не запомним */
    }
  }
  const shift = (n: number) => {
    if (per === 'month') {
      const d = parseDay(anchor)
      const m = new Date(d.getFullYear(), d.getMonth() + n, 1)
      setAnchor(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-01`)
    } else setAnchor(addDays(anchor, n * (per === 'day' ? 1 : 7)))
  }
  const short = (k: string) => parseDay(k).toLocaleDateString(lng, { month: 'short', day: 'numeric' })
  const perLabel =
    per === 'day'
      ? parseDay(range[0]).toLocaleDateString(lng, { weekday: 'short', month: 'short', day: 'numeric' })
      : per === 'month'
        ? parseDay(range[0]).toLocaleDateString(lng, { month: 'long', year: 'numeric' })
        : `${short(range[0])} – ${short(range[1])}`

  const addEntry = () => {
    const today = todayKey()
    if (per === 'custom') choosePer('week')
    else if (today < range[0] || today > range[1]) setAnchor(today)
    setForm(newForm(today, pf))
  }

  // Люди «по людям»: из свода (у кого есть часы), роль и почта — из состава компании.
  const memberOf = (id: string) => members.data?.find((m) => m.user.id === id)
  const roleOf = (id: string) => {
    const r = memberOf(id)?.role
    return r ? t(`time.role.${r}`) : ''
  }
  const people: ExPerson[] = (report.data?.people ?? []).map((p) => ({ id: p.userId, name: p.name, email: memberOf(p.userId)?.user.email ?? null, role: roleOf(p.userId) }))
  const isSel = (id: string) => !excluded.has(id)
  const setSel = (id: string, on: boolean) =>
    setExcluded((prev) => {
      const n = new Set(prev)
      if (on) n.delete(id)
      else n.add(id)
      return n
    })
  const setAll = (on: boolean) => setExcluded(on ? new Set() : new Set(people.map((p) => p.id)))
  const selPeople = (report.data?.people ?? []).filter((p) => isSel(p.userId))

  const go = (path: string) => navigate({ pathname: `${base}/time${path}`, search: location.search })
  const openPerson = openId ? (people.find((p) => p.id === openId) ?? { id: openId, name: memberOf(openId)?.user.name ?? '', email: memberOf(openId)?.user.email ?? null, role: roleOf(openId) }) : null
  const exOne: ExPerson | null =
    ex === 'mine' && me.data ? { id: me.data.id, name: me.data.name, email: me.data.email, role: '' } : ex && ex !== 'many' && ex !== 'mine' ? (people.find((p) => p.id === ex) ?? openPerson) : null

  return (
    <div className="tmv">
      <div className="ph">
        <div>
          <h1>{isSheet ? t('time.titlePeople') : t('time.titleMine')}</h1>
          <p className="bidi">
            {isSheet
              ? t('time.subPeople', { company: company.name, sel: selPeople.length, n: people.length, h: hm(selPeople.reduce((s, p) => s + p.minutes, 0)) })
              : t('time.subMine', { name: me.data?.name ?? '' })}
          </p>
        </div>
        <span className="sp" />
        {lead && (
          <div className="seg" role="tablist">
            <button className={isSheet ? '' : 'on'} role="tab" aria-selected={!isSheet} onClick={() => go('')}>
              {t('time.tabMine')}
            </button>
            <button className={isSheet ? 'on' : ''} role="tab" aria-selected={isSheet} onClick={() => go('/people')}>
              {t('time.tabPeople')}
              <span className="rl">{t(`time.role.${company.myRole}`)}</span>
            </button>
          </div>
        )}
      </div>

      <div className="tbar">
        <div className="seg">
          {PERS.map((p) => (
            <button key={p} className={per === p ? 'on' : ''} aria-pressed={per === p} onClick={() => choosePer(p)}>
              {t(`time.per.${p}`)}
            </button>
          ))}
        </div>
        {per !== 'custom' ? (
          <div className="nav2">
            <button onClick={() => shift(-1)} aria-label={t('time.prev')}>
              <Icon name="chevronStart" />
            </button>
            <span>{perLabel}</span>
            <button onClick={() => shift(1)} aria-label={t('time.next')}>
              <Icon name="chevronEnd" />
            </button>
          </div>
        ) : (
          <div className="rng">
            {t('time.from')}
            <DateField value={cFrom || null} onChange={(v) => v && setCFrom(v)} ariaLabel={t('time.fromAria')} />
            {t('time.to')}
            <DateField value={cTo || null} onChange={(v) => v && setCTo(v)} ariaLabel={t('time.toAria')} />
          </div>
        )}
        <ProjectCombo value={pf} projects={plist} onPick={setPf} withAll />
        {isSheet && (
          <label className="psq">
            <Icon name="search" sm />
            <input value={pq} onChange={(e) => setPq(e.target.value)} placeholder={t('time.findPerson', { count: people.length })} aria-label={t('time.findPersonAria')} />
          </label>
        )}
        <span className="sp" />
        {!isSheet && (
          <button className="btn" onClick={addEntry}>
            <Icon name="plus" sm />
            {t('time.manual')}
          </button>
        )}
        <button className="btn" onClick={() => setEx(isSheet ? 'many' : 'mine')}>
          <svg className="ic sm" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
          </svg>
          {isSheet ? t('time.exportPeople') : t('time.exportMine')}
        </button>
      </div>

      {isSheet ? (
        <>
          <Sheet report={report.data} loading={report.isLoading} roleOf={roleOf} q={pq} openId={openId} onOpen={(id) => go(`/people/${id}`)} isSel={isSel} setSel={setSel} setAll={setAll} />
          <p className="note">{t('time.notePeople')}</p>
        </>
      ) : (
        <Mine
          companyId={companyId}
          range={range}
          entries={mine.data?.items ?? []}
          loading={mine.isLoading || !me.data}
          truncated={Boolean(mine.data?.truncated)}
          now={now}
          projects={plist}
          pf={pf}
          pfName={pfName}
          form={form}
          setForm={setForm}
          notify={notify}
        />
      )}

      {openPerson && (
        <PersonDrawer
          companyId={companyId}
          userId={openPerson.id}
          name={openPerson.name}
          role={openPerson.role}
          range={range}
          rangeLabel={perLabel}
          pf={pf}
          pfName={pfName}
          onClose={() => go('/people')}
          onExport={() => setEx(openPerson.id)}
          paused={Boolean(ex)}
        />
      )}

      {ex && (
        <ExportDialog
          companyId={companyId}
          companyName={company.name}
          range={range}
          rangeLabel={perLabel}
          pf={pf}
          pfName={pfName}
          one={exOne}
          people={people}
          report={report.data}
          isSel={isSel}
          setSel={setSel}
          setAll={setAll}
          onClose={() => setEx(null)}
          notify={notify}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          <Icon name="check" />
          {toast.msg}
          {toast.undo && (
            <button
              onClick={() => {
                const u = toast.undo!
                setToast(null)
                void u()
              }}
            >
              {t('time.undo')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
