import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CompanyProject } from '../data'
import { ProjectLogo } from '../ProjectLogo'
import { Icon } from '../Icon'
import { shortProject } from '../util'
import type { PF } from './timeData'

/** Значок «без проекта» — серый, как в макете: это время компании, не проекта. */
export function NoProjectLogo() {
  return <span className="logo sm np">·</span>
}

export function PLogo({ project }: { project: { id: string; name: string; color: string | null; logoUrl?: string | null } | null }) {
  return project ? <ProjectLogo project={project} /> : <NoProjectLogo />
}

/**
 * Выбор проекта с поиском — и фильтр над списком, и проект прямо в строке.
 * В фильтре есть «Все проекты»; «Без проекта» есть всегда: время на компанию
 * (созвоны, почта) — законное место для часов.
 */
export function ProjectCombo({
  value,
  projects,
  onPick,
  small,
  withAll,
}: {
  value: PF
  projects: CompanyProject[]
  onPick: (v: PF) => void
  small?: boolean
  withAll?: boolean
}) {
  const { t } = useTranslation('v2')
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const s = q.trim().toLowerCase()
  type Opt = { k: PF; n: string; p: CompanyProject | null; all?: boolean }
  const opts: Opt[] = [
    ...(withAll ? [{ k: 'all', n: t('time.allProjects'), p: null, all: true }] : []),
    // «Без проекта» — сверху, а не в конце: проектов бывают десятки, и время
    // компании не должно теряться под ними.
    { k: 'none', n: t('time.noProject'), p: null },
    ...projects.map((p) => ({ k: p.id, n: shortProject(p.name), p })),
  ].filter((o) => !s || o.n.toLowerCase().includes(s))
  const cur = value === 'all' ? null : projects.find((p) => p.id === value)
  const curName = value === 'all' ? t('time.allProjects') : value === 'none' ? t('time.noProject') : cur ? shortProject(cur.name) : '—'
  const close = () => {
    setOpen(false)
    setQ('')
  }
  const pick = (k: PF) => {
    close()
    onPick(k)
  }
  const logo = (o: { k: PF; p: CompanyProject | null; all?: boolean }) =>
    o.all ? (
      <span className="logo sm all">
        <Icon name="grid" sm />
      </span>
    ) : (
      <PLogo project={o.p} />
    )
  return (
    <div className="cbx">
      <button
        className={'cbx-f' + (small ? ' sm' : '') + (small && value === 'none' ? ' np' : '')}
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('time.projectAria') + ': ' + curName}
        title={curName}
      >
        {logo({ k: value, p: cur ?? null, all: value === 'all' })}
        <span className="cbx-n bidi">{curName}</span>
        <Icon name="chevron" sm style={{ opacity: 0.6 }} />
      </button>
      {open && (
        <>
          <div className="cbx-scrim" onClick={close} />
          <div className="cbx-pop">
            <label className="cbx-s">
              <Icon name="search" sm />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') close()
                  if (e.key === 'Enter' && opts[0]) pick(opts[0].k)
                }}
                placeholder={t('time.findProject')}
                aria-label={t('time.findProject')}
                autoFocus
              />
            </label>
            <div className="cbx-l" role="listbox">
              {opts.map((o, i) => (
                <button key={o.k} className={'cbx-o' + (i === 0 && s ? ' hi' : '')} role="option" aria-selected={o.k === value} onClick={() => pick(o.k)}>
                  {logo(o)}
                  <span className="cbx-n bidi">{o.n}</span>
                  {o.k === value && <Icon name="check" sm />}
                </button>
              ))}
              {!opts.length && <div className="cbx-none">{t('time.noProjectQ', { q })}</div>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
