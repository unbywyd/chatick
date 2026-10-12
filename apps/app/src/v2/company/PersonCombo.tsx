import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { letterOf, personColor } from '../util'

export type PoolPerson = { id: string; name: string; email: string }

/**
 * Выбор человека — комбобокс макета (.cbx): поле, по клику список с поиском
 * по имени и почте, стрелки и Enter. Кнопку можно подменить своей (`trigger`),
 * как у «Сделать админом».
 */
export function PersonCombo({
  cur,
  pool,
  onPick,
  label,
  sub,
  trigger,
}: {
  cur: string | null
  pool: PoolPerson[]
  onPick: (id: string) => void
  label: (name: string) => string
  sub?: (id: string) => string
  trigger?: (open: () => void, expanded: boolean) => React.ReactNode
}) {
  const { t } = useTranslation('v2')
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const s = q.trim().toLowerCase()
  const list = pool.filter((p) => !s || `${p.name} ${p.email}`.toLowerCase().includes(s))
  const at = Math.min(hi, Math.max(0, list.length - 1))
  const close = () => {
    setOpen(false)
    setQ('')
    setHi(0)
  }
  const choose = (id: string) => {
    close()
    onPick(id)
  }
  const c = cur ? pool.find((p) => p.id === cur) : null
  const toggle = () => (open ? close() : setOpen(true))
  return (
    <div className="cbx">
      {trigger ? (
        trigger(toggle, open)
      ) : (
        <button className="cbx-f" onClick={toggle} aria-haspopup="listbox" aria-expanded={open} aria-label={label(c?.name ?? t('company.choose'))}>
          <span className="av pcav" style={{ background: c ? personColor(c.id) : 'var(--soft)' }}>
            {c ? letterOf(c.name) : ''}
          </span>
          <span className="cbx-n">{c?.name ?? t('company.choose')}</span>
          <Icon name="chevron" sm />
        </button>
      )}
      {open && (
        <>
          <div className="cbx-scrim" onClick={close} />
          <div className="cbx-pop">
            <label className="cbx-s">
              <Icon name="search" sm />
              <input
                value={q}
                autoFocus
                onChange={(e) => {
                  setQ(e.target.value)
                  setHi(0)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setHi(Math.min(at + 1, list.length - 1))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setHi(Math.max(at - 1, 0))
                  } else if (e.key === 'Enter') {
                    if (list[at]) choose(list[at].id)
                  } else if (e.key === 'Escape') close()
                }}
                placeholder={t('company.findPh', { n: t('company.peopleN', { count: pool.length }) })}
                aria-label={t('company.findPerson')}
              />
            </label>
            <div className="cbx-l" role="listbox">
              {list.map((p, i) => {
                const note = sub?.(p.id) ?? ''
                return (
                  <button key={p.id} className={'cbx-o' + (i === at ? ' hi' : '')} role="option" aria-selected={p.id === cur} onClick={() => choose(p.id)}>
                    <span className="av pcav" style={{ background: personColor(p.id) }}>
                      {letterOf(p.name)}
                    </span>
                    <span className="cbx-n">{p.name}</span>
                    {note && <small className="pcs">{note}</small>}
                    {p.id === cur && <Icon name="check" sm />}
                  </button>
                )
              })}
              {!list.length && <div className="cbx-none">{t('company.noMatch', { q })}</div>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
