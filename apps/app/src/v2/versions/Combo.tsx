import { useState } from 'react'
import { Icon } from '../Icon'

export type ComboOpt = { id: string; label: string; search?: string; icon: React.ReactNode; meta?: string; sub?: string }

/**
 * Выпадающий выбор с поиском — как в макете (.cbx): проект или человек.
 *
 * Без поиска — группами с заголовками, с поиском — плоским списком: в поиске
 * заголовки только мешают дойти стрелкой до нужного.
 */
export function Combo({
  value,
  curIcon,
  curLabel,
  aria,
  groups,
  findPh,
  noneText,
  onPick,
}: {
  value: string | null
  curIcon: React.ReactNode
  curLabel: string
  aria: string
  groups: { head?: string; opts: ComboOpt[] }[]
  findPh: string
  noneText: (q: string) => string
  onPick: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const s = q.trim().toLowerCase()
  const shown = s
    ? [{ opts: dedupe(groups.flatMap((g) => g.opts)).filter((o) => (o.label + ' ' + (o.search ?? '')).toLowerCase().includes(s)) }]
    : groups.filter((g) => g.opts.length)
  const flat = shown.flatMap((g) => g.opts)
  const at = Math.min(hi, Math.max(0, flat.length - 1))
  const close = () => {
    setOpen(false)
    setQ('')
    setHi(0)
  }
  const choose = (id: string) => {
    close()
    onPick(id)
  }
  let n = -1
  return (
    <div className="cbx">
      <button className="cbx-f" onClick={() => (open ? close() : setOpen(true))} aria-haspopup="listbox" aria-expanded={open} aria-label={aria}>
        {curIcon}
        <span className="cbx-n">{curLabel}</span>
        <Icon name="chevron" sm />
      </button>
      {open && (
        <>
          <div className="cbx-scrim" onClick={close} />
          <div className="cbx-pop">
            <label className="cbx-s">
              <Icon name="search" sm />
              <input
                value={q}
                autoFocus
                placeholder={findPh}
                aria-label={findPh}
                onChange={(e) => {
                  setQ(e.target.value)
                  setHi(0)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setHi(Math.min(at + 1, flat.length - 1))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setHi(Math.max(at - 1, 0))
                  } else if (e.key === 'Enter') {
                    if (flat[at]) choose(flat[at].id)
                  } else if (e.key === 'Escape') {
                    e.stopPropagation()
                    close()
                  }
                }}
              />
            </label>
            <div className="cbx-l" role="listbox">
              {shown.map((g, gi) => (
                <div key={gi}>
                  {g.head && <div className="cbx-h">{g.head}</div>}
                  {g.opts.map((o) => {
                    n++
                    const sel = o.id === value
                    return (
                      <button key={o.id} className={'cbx-o' + (n === at ? ' hi' : '')} role="option" aria-selected={sel} onClick={() => choose(o.id)}>
                        {o.icon}
                        <span className="cbx-n">{o.label}</span>
                        {o.meta && <small>{o.meta}</small>}
                        {o.sub && <small className="pcs">{o.sub}</small>}
                        {sel && <Icon name="check" sm />}
                      </button>
                    )
                  })}
                </div>
              ))}
              {!flat.length && <div className="cbx-none">{noneText(q)}</div>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function dedupe(opts: ComboOpt[]) {
  const seen = new Set<string>()
  return opts.filter((o) => (seen.has(o.id) ? false : (seen.add(o.id), true)))
}
