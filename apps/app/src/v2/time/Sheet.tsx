import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { letterOf, personColor, shortProject } from '../util'
import { PLogo } from './Combo'
import { dayKey, hhmm, hm, useEntries, type Entry, type PF, type Report, type ReportProject } from './timeData'

/** Цвет ячейки по доле от максимума — «тепловая» таблица из макета. */
const heat = (v: number, mx: number) => (v ? `color-mix(in srgb, var(--heat-hi) ${Math.round((v / Math.max(1, mx)) * 100)}%, var(--heat-lo))` : 'transparent')

/**
 * Часы по людям (доска TimeSheet): люди × проекты за период, клик по
 * человеку — все его записи справа (TimePerson). Числа — свод сервера,
 * обрезанный по границам периода: по нему считают, кому сколько платить.
 */
export function Sheet({
  report,
  loading,
  roleOf,
  q,
  openId,
  onOpen,
  isSel,
  setSel,
  setAll,
}: {
  report: Report | undefined
  loading: boolean
  roleOf: (id: string) => string
  q: string
  openId: string | null
  onOpen: (id: string) => void
  isSel: (id: string) => boolean
  setSel: (id: string, on: boolean) => void
  setAll: (on: boolean) => void
}) {
  const { t } = useTranslation('v2')
  const people = report?.people ?? []
  // «Без проекта» — последним столбцом, как в макете.
  const cols: ReportProject[] = [...(report?.projects ?? [])].sort((a, b) => Number(a.id === null) - Number(b.id === null) || b.minutes - a.minutes)
  const colName = (c: ReportProject) => (c.id ? shortProject(c.name) : t('time.noProject'))
  const val = (p: Report['people'][number], c: ReportProject) => p.projects.find((x) => x.id === c.id)?.minutes ?? 0
  const qq = q.trim().toLowerCase()
  const rows = people.filter((p) => !qq || p.name.toLowerCase().includes(qq))
  let mx = 1
  for (const p of people) for (const c of cols) mx = Math.max(mx, val(p, c))
  const sel = people.filter((p) => isSel(p.userId))
  const allOn = people.length > 0 && sel.length === people.length

  if (loading && !report) return <div className="card empty">{t('time.loading')}</div>
  if (!people.length) return <div className="card empty">{t('time.noHours')}</div>

  return (
    <section className="card" style={{ overflow: 'hidden' }}>
      <div className="sheetw">
        <table className="st">
          <thead>
            <tr>
              <th>
                <span className="hh">
                  <button className={'cbm' + (allOn ? ' on' : '')} onClick={() => setAll(!allOn)} aria-label={t('time.selAll')} aria-pressed={allOn}>
                    <Icon name="check" />
                  </button>
                  {t('time.person')}
                </span>
              </th>
              {cols.map((c) => (
                <th key={c.id ?? 'none'} title={colName(c)}>
                  <span className="hh">
                    <PLogo project={c.id ? { id: c.id, name: c.name, color: c.color, logoUrl: c.logoUrl } : null} />
                    <span className="bidi">{colName(c)}</span>
                  </span>
                </th>
              ))}
              <th>{t('time.totalCol')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const on = isSel(p.userId)
              return (
                <tr key={p.userId} className={openId === p.userId ? 'sel' : ''} onClick={() => onOpen(p.userId)}>
                  <td>
                    <span className="who">
                      <button
                        className={'cbm' + (on ? ' on' : '')}
                        onClick={(e) => {
                          e.stopPropagation()
                          setSel(p.userId, !on)
                        }}
                        aria-label={t('time.selOne', { name: p.name })}
                        aria-pressed={on}
                      >
                        <Icon name="check" />
                      </button>
                      <span className="av" style={{ background: personColor(p.userId) }}>
                        {letterOf(p.name)}
                      </span>
                      <span className="bidi">
                        {p.name}
                        <small>{roleOf(p.userId)}</small>
                      </span>
                    </span>
                  </td>
                  {cols.map((c) => {
                    const v = val(p, c)
                    return (
                      <td key={c.id ?? 'none'}>
                        <span className={'cell' + (v ? '' : ' z')} style={{ background: heat(v, mx) }} title={`${p.name} · ${colName(c)}: ${v ? hm(v) : t('time.cellNone')}`}>
                          {v ? hm(v) : '—'}
                        </span>
                      </td>
                    )
                  })}
                  <td className="tt">
                    <span className="cell">{hm(p.minutes)}</span>
                  </td>
                </tr>
              )
            })}
            {!rows.length && (
              <tr>
                <td colSpan={cols.length + 2} style={{ color: 'var(--ink3)' }}>
                  {t('time.noPerson', { q })}
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td>{t('time.footer', { count: sel.length })}</td>
              {cols.map((c) => (
                <td key={c.id ?? 'none'}>
                  <span className="cell">{hm(sel.reduce((s, p) => s + val(p, c), 0))}</span>
                </td>
              ))}
              <td className="tt">
                <span className="cell">{hm(sel.reduce((s, p) => s + p.minutes, 0))}</span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  )
}

/** Все записи одного человека за период — панель справа (доска TimePerson). */
export function PersonDrawer({
  companyId,
  userId,
  name,
  role,
  range,
  rangeLabel,
  pf,
  pfName,
  onClose,
  onExport,
  paused,
}: {
  paused?: boolean
  companyId: string
  userId: string
  name: string
  role: string
  range: [string, string]
  rangeLabel: string
  pf: PF
  pfName: string | null
  onClose: () => void
  onExport: () => void
}) {
  const { t, i18n } = useTranslation('v2')
  const lng = i18n.language
  const q = useEntries(companyId, range, { userId, pf })
  const list = (q.data?.items ?? []).filter((e) => {
    const k = dayKey(new Date(e.startedAt))
    return e.endedAt && k >= range[0] && k <= range[1]
  })
  const days = [...new Set(list.map((e) => dayKey(new Date(e.startedAt))))].sort().reverse()
  const total = list.reduce((s, e) => s + (e.minutes ?? 0), 0)
  const shown = name || list[0]?.user.name || ''

  useEffect(() => {
    // Поверх открыта выгрузка — Escape закрывает её, а не панель под ней.
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !paused && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, paused])

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drw" aria-label={t('time.drwAria')} role="dialog" aria-modal="true">
        <div className="drw-h">
          <span className="av" style={{ background: personColor(userId) }}>
            {letterOf(shown)}
          </span>
          <div>
            <b className="bidi">{shown}</b>
            <small>{[role, rangeLabel, pf !== 'all' ? pfName : '', hm(total)].filter(Boolean).join(' · ')}</small>
          </div>
          <button className="btn sm" onClick={onExport}>
            {t('time.drwDownload')}
          </button>
          <button className="x" onClick={onClose} aria-label={t('time.close')}>
            <Icon name="close" sm />
          </button>
        </div>
        <div className="drw-b">
          {q.isLoading && <div className="empty">{t('time.loading')}</div>}
          {!q.isLoading && !days.length && <div className="empty">{t('time.drwEmpty')}</div>}
          {days.map((d) => {
            const es = list.filter((e) => dayKey(new Date(e.startedAt)) === d).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
            return (
              <div key={d}>
                <div className="dh">
                  <b>{new Date(`${d}T12:00:00`).toLocaleDateString(lng, { weekday: 'long', month: 'long', day: 'numeric' })}</b>
                  <span className="sp" />
                  <span className="t">{hm(es.reduce((s, e) => s + (e.minutes ?? 0), 0))}</span>
                </div>
                {es.map((e) => (
                  <DrawerRow key={e.id} e={e} lng={lng} />
                ))}
              </div>
            )
          })}
        </div>
      </aside>
    </>
  )
}

function DrawerRow({ e, lng }: { e: Entry; lng: string }) {
  const { t } = useTranslation('v2')
  const s = new Date(e.startedAt)
  const f = new Date(e.endedAt!)
  const next = dayKey(f) !== dayKey(s)
  return (
    <div className="en">
      <span className="tr">
        {hhmm(s)} – {hhmm(f)}
        {next && (
          <span className="nx" title={t('time.endedOn', { d: f.toLocaleDateString(lng, { month: 'short', day: 'numeric' }) })}>
            {t('time.nextDay')}
          </span>
        )}
      </span>
      <span className="du">{hm(e.minutes ?? 0)}</span>
      <span className="pjn">
        <PLogo project={e.project} />
        <span className="bidi">{e.project ? shortProject(e.project.name) : t('time.noProject')}</span>
      </span>
      <div className="bd">
        <div className={'t1 bidi' + (e.task ? '' : ' e')}>
          {e.task && <b>{e.task.number}</b>}
          {e.task ? e.task.title : t('time.noTask')}
        </div>
        {e.description && <div className="t2 bidi">{e.description}</div>}
      </div>
    </div>
  )
}
