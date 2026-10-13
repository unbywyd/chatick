import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useUi } from './ui'
import { Icon } from './Icon'
import { shortProject } from './util'
import { comboOf, KEY_DEFS, resetBindings, saveBinding, showCombo, useBindings, type KeyAction } from './keys'
import './i18n/list'

type Hit = { id: string; projectId: string | null; projectName: string | null }
type Found = {
  tasks: (Hit & { number: string; title: string; closed: boolean })[]
  docs: (Hit & { title: string })[]
  files: (Hit & { name: string })[]
  resources: (Hit & { name: string })[]
  notes: (Hit & { title: string })[]
}
type Row = { key: string; group: string; label: string; sub?: string; ref?: string; dim?: boolean; run: () => void }

const SEARCH_EVENT = 'chatick:search'
/** Открыть поиск откуда угодно (кнопка в шапке). */
export const openSearch = () => window.dispatchEvent(new Event(SEARCH_EVENT))
export function useSearchOpener(open: () => void) {
  useEffect(() => {
    window.addEventListener(SEARCH_EVENT, open)
    return () => window.removeEventListener(SEARCH_EVENT, open)
  }, [open])
}

const SECTIONS: { path: string; label: string }[] = [
  { path: '', label: 'nav.tasks' },
  { path: '/docs', label: 'nav.docs' },
  { path: '/notes', label: 'nav.notes' },
  { path: '/files', label: 'nav.files' },
  { path: '/resources', label: 'nav.resources' },
  { path: '/versions', label: 'nav.versions' },
  { path: '/time', label: 'nav.time' },
  { path: '/team', label: 'nav.team' },
  { path: '/history', label: 'nav.history' },
  { path: '/notifications', label: 'bell.title' },
]

/**
 * Поиск по Ctrl+K (⌘K): задачи по номеру и названию, документы, заметки,
 * файлы, ресурсы — и переход в любой раздел. Стрелки, Enter, Esc.
 */
export function SearchPalette({ onClose, onKeys }: { onClose: () => void; onKeys: () => void }) {
  const { t } = useTranslation('v2')
  const { companyId, base, openTask, project } = useUi()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const id = setTimeout(() => setDq(q.trim()), 180)
    return () => clearTimeout(id)
  }, [q])
  const found = useQuery({
    queryKey: ['v2', 'search', companyId, dq],
    queryFn: () => api<Found>(`/api/v1/ball/search?companyId=${encodeURIComponent(companyId)}&q=${encodeURIComponent(dq)}`),
    enabled: dq.length >= 2,
    staleTime: 15_000,
  })
  const go = (path: string) => () => {
    onClose()
    navigate(`${base}${path}`)
  }
  const rows = useMemo<Row[]>(() => {
    const s = q.trim().toLowerCase()
    const out: Row[] = []
    const g = t('pal.g.go')
    if (!s || t('pal.newTask').toLowerCase().includes(s))
      out.push({
        key: 'new',
        group: g,
        label: t('pal.newTask'),
        run: () => {
          onClose()
          navigate(`${base}/task/new`, { state: { projectId: project ?? undefined } })
        },
      })
    for (const x of SECTIONS) {
      const label = t(x.label)
      if (!s || label.toLowerCase().includes(s)) out.push({ key: 'go' + x.path, group: g, label, run: go(x.path) })
    }
    const f = found.data
    if (f && dq.length >= 2) {
      for (const x of f.tasks)
        out.push({
          key: 't' + x.id,
          group: t('pal.g.tasks'),
          label: x.title,
          ref: x.number,
          sub: x.projectName ? shortProject(x.projectName) : undefined,
          dim: x.closed,
          run: () => {
            onClose()
            openTask(x.id)
          },
        })
      for (const x of f.docs) out.push({ key: 'd' + x.id, group: t('pal.g.docs'), label: x.title || t('pal.untitled'), sub: shortProject(x.projectName ?? ''), run: go(`/docs/d/${x.projectId}/${x.id}`) })
      for (const x of f.notes) out.push({ key: 'n' + x.id, group: t('pal.g.notes'), label: x.title || t('pal.untitled'), sub: x.projectName ? shortProject(x.projectName) : undefined, run: go(`/notes/n/${x.id}`) })
      for (const x of f.files) out.push({ key: 'f' + x.id, group: t('pal.g.files'), label: x.name, sub: shortProject(x.projectName ?? ''), run: go(`/files/f/${x.projectId}/${x.id}`) })
      for (const x of f.resources) out.push({ key: 'r' + x.id, group: t('pal.g.resources'), label: x.name, sub: shortProject(x.projectName ?? ''), run: go(`/resources/r/${x.projectId}/${x.id}`) })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, dq, found.data, t, base, project])
  useEffect(() => setActive(0), [rows.length, dq])
  useEffect(() => {
    list.current?.querySelector('[data-on="1"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(rows.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      rows[active]?.run()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }
  const searching = dq.length >= 2 && found.isFetching
  const nothing = dq.length >= 2 && found.isSuccess && !rows.some((r) => !r.key.startsWith('go') && r.key !== 'new')

  let last = ''
  return (
    <div className="mwrap pal-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pal" role="dialog" aria-modal="true" aria-label={t('pal.title')}>
        <div className="pal-in">
          <Icon name="search" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder={t('pal.ph')}
            aria-label={t('pal.ph')}
            role="combobox"
            aria-expanded="true"
            aria-controls="pal-list"
            aria-activedescendant={rows[active] ? `pal-${rows[active]!.key}` : undefined}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="pal-list" id="pal-list" role="listbox" ref={list}>
          {rows.map((r, i) => {
            const head = r.group !== last
            last = r.group
            return (
              <div key={r.key}>
                {head && <div className="pal-g">{r.group}</div>}
                <button
                  id={`pal-${r.key}`}
                  role="option"
                  aria-selected={i === active}
                  data-on={i === active ? '1' : undefined}
                  className={'pal-r' + (i === active ? ' on' : '') + (r.dim ? ' dim' : '')}
                  onMouseMove={() => setActive(i)}
                  onClick={r.run}
                >
                  {r.ref && <span className="pal-ref">{r.ref}</span>}
                  <span className="pal-l bidi">{r.label}</span>
                  {r.sub && <span className="pal-s bidi">{r.sub}</span>}
                  {i === active && <Icon name="chevronEnd" sm />}
                </button>
              </div>
            )
          })}
          {searching && <div className="pal-none">{t('common.loading')}</div>}
          {nothing && !searching && <div className="pal-none">{t('pal.none', { q: dq })}</div>}
          {q.trim().length === 1 && <div className="pal-none">{t('pal.more')}</div>}
        </div>
        <div className="pal-ft">
          <span>{t('pal.hint')}</span>
          <button
            onClick={() => {
              onClose()
              onKeys()
            }}
          >
            {t('keys.title')} <kbd>?</kbd>
          </button>
        </div>
      </div>
    </div>
  )
}

/** Шпаргалка горячих клавиш; здесь же их меняют. */
export function KeysSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('v2')
  const keys = useBindings()
  const [rec, setRec] = useState<KeyAction | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    // Запись сочетания — раньше всех остальных обработчиков, чтобы нажатие
    // не сработало как команда.
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (rec) setRec(null)
        else onClose()
        return
      }
      if (!rec) return
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return
      e.preventDefault()
      e.stopPropagation()
      const c = comboOf(e)
      if (!c) return setErr(t('keys.needMod'))
      const other = KEY_DEFS.find((d) => d.id !== rec && keys[d.id] === c)
      if (other) return setErr(t('keys.taken', { combo: showCombo(c), name: t(`keys.a.${other.id}`) }))
      saveBinding(rec, KEY_DEFS.find((d) => d.id === rec)!.combo === c ? null : c)
      setRec(null)
      setErr('')
    }
    window.addEventListener('keydown', on, true)
    return () => window.removeEventListener('keydown', on, true)
  }, [rec, keys, onClose, t])
  return (
    <div className="mwrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal keys" role="dialog" aria-modal="true" aria-label={t('keys.title')}>
        <div className="mh">
          <div style={{ flex: 1 }}>
            <h3>{t('keys.title')}</h3>
            <div className="s">{t('keys.sub')}</div>
          </div>
          <button className="ib" aria-label={t('pal.close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="keys-l">
          {KEY_DEFS.map((d) => (
            <div key={d.id} className="keys-r">
              <span>{t(`keys.a.${d.id}`)}</span>
              <button
                className={'keys-c' + (rec === d.id ? ' rec' : '')}
                aria-label={t('keys.change', { name: t(`keys.a.${d.id}`) })}
                onClick={() => {
                  setErr('')
                  setRec(rec === d.id ? null : d.id)
                }}
              >
                {rec === d.id ? t('keys.press') : <kbd>{showCombo(keys[d.id])}</kbd>}
              </button>
            </div>
          ))}
          <div className="keys-r">
            <span>{t('keys.help')}</span>
            <span className="keys-c st">
              <kbd>?</kbd>
            </span>
          </div>
          <div className="keys-r">
            <span>{t('keys.esc')}</span>
            <span className="keys-c st">
              <kbd>Esc</kbd>
            </span>
          </div>
        </div>
        {err && (
          <div className="need" role="alert">
            {err}
          </div>
        )}
        <div className="keys-ft">
          <span>{t('keys.hint')}</span>
          <button className="btn sm" onClick={() => resetBindings()}>
            {t('keys.reset')}
          </button>
        </div>
      </div>
    </div>
  )
}
