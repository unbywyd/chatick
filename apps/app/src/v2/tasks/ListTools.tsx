import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, previewUrl } from '@/lib/api'
import { inProject, keys, useRefreshBall, type BallItem, type CompanyProject } from '../data'
import { useUi } from '../ui'
import { Icon } from '../Icon'
import { DateField } from '../ui/Calendar'
import { isImportant, shortProject } from '../util'
import { exportBall, downloadTemplate, parseImport, type ImportRow } from './excel'
import { useBallActions, useTableToggle } from './actions'
import '../i18n/list'

const appRoot = () => document.querySelector('.app') ?? document.body

/** Меню, прижатое к точке клика и не вылезающее за край окна. */
function Floating({ x, y, onClose, children, label }: { x: number; y: number; onClose: () => void; children: React.ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ left: Math.min(x, window.innerWidth - r.width - 8), top: Math.min(y, window.innerHeight - r.height - 8) })
  }, [x, y])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <>
      <div className="lt-scrim" onMouseDown={onClose} onContextMenu={(e) => (e.preventDefault(), onClose())} />
      <div ref={ref} className="lt-menu" role="menu" aria-label={label} style={pos}>
        {children}
      </div>
    </>,
    appRoot(),
  )
}

/**
 * Меню по правому клику на строке: открыть, таймер, важность, взять себе,
 * ссылка, удалить. То же, что в первой версии, но ходы мяча — кнопками в
 * строке и в панели, а не здесь.
 */
export function RowMenu({ item, x, y, myId, onClose }: { item: BallItem; x: number; y: number; myId?: string; onClose: () => void }) {
  const { t } = useTranslation('v2')
  const { openTask, flash, base } = useUi()
  const qc = useQueryClient()
  const refresh = useRefreshBall()
  const a = useBallActions(item, myId)
  const toggleTable = useTableToggle()
  const pid = item.project?.id ?? null
  const fail = (e: unknown) => flash(e instanceof Error && e.message ? e.message : t('lt.failed'))
  const run = (fn: () => Promise<unknown>, done?: string) => () => {
    onClose()
    void fn().then(
      () => {
        refresh()
        if (done) flash(done)
      },
      fail,
    )
  }
  const important = isImportant(item.priority)
  const [sure, setSure] = useState(false)
  return (
    <Floating x={x} y={y} onClose={onClose} label={item.title}>
      <button className="lt-i" role="menuitem" onClick={() => (onClose(), openTask(item.id))}>
        <Icon name="expand" sm />
        {t('lt.open')}
      </button>
      {pid && (
        <button
          className="lt-i"
          role="menuitem"
          onClick={run(async () => {
            await api('/api/v1/my/time/start', { method: 'POST', body: JSON.stringify({ projectId: pid, taskId: item.id }) })
            void qc.invalidateQueries({ queryKey: keys.running })
          }, t('lt.timerOn', { id: item.number }))}
        >
          <Icon name="play" sm />
          {t('lt.timer')}
        </button>
      )}
      {pid && (
        <button
          className="lt-i"
          role="menuitem"
          onClick={run(() => api(`/api/v1/tasks/${item.id}`, { method: 'PATCH', body: JSON.stringify({ priority: important ? 'normal' : 'high' }), ...inProject(pid) }))}
        >
          <Icon name="fire" sm />
          {important ? t('lt.unimportant') : t('lt.important')}
        </button>
      )}
      {a.open && item.holder && (a.mine || item.owner?.id === myId) && (
        <button className="lt-i" role="menuitem" onClick={() => (onClose(), void toggleTable(item.id, !item.ball.onTable))}>
          <Icon name="fire" sm />
          {item.ball.onTable ? t('tbl.off') : t('tbl.on')}
        </button>
      )}
      {a.canTake && (
        <button className="lt-i" role="menuitem" onClick={() => (onClose(), a.take())}>
          <Icon name="hand" sm />
          {t('lt.take')}
        </button>
      )}
      <button
        className="lt-i"
        role="menuitem"
        onClick={() => {
          onClose()
          void navigator.clipboard.writeText(previewUrl(`${base}/task/${item.id}`)).then(() => flash(t('lt.copied')), fail)
        }}
      >
        <Icon name="link" sm />
        {t('lt.copy')}
      </button>
      {pid && (
        <>
          <div className="lt-d" />
          {!sure ? (
            <button className="lt-i danger" role="menuitem" onClick={() => setSure(true)}>
              <Icon name="close" sm />
              {t('lt.delete')}
            </button>
          ) : (
            <button className="lt-i danger on" role="menuitem" onClick={run(() => api(`/api/v1/tasks/${item.id}`, { method: 'DELETE', ...inProject(pid) }), t('lt.deleted', { id: item.number }))}>
              <Icon name="close" sm />
              {t('lt.deleteSure')}
            </button>
          )}
        </>
      )}
    </Floating>
  )
}

/**
 * Несколько задач разом: передать одному человеку, поставить важность и
 * срок, удалить. Сервер проверяет права и правила мяча на каждой: то, что
 * нельзя, не делается, и мы говорим, сколько не вышло.
 */
export function BulkBar({ items, onClear }: { items: BallItem[]; onClear: () => void }) {
  const { t } = useTranslation('v2')
  const { companyId, flash } = useUi()
  const refresh = useRefreshBall()
  const [busy, setBusy] = useState(false)
  const [pick, setPick] = useState<null | 'who' | 'due'>(null)
  const [sure, setSure] = useState(false)
  const people = useQuery({
    queryKey: ['v2', 'members', companyId],
    queryFn: () => api<{ user: { id: string; name: string } }[]>(`/api/v1/companies/${companyId}/members`).then((r) => r.map((m) => m.user)),
    staleTime: 5 * 60_000,
  })
  const each = async (fn: (i: BallItem) => Promise<unknown>, done: (n: number) => string) => {
    setBusy(true)
    setPick(null)
    let ok = 0
    for (const i of items) {
      try {
        await fn(i)
        ok++
      } catch {
        /* считаем ниже */
      }
    }
    setBusy(false)
    refresh()
    const bad = items.length - ok
    flash(bad ? `${done(ok)} ${t('lt.notDone', { count: bad })}` : done(ok))
    onClear()
  }
  const patch = (b: Record<string, unknown>) => (i: BallItem) => api(`/api/v1/tasks/${i.id}`, { method: 'PATCH', body: JSON.stringify(b), ...inProject(i.project!.id) })
  const allImportant = items.every((i) => isImportant(i.priority))
  return (
    <div className="lt-bulk" role="toolbar" aria-label={t('lt.bulk', { count: items.length })}>
      <b>{t('lt.bulk', { count: items.length })}</b>
      <div className="lt-bw">
        <button className="mini" disabled={busy} onClick={() => setPick(pick === 'who' ? null : 'who')}>
          {t('lt.pass')}
        </button>
        {pick === 'who' && (
          <div className="lt-pop" role="listbox">
            {(people.data ?? []).map((u) => (
              <button key={u.id} className="lt-i" role="option" aria-selected={false} onClick={() => void each(patch({ assigneeId: u.id }), (n) => t('lt.passed', { count: n, name: u.name }))}>
                <span className="bidi">{u.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="mini" disabled={busy} onClick={() => void each(patch({ priority: allImportant ? 'normal' : 'high' }), (n) => t(allImportant ? 'lt.madeNormal' : 'lt.madeImportant', { count: n }))}>
        {allImportant ? t('lt.unimportant') : t('lt.important')}
      </button>
      <div className="lt-bw">
        <button className="mini" disabled={busy} onClick={() => setPick(pick === 'due' ? null : 'due')}>
          {t('lt.due')}
        </button>
        {pick === 'due' && (
          <div className="lt-pop lt-pop-due">
            <DateField
              value={null}
              ariaLabel={t('lt.due')}
              onChange={(v) => v && void each(patch({ dueDate: new Date(`${v}T12:00:00`).toISOString() }), (n) => t('lt.dueSet', { count: n }))}
            />
            <button className="mini" onClick={() => void each(patch({ dueDate: null }), (n) => t('lt.dueCleared', { count: n }))}>
              {t('lt.noDue')}
            </button>
          </div>
        )}
      </div>
      {!sure ? (
        <button className="mini danger" disabled={busy} onClick={() => setSure(true)}>
          {t('lt.delete')}
        </button>
      ) : (
        <button className="mini danger on" disabled={busy} onClick={() => void each((i) => api(`/api/v1/tasks/${i.id}`, { method: 'DELETE', ...inProject(i.project!.id) }), (n) => t('lt.deletedN', { count: n }))}>
          {t('lt.deleteN', { count: items.length })}
        </button>
      )}
      <span style={{ flex: 1 }} />
      <button className="ib" aria-label={t('lt.clear')} title={t('lt.clear')} onClick={onClear}>
        <Icon name="close" />
      </button>
    </div>
  )
}

/** «⋯» у списка: Excel — выгрузить то, что на экране, загрузить новые задачи, шаблон. */
export function TasksMenu({ items, projects, project, label }: { items: BallItem[]; projects: CompanyProject[]; project: string | null; label: string }) {
  const { t } = useTranslation('v2')
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div className="lt-bw">
      <button className="ib" aria-label={t('lt.more')} title={t('lt.more')} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="more" />
      </button>
      {open && (
        <>
          <div className="lt-scrim" onMouseDown={() => setOpen(false)} />
          <div className="lt-pop lt-pop-end" role="menu">
            <button className="lt-i" role="menuitem" disabled={!items.length} onClick={() => (setOpen(false), exportBall(items, label))}>
              <Icon name="download" sm />
              {t('lt.export', { count: items.length })}
            </button>
            <button className="lt-i" role="menuitem" onClick={() => (setOpen(false), ref.current?.click())}>
              <Icon name="plus" sm />
              {t('lt.import')}
            </button>
            <button className="lt-i" role="menuitem" onClick={() => (setOpen(false), downloadTemplate())}>
              <Icon name="list" sm />
              {t('lt.template')}
            </button>
          </div>
        </>
      )}
      <input
        ref={ref}
        type="file"
        accept=".xlsx,.xls,.csv"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) setFile(f)
        }}
      />
      {file && <ImportModal file={file} projects={projects} project={project} onClose={() => setFile(null)} />}
    </div>
  )
}

function ImportModal({ file, projects, project, onClose }: { file: File; projects: CompanyProject[]; project: string | null; onClose: () => void }) {
  const { t } = useTranslation('v2')
  const { companyId, flash } = useUi()
  const refresh = useRefreshBall()
  const [parsed, setParsed] = useState<{ rows: ImportRow[]; skipped: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const people = useQuery({
    queryKey: ['v2', 'members-full', companyId],
    queryFn: () => api<{ user: { id: string; name: string; email: string } }[]>(`/api/v1/companies/${companyId}/members`).then((r) => r.map((m) => m.user)),
  })
  useEffect(() => {
    if (!people.data) return
    parseImport(file, projects, people.data, project).then(setParsed, () => setErr(t('lt.badFile')))
  }, [file, projects, project, people.data, t])
  const ok = parsed?.rows.filter((r) => r.projectId) ?? []
  const noProject = (parsed?.rows.length ?? 0) - ok.length
  const go = async () => {
    setBusy(true)
    let made = 0
    for (const r of ok) {
      try {
        await api('/api/v1/tasks', {
          method: 'POST',
          body: JSON.stringify({ title: r.title, description: r.description, priority: r.priority, dueDate: r.dueDate, estimateMinutes: r.estimateMinutes, assigneeId: r.assigneeId }),
          ...inProject(r.projectId!),
        })
        made++
      } catch {
        /* считаем ниже */
      }
    }
    setBusy(false)
    refresh()
    flash(made < ok.length ? `${t('lt.imported', { count: made })} ${t('lt.notDone', { count: ok.length - made })}` : t('lt.imported', { count: made }))
    onClose()
  }
  return createPortal(
    <div className="mwrap mwrap-top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={t('lt.import')}>
        <div className="mh">
          <span className="rk">
            <Icon name="plus" />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h3 style={{ marginTop: 8 }}>{t('lt.import')}</h3>
          </div>
          <button className="ib" aria-label={t('lt.clear')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {err && <p className="co-hint" style={{ color: 'var(--signal)' }}>{err}</p>}
        {!parsed && !err && <p className="co-hint">…</p>}
        {parsed && (
          <>
            <p className="co-hint" style={{ color: 'var(--ink)' }}>
              {t('lt.willCreate', { count: ok.length, file: file.name })}
            </p>
            {noProject > 0 && <p className="co-hint">{t('lt.noProjectRows', { count: noProject })}</p>}
            {parsed.skipped > 0 && <p className="co-hint">{t('lt.skipped', { count: parsed.skipped })}</p>}
            <div className="lt-prev">
              {parsed.rows.slice(0, 8).map((r, n) => (
                <div key={n} className={'lt-pr' + (r.projectId ? '' : ' bad')}>
                  <span className="bidi">{r.title}</span>
                  <small className="bidi">
                    {r.projectId ? shortProject(projects.find((p) => p.id === r.projectId)?.name ?? '') : t('lt.noSuchProject', { name: r.projectName || '—' })}
                    {r.assigneeName ? ` · ${r.assigneeId ? r.assigneeName : t('lt.noSuchPerson', { name: r.assigneeName })}` : ''}
                  </small>
                </div>
              ))}
              {parsed.rows.length > 8 && <small className="co-hint">{t('lt.andMore', { count: parsed.rows.length - 8 })}</small>}
            </div>
            <p className="co-hint">{t('lt.importHint')}</p>
          </>
        )}
        <div className="mf">
          <div className="res" />
          <button className="btn" onClick={onClose}>
            {t('lt.cancel')}
          </button>
          <button className={'btn-acc' + (ok.length && !busy ? '' : ' dis')} onClick={() => ok.length && !busy && void go()}>
            {busy ? t('lt.creating') : t('lt.create', { count: ok.length })}
          </button>
        </div>
      </div>
    </div>,
    appRoot(),
  )
}

/** Пусто совсем: не «ничего нет», а с чего начать — задача и ассистент. */
export function EmptyStart({ onQuick }: { onQuick: () => void }) {
  const { t } = useTranslation('v2')
  const { base } = useUi()
  const navigate = useNavigate()
  return (
    <div className="lt-empty">
      <b>{t('lt.emptyH')}</b>
      <p>{t('lt.emptyP')}</p>
      <div className="lt-ea">
        <button className="btn-acc" onClick={() => navigate(`${base}/task/new`)}>
          <Icon name="plus" sm />
          {t('lt.emptyNew')}
        </button>
        <button className="btn" onClick={onQuick}>
          {t('lt.emptyQuick')}
        </button>
      </div>
      <p className="lt-ai">
        <Icon name="spark" sm />
        {t('lt.emptyAi')}{' '}
        <button className="lt-link" onClick={() => navigate(`${base}/settings/ai`)}>
          {t('lt.emptyAiLink')}
        </button>
      </p>
    </div>
  )
}

export type ExtraSort = 'est' | 'created' | 'blk'

/** Сортировки, которым нет места в шапке столбцов: по оценке, по дате создания, заблокированные. */
export function SortMore({ value, dir, onPick }: { value: ExtraSort | null; dir: 1 | -1; onPick: (k: ExtraSort | null) => void }) {
  const { t } = useTranslation('v2')
  const [open, setOpen] = useState(false)
  return (
    <span className="lt-bw">
      <button className={'lh-b' + (value ? ' on' : '')} aria-expanded={open} onClick={() => setOpen(!open)}>
        {value ? t(`lt.sort.${value}`) : t('lt.sortMore')}
        <i>{value ? (dir === -1 ? '↑' : '↓') : '▾'}</i>
      </button>
      {open && (
        <>
          <div className="lt-scrim" onMouseDown={() => setOpen(false)} />
          <div className="lt-pop" role="menu">
            {(['est', 'created', 'blk'] as const).map((k) => (
              <button key={k} className={'lt-i' + (value === k ? ' on' : '')} role="menuitemradio" aria-checked={value === k} onClick={() => (setOpen(false), onPick(k))}>
                {t(`lt.sort.${k}`)}
              </button>
            ))}
            {value && (
              <button className="lt-i" role="menuitem" onClick={() => (setOpen(false), onPick(null))}>
                {t('lt.sortReset')}
              </button>
            )}
          </div>
        </>
      )}
    </span>
  )
}
