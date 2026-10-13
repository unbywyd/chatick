import { useEffect, useMemo, useState } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, logout } from '@/lib/api'
import { LOCALES } from '@/i18n'
import { useTheme } from '@/providers/theme'
import { keys, useCompanies, useInbox, useMe, useProjects, useRunning, useToday, type Notice } from './data'
import { useUi } from './ui'
import { useOpenNotice } from './notices'
import { ProjectLogo } from './ProjectLogo'
import { Icon } from './Icon'
import { fmtClock, fmtHm, letterOf, personColor, projectColor, shortProject, timeAgo } from './util'
import { AboutModal, ReportModal } from './MeModals'

const NAV = ['', 'team', 'docs', 'notes', 'time', 'resources', 'files', 'versions', 'history'] as const
const NAV_LABEL: Record<string, string> = { '': 'tasks', team: 'team', docs: 'docs', notes: 'notes', time: 'time', resources: 'resources', files: 'files', versions: 'versions', history: 'history' }
const PINS_KEY = 'chatick_v2_nav'

/** Какие разделы человек вынес в шапку. По умолчанию — только задачи. */
function readPins(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(PINS_KEY) ?? 'null') as unknown
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && (NAV as readonly string[]).includes(x))
  } catch {
    /* хранилище закрыто — меню по умолчанию */
  }
  return ['']
}

export function Header() {
  const { companyId, base } = useUi()
  const navigate = useNavigate()
  return (
    <header className="hdr">
      {/* Знак — тот же, что у установленного приложения; ведёт к задачам компании. */}
      <button className="hd-logo" aria-label="Chatick" title="Chatick" onClick={() => navigate(base)}>
        <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
      </button>
      <CompanyMenu />
      <SectionsNav />
      <div style={{ flex: 1 }} />
      <TimerPill companyId={companyId} />
      <Bell />
      <MeMenu />
    </header>
  )
}

/**
 * Разделы: в шапке — только то, что человек сам вынес (по умолчанию «Задачи»),
 * остальное — в «⋯». Там же переход на любой раздел и галочки «в шапке».
 * Открытый раздел виден в шапке, даже если не вынесен: иначе непонятно, где ты.
 */
function SectionsNav() {
  const { t } = useTranslation('v2')
  const { base } = useUi()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [pins, setPins] = useState<string[]>(readPins)
  const [open, setOpen] = useState(false)
  const pathOf = (k: string) => (k ? `${base}/${k}` : base)
  const current = NAV.find((k) => (k ? pathname.startsWith(`${base}/${k}`) : pathname === base || pathname.startsWith(`${base}/task`))) ?? null
  const shown = NAV.filter((k) => pins.includes(k) || k === current)
  const toggle = (k: string) => {
    const next = pins.includes(k) ? pins.filter((x) => x !== k) : NAV.filter((x) => x === k || pins.includes(x))
    setPins(next)
    try {
      localStorage.setItem(PINS_KEY, JSON.stringify(next))
    } catch {
      /* не запомним — не страшно */
    }
  }
  return (
    <nav className="nav navw" aria-label={t('navMenu.aria')}>
      {shown.map((k) => (
        <NavLink key={k} to={pathOf(k)} end={!k} className={({ isActive }) => 'nv' + (isActive || k === current ? ' on' : '')}>
          {t(`nav.${NAV_LABEL[k]}`)}
        </NavLink>
      ))}
      <button className="nv nv-more" aria-label={t('navMenu.more')} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="more" />
      </button>
      {open && (
        <>
          <div className="gt-scrim" onClick={() => setOpen(false)} />
          <div className="navpop" role="menu" aria-label={t('navMenu.aria')}>
            <div className="hd">{t('navMenu.head')}</div>
            {NAV.map((k) => (
              <div key={k} className={'navi' + (k === current ? ' cur' : '')}>
                <button
                  className="navgo"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false)
                    navigate(pathOf(k))
                  }}
                >
                  {t(`nav.${NAV_LABEL[k]}`)}
                </button>
                <button
                  className={'navpin' + (pins.includes(k) ? ' on' : '')}
                  role="switch"
                  aria-checked={pins.includes(k)}
                  aria-label={t('navMenu.pin', { name: t(`nav.${NAV_LABEL[k]}`) })}
                  title={t('navMenu.pinHint')}
                  onClick={() => toggle(k)}
                >
                  <i />
                </button>
              </div>
            ))}
            <div className="navft">{t('navMenu.hint')}</div>
          </div>
        </>
      )}
    </nav>
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
            <div className="cdiv" />
            <button
              className="citem plain"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                navigate('/companies')
              }}
            >
              <span className="clg" style={{ background: 'var(--soft)', color: 'var(--ink)' }}>
                <Icon name="grid" sm />
              </span>
              <span className="cb">
                <b>{t('head.allCompanies')}</b>
              </span>
            </button>
            {boss && (
              <>
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
      <Hours />
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
    // Часть блока таймера: сколько набежало сегодня и переход к часам.
    <Link className="gt-today" to={`${base}/time`} aria-label={t('head.toHours')} title={t('head.toHours')}>
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
  const openIt = useOpenNotice()
  const openNotice = (n: Notice) => {
    setOpen(false)
    read.mutate({ ids: [n.id] })
    openIt(n)
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
              {unread.length > 0 && <button onClick={() => read.mutate({ all: true, companyId, ids: unread.map((n) => n.id) })}>{t('bell.readAll')}</button>}
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
  const qc = useQueryClient()
  const [open, setOpenState] = useState(false)
  // Выход — в два нажатия: пункт стоит рядом с «Компанией», и промах выкидывал
  // из аккаунта посреди работы.
  const [sure, setSure] = useState(false)
  const setOpen = (v: boolean) => {
    setOpenState(v)
    if (!v) setSure(false)
  }
  const go = (path: string) => {
    setOpen(false)
    navigate(path)
  }
  // «О программе» и «Сообщить о проблеме». Трей просит первое адресом ?about=1.
  const [modal, setModal] = useState<'about' | 'report' | null>(null)
  const loc = useLocation()
  useEffect(() => {
    const qs = new URLSearchParams(loc.search)
    if (qs.get('about') !== '1') return
    setModal('about')
    qs.delete('about')
    const rest = qs.toString()
    navigate(loc.pathname + (rest ? `?${rest}` : ''), { replace: true })
  }, [loc.search, loc.pathname, navigate])
  // Язык — и интерфейсу, и профилю: на нём сервер пишет письма и уведомления.
  const setLang = (code: string) => {
    void i18n.changeLanguage(code)
    void api('/api/v1/auth/me', { method: 'PATCH', body: JSON.stringify({ locale: code }) })
      .then(() => qc.invalidateQueries({ queryKey: keys.me }))
      .catch(() => {})
  }
  const name = me.data?.name ?? ''
  return (
    <div className="mew">
      {modal === 'about' && <AboutModal onClose={() => setModal(null)} onReport={() => setModal('report')} />}
      {modal === 'report' && <ReportModal onClose={() => setModal(null)} />}
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
                  <button key={l.code} className={i18n.resolvedLanguage === l.code ? 'on' : ''} onClick={() => setLang(l.code)} lang={l.code}>
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
                setOpen(false)
                setModal('report')
              }}
            >
              <Icon name="mail" sm />
              {t('me2.report')}
            </button>
            <button
              className="me-i"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                setModal('about')
              }}
            >
              <Icon name="info" sm />
              {t('me2.aboutTitle')}
            </button>
            <div className="me-d" />
            <button
              className="me-i"
              role="menuitem"
              onClick={() => {
                if (!sure) return setSure(true)
                logout()
                // Кэш — целиком: в нём профиль, компании и задачи ушедшего
                // человека, и следующий на этом компьютере видел их до ответа
                // сервера (до пяти минут). replace — чтобы «назад» не вёл в
                // чужую компанию.
                qc.clear()
                navigate('/login', { replace: true })
              }}
            >
              <Icon name="logout" sm />
              {sure ? t('me.logoutSure') : t('me.logout')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
