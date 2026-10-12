import { useEffect, useMemo, useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, logout } from '@/lib/api'
import { LOCALES } from '@/i18n'
import { useTheme } from '@/providers/theme'
import { keys, useCompanies, useInbox, useMe, useProjects, useRunning, useToday, type Notice } from './data'
import { useUi } from './ui'
import { ProjectLogo } from './ProjectLogo'
import { Icon } from './Icon'
import { fmtClock, fmtHm, letterOf, personColor, projectColor, shortProject, timeAgo } from './util'

export function Header() {
  const { t } = useTranslation('v2')
  const { companyId, base } = useUi()
  const nav: [string, string][] = [
    ['', t('nav.tasks')],
    ['docs', t('nav.docs')],
    ['time', t('nav.time')],
    ['resources', t('nav.resources')],
    ['files', t('nav.files')],
    ['versions', t('nav.versions')],
    ['history', t('nav.history')],
  ]
  return (
    <header className="hdr">
      <CompanyMenu />
      <nav className="nav" aria-label="Sections">
        {nav.map(([path, label]) => (
          <NavLink key={path} to={path ? `${base}/${path}` : base} end={!path} className={({ isActive }) => 'nv' + (isActive ? ' on' : '')}>
            {label}
          </NavLink>
        ))}
      </nav>
      <div style={{ flex: 1 }} />
      <TimerPill companyId={companyId} />
      <Hours />
      <Bell />
      <MeMenu />
    </header>
  )
}

function CompanyMenu() {
  const { t } = useTranslation('v2')
  const { company, base } = useUi()
  const companies = useCompanies()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const boss = company.myRole === 'admin' || company.myRole === 'manager'
  return (
    <div className="cwrap">
      <button className="brand" aria-label={t('head.switchCompany')} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="mark" style={{ background: '#2F6FEB', color: '#fff' }}>
          {company.logoUrl ? <img src={company.logoUrl} alt="" style={{ width: 32, height: 32, borderRadius: 10, objectFit: 'cover' }} /> : letterOf(company.name)}
        </span>
        <span className="bidi">{company.name}</span>
        <Icon name="chevron" sm />
      </button>
      {open && (
        <>
          <div className="gt-scrim" onClick={() => setOpen(false)} />
          <div className="cpop" role="menu" aria-label={t('head.companies')}>
            <div className="hd">{t('head.companies')}</div>
            {(companies.data ?? []).map((c) => (
              <button
                key={c.id}
                className={'citem' + (c.id === company.id ? ' cur' : '')}
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  navigate(`/c/${c.id}`)
                }}
              >
                <span className="clg" style={{ background: personColor(c.id), color: '#fff' }}>
                  {letterOf(c.name)}
                </span>
                <span className="cb">
                  <b className="bidi">{c.name}</b>
                  <small>{t(`me.roles.${c.myRole}`)}</small>
                </span>
                {c.id === company.id && <Icon name="check" />}
              </button>
            ))}
            {boss && (
              <>
                <div className="cdiv" />
                <button
                  className="citem plain"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false)
                    navigate(`${base}/company`)
                  }}
                >
                  <span className="clg" style={{ background: 'var(--moss)', color: 'var(--accent)' }}>
                    <Icon name="people" sm />
                  </span>
                  <span className="cb">
                    <b>{t('head.manage')}</b>
                    <small>{t('head.manageSub')}</small>
                  </span>
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Таймер в шапке — один на человека. Проект выбирается прямо здесь; «вся
 * компания» — время без проекта (v2). Идущий таймер досчитываем на клиенте
 * от startedAt: опрашивать сервер раз в секунду незачем.
 */
function TimerPill({ companyId }: { companyId: string }) {
  const { t } = useTranslation('v2')
  const { company } = useUi()
  const qc = useQueryClient()
  const running = useRunning()
  const projects = useProjects(companyId)
  const [pick, setPick] = useState(false)
  const [q, setQ] = useState('')
  const [chosen, setChosen] = useState<string | null>(() => localStorage.getItem(`chatick_v2_timer_${companyId}`))
  const [, tick] = useState(0)
  const run = running.data
  useEffect(() => {
    if (!run) return
    const id = window.setInterval(() => tick((x) => x + 1), 1000)
    return () => window.clearInterval(id)
  }, [run])

  const current = run ? run.projectId : chosen
  const list = projects.data ?? []
  const cur = current ? list.find((p) => p.id === current) : null
  const label = cur ? shortProject(cur.name) : run?.projectName && run.projectId ? run.projectName : t('timer.company')

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.running })
    void qc.invalidateQueries({ queryKey: keys.today })
  }
  const start = useMutation({
    mutationFn: (projectId: string | null) =>
      api('/api/v1/my/time/start', { method: 'POST', body: JSON.stringify(projectId ? { projectId } : { companyId }) }),
    onSettled: refresh,
  })
  const stop = useMutation({
    mutationFn: (id: string) => api(`/api/v1/my/time/${id}/stop`, { method: 'POST' }),
    onSettled: refresh,
  })
  const choose = (projectId: string | null) => {
    setPick(false)
    setQ('')
    setChosen(projectId)
    if (projectId) localStorage.setItem(`chatick_v2_timer_${companyId}`, projectId)
    else localStorage.removeItem(`chatick_v2_timer_${companyId}`)
    // Выбор проекта и есть старт, как в макете. Таймер уже идёт в другом
    // месте — переносим: остановить и начать заново на новом.
    if (!run) start.mutate(projectId)
    else if (run.projectId !== projectId) stop.mutate(run.id, { onSuccess: () => start.mutate(projectId) })
  }
  const items = useMemo(() => {
    const s = q.trim().toLowerCase()
    return list.filter((p) => !s || p.name.toLowerCase().includes(s))
  }, [list, q])
  const sec = run ? (Date.now() - new Date(run.startedAt).getTime()) / 1000 : 0

  return (
    <div className={'gt' + (run ? ' on' : '')}>
      <button className="gt-proj" onClick={() => setPick(!pick)} aria-label={t('timer.pickAria')} aria-expanded={pick}>
        {cur ? (
          <ProjectLogo project={cur} />
        ) : (
          <span className="logo sm" style={{ background: 'var(--moss)' }}>
            {letterOf(company.name)}
          </span>
        )}
        <span className="nm">{label}</span>
        <Icon name="chevron" sm />
      </button>
      <span className="gt-time">
        {run && <span className="dot live" />}
        {fmtClock(sec)}
      </span>
      <button
        className="gt-go"
        aria-label={run ? t('timer.stop') : t('timer.start')}
        onClick={() => (run ? stop.mutate(run.id) : start.mutate(chosen))}
        disabled={start.isPending || stop.isPending}
      >
        {run ? <Icon name="pause" /> : <Icon name="play" fill />}
      </button>
      {pick && (
        <>
          <div className="gt-scrim" onClick={() => setPick(false)} />
          <div className="gt-pop" role="listbox" aria-label={t('timer.pickAria')}>
            <div className="hd">{t('timer.pickHead')}</div>
            <label className="cbx-s" style={{ margin: '0 4px 6px' }}>
              <Icon name="search" sm />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('timer.find')} aria-label={t('timer.find')} autoFocus />
            </label>
            {!q && (
              <button className={'gp' + (!current ? ' sel' : '')} role="option" aria-selected={!current} onClick={() => choose(null)}>
                <span className="logo sm" style={{ background: 'var(--moss)' }}>
                  {letterOf(company.name)}
                </span>
                <span className="nm">{t('timer.company')}</span>
                {!current && <Icon name="check" />}
              </button>
            )}
            {items.map((p) => (
              <button key={p.id} className={'gp' + (p.id === current ? ' sel' : '')} role="option" aria-selected={p.id === current} onClick={() => choose(p.id)}>
                <ProjectLogo project={p} />
                <span className="nm">{p.name}</span>
                {p.id === current && <Icon name="check" />}
              </button>
            ))}
            {q && !items.length && <div className="cbx-none">{t('timer.none', { q })}</div>}
          </div>
        </>
      )}
    </div>
  )
}

function Hours() {
  const { t } = useTranslation('v2')
  const { base } = useUi()
  const today = useToday()
  const running = useRunning()
  const run = running.data
  const extra = run ? (Date.now() - new Date(run.startedAt).getTime()) / 60000 : 0
  return (
    <Link className="hours" to={`${base}/time`} aria-label={t('head.toHours')}>
      <Icon name="clock" />
      <span>{t('head.today')}</span>
      <b>{fmtHm((today.data ?? 0) + extra)}</b>
      <Icon name="chevronEnd" sm />
    </Link>
  )
}

function Bell() {
  const { t, i18n } = useTranslation('v2')
  const { companyId, base, openTask } = useUi()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const inbox = useInbox(companyId)
  const [open, setOpen] = useState(false)
  const unread = (inbox.data?.items ?? []).filter((n) => !n.readAt)
  const read = useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/api/v1/inbox/read', { method: 'POST', body: JSON.stringify(body) }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['v2', 'inbox'] })
      void qc.invalidateQueries({ queryKey: ['v2', 'ball'] })
    },
  })
  const openNotice = (n: Notice) => {
    setOpen(false)
    read.mutate({ ids: [n.id] })
    if (n.entityType === 'task' && n.entityId) openTask(n.entityId)
  }
  const count = inbox.data?.unreadTotal ?? unread.length
  return (
    <div className="bellw">
      <button className={'bell' + (open ? ' on' : '')} aria-label={t('bell.aria', { n: count })} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="bell" />
        {count > 0 && <span className="bn">{count > 99 ? '99+' : count}</span>}
      </button>
      {open && (
        <>
          <div className="gt-scrim" onClick={() => setOpen(false)} />
          <div className="bpop" role="dialog" aria-label={t('bell.title')}>
            <div className="hd">
              {t('bell.title')}
              {unread.length > 0 && <button onClick={() => read.mutate({ all: true })}>{t('bell.readAll')}</button>}
            </div>
            {unread.slice(0, 6).map((n) => (
              <button key={n.id} className="bi unread" onClick={() => openNotice(n)}>
                <span className="av lg" style={{ background: personColor(n.actor?.id) }}>
                  {letterOf(n.actor?.name ?? 'C')}
                </span>
                <span className="tx">
                  <b>{n.actor?.name ?? 'Chatick'}</b> {n.summary || n.title}
                </span>
                <time>{timeAgo(i18n.language, n.createdAt)}</time>
              </button>
            ))}
            {!unread.length && <div className="cbx-none">{t('bell.empty')}</div>}
            <div className="ft">
              <button
                onClick={() => {
                  setOpen(false)
                  navigate(`${base}/notifications`)
                }}
              >
                {t('bell.all')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

const LANG_SHORT: Record<string, string> = { en: 'Eng', he: 'עב', ru: 'Rus' }

function MeMenu() {
  const { t, i18n } = useTranslation('v2')
  const { base, company } = useUi()
  const me = useMe()
  const { theme, setTheme } = useTheme()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const go = (path: string) => {
    setOpen(false)
    navigate(path)
  }
  const name = me.data?.name ?? ''
  return (
    <div className="mew">
      <button className="me" aria-label={t('me.profileAria')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {me.data?.avatarUrl ? <img src={me.data.avatarUrl} alt="" /> : letterOf(name)}
      </button>
      {open && (
        <>
          <div className="me-scrim" onClick={() => setOpen(false)} />
          <div className="mepop" role="menu" aria-label={t('me.profileAria')}>
            <div className="me-h">
              <span className="me-av">{letterOf(name)}</span>
              <div>
                <b className="bidi">{name}</b>
                <small>
                  {me.data?.email} · {t(`me.roles.${company.myRole}`)}
                </small>
              </div>
            </div>
            <div className="me-r">
              <span>{t('me.language')}</span>
              <div className="me-seg">
                {LOCALES.map((l) => (
                  <button key={l.code} className={i18n.resolvedLanguage === l.code ? 'on' : ''} onClick={() => void i18n.changeLanguage(l.code)} lang={l.code}>
                    {LANG_SHORT[l.code]}
                  </button>
                ))}
              </div>
            </div>
            <div className="me-r">
              <span>{t('me.theme')}</span>
              <div className="me-seg">
                {(['light', 'dark', 'system'] as const).map((th) => (
                  <button key={th} className={theme === th ? 'on' : ''} onClick={() => setTheme(th)}>
                    {th === 'system' ? t('me.auto') : t(`me.${th}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className="me-d" />
            <button className="me-i" role="menuitem" onClick={() => go(`${base}/settings/profile`)}>
              <Icon name="user" sm />
              {t('me.profile')}
            </button>
            <button className="me-i" role="menuitem" onClick={() => go(`${base}/settings/ai`)}>
              <Icon name="spark" sm />
              {t('me.ai')}
            </button>
            {company.myRole === 'admin' && (
              <button className="me-i" role="menuitem" onClick={() => go(`${base}/settings/company`)}>
                <Icon name="building" sm />
                {t('me.company')}
              </button>
            )}
            <div className="me-d" />
            <button
              className="me-i"
              role="menuitem"
              onClick={() => {
                logout()
                navigate('/login')
              }}
            >
              <Icon name="logout" sm />
              {t('me.logout')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
