import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { letterOf, personColor } from '../util'
import { dayKey, useEntries, type Entry, type PF, type Report } from './timeData'
import { asciiName, entryRows, personFromEntries, previewText, saveOne, saveSheets, saveZip, totalRows, type Cols, type Table } from './exportFile'

export type ExPerson = { id: string; name: string; email: string | null; role: string }
type Split = 'files' | 'sheets' | 'flat'
type Det = 'all' | 'sum'
type Fmt = 'xlsx' | 'csv'

/**
 * Окно выгрузки (доска TimeExport). Три режима:
 *  - свои часы — один файл;
 *  - один человек из «Часов по людям» — один файл;
 *  - выбранные люди — файл на каждого (zip), лист на человека или одна таблица.
 * Выбор людей общий с галочками в таблице: что отмечено там, то и уйдёт в файл.
 */
export function ExportDialog({
  companyId,
  companyName,
  range,
  rangeLabel,
  pf,
  pfName,
  one,
  people,
  report,
  isSel,
  setSel,
  setAll,
  onClose,
  notify,
}: {
  companyId: string
  companyName: string
  range: [string, string]
  rangeLabel: string
  pf: PF
  pfName: string | null
  one: ExPerson | null
  people: ExPerson[]
  report: Report | undefined
  isSel: (id: string) => boolean
  setSel: (id: string, on: boolean) => void
  setAll: (on: boolean) => void
  onClose: () => void
  notify: (msg: string) => void
}) {
  const { t, i18n } = useTranslation('v2')
  const [split, setSplit] = useState<Split>('files')
  const [det, setDet] = useState<Det>('all')
  const [fmt, setFmt] = useState<Fmt>('xlsx')
  const [q, setQ] = useState('')
  const many = !one
  const chosen = one ? [one] : people.filter((p) => isSel(p.id))
  // Подробности — записи с сервера: одного человека или всех сразу (тогда режем по выбранным здесь).
  const entries = useEntries(companyId, range, { userId: one?.id, pf, enabled: !many || det === 'all' })
  const list: Entry[] = (entries.data?.items ?? [])
    .filter((e) => {
      const k = dayKey(new Date(e.startedAt))
      return e.endedAt && k >= range[0] && k <= range[1]
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const cols: Cols = {
    person: t('time.col.person'),
    date: t('time.col.date'),
    start: t('time.col.start'),
    endDate: t('time.col.endDate'),
    end: t('time.col.end'),
    hours: t('time.col.hours'),
    project: t('time.col.project'),
    taskNo: t('time.col.taskNo'),
    task: t('time.col.task'),
    note: t('time.col.note'),
    total: t('time.col.total'),
  }
  const noProj = t('time.noProject')
  const lng = i18n.language
  const span = `${range[0]}_${range[1]}`
  const effSplit: Split = fmt === 'csv' && split === 'sheets' ? 'flat' : split
  const totalsOf = (ids: string[]) =>
    one
      ? [personFromEntries(one.id, one.name, list)].filter((p) => p.minutes > 0)
      : (report?.people ?? []).filter((p) => ids.includes(p.userId))

  const tableFor = (p: ExPerson, i: number): Table => ({
    name: p.name,
    file: `hours-${asciiName(p.email, p.name) || `person-${i + 1}`}-${span}`,
    rows: det === 'all' ? entryRows(list.filter((e) => e.userId === p.id), cols, lng, noProj, false) : totalRows(totalsOf([p.id]), cols, noProj),
  })

  const ids = chosen.map((p) => p.id)
  const flatRows = det === 'all' ? entryRows(list.filter((e) => ids.includes(e.userId)), cols, lng, noProj, true) : totalRows(totalsOf(ids), cols, noProj)
  const busy = det === 'all' && entries.isFetching && !entries.data
  const empty = flatRows.length < 2

  const go = () => {
    if (!chosen.length || busy) return
    if (empty) return notify(t('time.ex.nothing'))
    let f: string
    if (one) {
      const tb = tableFor(one, 0)
      saveOne(tb, fmt)
      f = `${tb.file}.${fmt}`
    } else if (effSplit === 'flat') {
      f = `hours-${asciiName(companyName) || 'company'}-${span}`
      saveOne({ name: companyName, file: f, rows: flatRows }, fmt)
      f += `.${fmt}`
    } else {
      // Пустых людей в архив и книгу не кладём: файл «только заголовок» только путает.
      const tables = chosen.map(tableFor).filter((tb) => tb.rows.length > 1)
      f = `hours-${asciiName(companyName) || 'company'}-${span}`
      if (effSplit === 'files') {
        saveZip(tables, fmt, f)
        f += '.zip'
      } else {
        saveSheets(tables, f)
        f += '.xlsx'
      }
    }
    onClose()
    notify(t('time.ex.done', { f }))
  }

  const fmtLabel = many && effSplit === 'files' ? 'ZIP' : fmt === 'xlsx' ? 'Excel' : 'CSV'
  const cta = !chosen.length
    ? t('time.ex.pick')
    : busy
      ? t('time.ex.collecting')
      : one
        ? t('time.ex.goOne', { name: one.name, fmt: fmtLabel })
        : t('time.ex.goMany', { count: chosen.length, fmt: fmtLabel })

  const qq = q.trim().toLowerCase()
  const sug = qq ? people.filter((p) => !isSel(p.id) && p.name.toLowerCase().includes(qq)).slice(0, 8) : []
  const anyMatch = qq && people.some((p) => p.name.toLowerCase().includes(qq))
  const splits: [Split, string, string][] = !many
    ? []
    : [
        ['files', t('time.ex.files'), t('time.ex.filesD')],
        ...(fmt === 'xlsx' ? ([['sheets', t('time.ex.sheets'), t('time.ex.sheetsD')]] as [Split, string, string][]) : []),
        ['flat', t('time.ex.flat'), t('time.ex.flatD')],
      ]

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="mdl" role="dialog" aria-modal="true" aria-label={t('time.ex.title')}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h3 style={{ flex: 1 }}>{t('time.ex.title')}</h3>
          <button className="x" onClick={onClose} aria-label={t('time.close')}>
            <Icon name="close" sm />
          </button>
        </div>
        <div style={{ fontSize: 14, color: 'var(--ink2)' }} className="bidi">
          {t('time.ex.range', { r: rangeLabel })}
          {pf === 'all' ? t('time.ex.allProj') : t('time.ex.proj', { p: pfName ?? '' })}
        </div>

        {many && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span className="k" style={{ margin: 0, flex: 1 }}>
                {t('time.ex.who', { sel: chosen.length, n: people.length })}
              </span>
              <button className="btn sm" onClick={() => setAll(true)}>
                {t('time.ex.all')}
              </button>
              <button className="btn sm" onClick={() => setAll(false)}>
                {t('time.ex.clear')}
              </button>
            </div>
            <div className="cbx">
              <div className="tokf">
                {chosen.slice(0, 8).map((p) => (
                  <span className="tok" key={p.id}>
                    <span className="av" style={{ background: personColor(p.id) }}>
                      {letterOf(p.name)}
                    </span>
                    <span className="bidi">{p.name}</span>
                    <button onClick={() => setSel(p.id, false)} aria-label={t('time.ex.remove', { name: p.name })}>
                      ×
                    </button>
                  </span>
                ))}
                {chosen.length > 8 && <span className="tmore">{t('time.ex.more', { count: chosen.length - 8 })}</span>}
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && sug[0]) {
                      setSel(sug[0].id, true)
                      setQ('')
                    }
                    if (e.key === 'Escape' && q) {
                      e.stopPropagation()
                      setQ('')
                    }
                    if (e.key === 'Backspace' && !q && chosen.length) setSel(chosen[chosen.length - 1]!.id, false)
                  }}
                  placeholder={t('time.ex.add')}
                  aria-label={t('time.ex.add')}
                />
              </div>
              {qq && (
                <div className="cbx-pop">
                  <div className="cbx-l">
                    {sug.map((p, i) => (
                      <button
                        key={p.id}
                        className={'cbx-o' + (i === 0 ? ' hi' : '')}
                        onClick={() => {
                          setSel(p.id, true)
                          setQ('')
                        }}
                      >
                        <span className="av" style={{ background: personColor(p.id), width: 24, height: 24, fontSize: 10.5 }}>
                          {letterOf(p.name)}
                        </span>
                        <span className="cbx-n">{p.name}</span>
                        <small>{p.role}</small>
                      </button>
                    ))}
                    {!sug.length && <div className="cbx-none">{anyMatch ? t('time.ex.allSelected', { q }) : t('time.ex.noMatch', { q })}</div>}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <div>
          <span className="k">{t('time.ex.layout')}</span>
          <div className="opt">
            {!many ? (
              <button className="on">
                <span className="rd" />
                <span>
                  <b>{t('time.ex.one')}</b>
                  <small>{t('time.ex.oneD')}</small>
                </span>
              </button>
            ) : (
              splits.map(([k, n, d]) => (
                <button key={k} className={effSplit === k ? 'on' : ''} onClick={() => setSplit(k)} aria-pressed={effSplit === k}>
                  <span className="rd" />
                  <span>
                    <b>{n}</b>
                    <small>{d}</small>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: 1 }}>
            <span className="k">{t('time.ex.detail')}</span>
            <div className="seg" style={{ display: 'inline-flex' }}>
              <button className={det === 'all' ? 'on' : ''} onClick={() => setDet('all')}>
                {t('time.ex.detAll')}
              </button>
              <button className={det === 'sum' ? 'on' : ''} onClick={() => setDet('sum')}>
                {t('time.ex.detSum')}
              </button>
            </div>
          </div>
          <div>
            <span className="k">{t('time.ex.format')}</span>
            <div className="seg" style={{ display: 'inline-flex' }}>
              <button className={fmt === 'xlsx' ? 'on' : ''} onClick={() => setFmt('xlsx')}>
                Excel
              </button>
              <button className={fmt === 'csv' ? 'on' : ''} onClick={() => setFmt('csv')}>
                CSV
              </button>
            </div>
          </div>
        </div>

        <div className="prev">{busy ? t('time.ex.collecting') : empty ? t('time.ex.nothing') : previewText(flatRows)}</div>
        <button className={'btn pr' + (!chosen.length || busy ? ' dis' : '')} style={{ justifyContent: 'center', height: 46 }} onClick={go} disabled={!chosen.length || busy}>
          {cta}
        </button>
      </div>
    </>
  )
}
