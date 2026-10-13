import { useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueries, useQuery } from '@tanstack/react-query'
import { api, getSessionToken, logout, type CompanyInvite } from '@/lib/api'
import { LOCALES } from '@/i18n'
import { useTheme } from '@/providers/theme'
import { keys, type BallItem, type Company } from '../data'
import { Icon } from '../Icon'
import { dueDiff, firstName, letterOf, personColor, timeAgo } from '../util'
import { AuthFrame, useMeIf } from './Frame'
import { AUTH, setNext } from './paths'

type Mine = { table: BallItem[]; items: BallItem[] }
type Member = { id: string; role: string; user: { id: string; name: string; avatarUrl: string | null } }

/**
 * Выбор компании. Сверху — та, где на человеке больше всего задач: это и
 * есть «где вас сейчас ждут». Цифры живые: мяч по компании (/ball/mine,
 * /ball/from-me) и состав (/companies/:id/members).
 *
 * Код приглашения вида ABC-123 из макета не взят: приглашения приходят
 * ссылкой, кодов у сервера нет. Вместо него — поле для ссылки из письма.
 */
export function CompaniesV2() {
  const signedIn = Boolean(getSessionToken())
  useEffect(() => {
    if (!signedIn) setNext(AUTH.companies)
  }, [signedIn])
  if (!signedIn) return <Navigate to={AUTH.login} replace />
  return (
    <AuthFrame kind="cp">
      <Top />
      <List />
    </AuthFrame>
  )
}

function Top() {
  const { t, i18n } = useTranslation('v2')
  const { theme, setTheme } = useTheme()
  const me = useMeIf(true)
  const navigate = useNavigate()
  const [lang, setLang] = useState(false)
  const current = LOCALES.find((l) => l.code === i18n.resolvedLanguage) ?? LOCALES[0]
  const themes = [
    ['light', t('auth.companies.light'), <Icon key="l" name="sun" sm />],
    ['dark', t('auth.companies.dark'), <Icon key="d" name="moon" sm />],
    ['system', t('auth.companies.system'), <Icon key="s" name="monitor" sm />],
  ] as const
  return (
    <header className="top">
      <div className="wm">
        {/* Знак — тот же, что в шапке и у установленного приложения. */}
        <img className="mk" src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
        Chatick
      </div>
      <div style={{ flex: 1 }} />
      <div className="langw">
        <button className="lang" aria-label={t('auth.companies.language')} aria-expanded={lang} onClick={() => setLang(!lang)}>
          <Icon name="lang" sm />
          {current.label}
          <Icon name="chevron" sm />
        </button>
        {lang && (
          <>
            <div className="lscrim" onClick={() => setLang(false)} />
            <div className="lpop" role="menu">
              {LOCALES.map((l) => (
                <button
                  key={l.code}
                  role="menuitemradio"
                  aria-checked={l.code === current.code}
                  lang={l.code}
                  onClick={() => {
                    setLang(false)
                    void i18n.changeLanguage(l.code)
                  }}
                >
                  {l.label}
                  {l.code === current.code && <Icon name="check" sm />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="seg" role="radiogroup" aria-label={t('auth.companies.theme')}>
        {themes.map(([key, label, icon]) => (
          <button key={key} role="radio" aria-checked={theme === key} aria-label={label} title={label} className={theme === key ? 'on' : ''} onClick={() => setTheme(key)}>
            {icon}
          </button>
        ))}
      </div>
      <span className="me" title={me.data?.name} aria-label={t('auth.companies.profile')}>
        {me.data?.avatarUrl ? <img src={me.data.avatarUrl} alt="" /> : letterOf(me.data?.name)}
      </span>
      <button
        className="out"
        onClick={() => {
          logout()
          navigate(AUTH.login)
        }}
      >
        <Icon name="logout" sm />
        <span>{t('auth.companies.logout')}</span>
      </button>
    </header>
  )
}

function greeting(h: number) {
  if (h < 5) return 'night'
  if (h < 12) return 'morning'
  if (h < 18) return 'day'
  return 'evening'
}

function List() {
  const { t, i18n } = useTranslation('v2')
  const navigate = useNavigate()
  const me = useMeIf(true)
  // Свой запрос, а не useCompanies: здесь нужны и приглашения, которые тот отбрасывает.
  const data = useQuery({
    queryKey: ['v2', 'auth', 'companies'],
    queryFn: () => api<{ companies: Company[]; invites: CompanyInvite[] }>('/api/v1/companies'),
  })
  const companies = data.data?.companies ?? []
  const invites = data.data?.invites ?? []
  // Тот же ключ, что у useMine: открыв компанию, человек увидит список сразу из кэша.
  const mine = useQueries({
    queries: companies.map((c) => ({
      queryKey: keys.mine(c.id),
      queryFn: () => api<Mine>(`/api/v1/ball/mine?companyId=${encodeURIComponent(c.id)}`),
    })),
  })
  const counts = new Map(companies.map((c, i) => [c.id, mine[i]?.data ? mine[i]!.data!.table.length + mine[i]!.data!.items.length : -1]))
  const sorted = useMemo(
    () => [...companies].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || b.projectsCount - a.projectsCount),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [companies, [...counts.values()].join(',')],
  )
  const ownsOne = companies.some((c) => c.isOwner)
  const [link, setLink] = useState('')
  const [linkBad, setLinkBad] = useState(false)

  const openLink = () => {
    // Ссылка из письма: …/#/invite/<токен>. Принимаем и голый токен.
    const s = link.trim()
    const token = s.match(/invite\/([A-Za-z0-9_-]{16,})/)?.[1] ?? (/^[A-Za-z0-9_-]{16,}$/.test(s) ? s : null)
    if (!token) return setLinkBad(true)
    navigate(AUTH.invite(token))
  }

  const now = new Date()
  const day = now.toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' })
  const name = firstName(me.data?.name)

  return (
    <main className="wrap">
      <p className="date">{day.charAt(0).toUpperCase() + day.slice(1)}</p>
      <h1 className="bidi">{t(`auth.companies.${greeting(now.getHours())}`, { name })}</h1>
      <p className="sub">{t('auth.companies.lead')}</p>

      <section className="sec" aria-label={t('auth.companies.title')}>
        <h2>
          {t('auth.companies.where')}
          <span>{companies.length || ''}</span>
        </h2>
        {data.isError && (
          <p className="empty">
            {t('common.error')} · <button onClick={() => void data.refetch()}>{t('common.retry')}</button>
          </p>
        )}
        {data.data && !companies.length && <p className="empty">{t('auth.companies.empty')}</p>}
        <div className="grid">
          {sorted.map((c, i) => (
            <Card key={c.id} company={c} main={i === 0} mine={mine[companies.indexOf(c)]?.data} />
          ))}
          {invites.map((inv) => (
            <button key={inv.id} className="new" onClick={() => navigate(AUTH.invite(inv.token))}>
              <span className="lg" style={{ background: personColor(inv.company.id), color: '#fff' }}>
                {inv.company.logoUrl ? <img src={inv.company.logoUrl} alt="" /> : letterOf(inv.company.name)}
              </span>
              <span>
                <span className="bidi">{inv.company.name}</span> · {t('auth.companies.invited')}
                <small>{t('auth.companies.invitedSub', { role: t(`auth.roles.${inv.role}`) })}</small>
              </span>
            </button>
          ))}
          {data.data && !ownsOne && (
            <button className="new" onClick={() => navigate(AUTH.newco)}>
              <span className="lg">
                <Icon name="plus" />
              </span>
              <span>
                {t('auth.companies.create')}
                <small>{t('auth.companies.createSub')}</small>
              </span>
            </button>
          )}
        </div>
      </section>

      <div className="code">
        <span>{t('auth.companies.link')}</span>
        <input
          value={link}
          dir="ltr"
          onChange={(e) => {
            setLink(e.target.value)
            setLinkBad(false)
          }}
          onKeyDown={(e) => e.key === 'Enter' && openLink()}
          placeholder={t('auth.companies.linkPh')}
          aria-label={t('auth.companies.link')}
        />
        <button onClick={openLink} disabled={!link.trim()}>
          {t('auth.companies.linkGo')}
        </button>
        {linkBad && <span className="err">{t('auth.companies.linkBad')}</span>}
      </div>
    </main>
  )
}

function Card({ company: c, main, mine }: { company: Company; main: boolean; mine: Mine | undefined }) {
  const { t, i18n } = useTranslation('v2')
  const navigate = useNavigate()
  const fromMe = useQuery({
    queryKey: keys.fromMe(c.id),
    queryFn: () => api<{ items: BallItem[] }>(`/api/v1/ball/from-me?companyId=${encodeURIComponent(c.id)}`).then((r) => r.items),
  })
  const members = useQuery({
    queryKey: ['v2', 'auth', 'members', c.id],
    queryFn: () => api<Member[]>(`/api/v1/companies/${encodeURIComponent(c.id)}/members`),
    staleTime: 5 * 60_000,
  })
  const onMe = mine ? [...mine.table, ...mine.items] : []
  const overdue = onMe.filter((x) => (dueDiff(x.dueDate) ?? 0) < 0).length
  // Последнее движение по задачам, которые касаются человека: кто и когда.
  const last = [...onMe, ...(fromMe.data ?? [])]
    .map((x) => x.last)
    .filter((x): x is NonNullable<BallItem['last']> => Boolean(x))
    .sort((a, b) => b.at.localeCompare(a.at))[0]
  const people = members.data ?? []
  const role = t(`auth.roles.${c.myRole}`)
  const roleLine = [c.isOwner ? t('auth.companies.mine') : null, c.isOwner ? role : role.charAt(0).toUpperCase() + role.slice(1), t('auth.companies.projects', { count: c.projectsCount })]
    .filter(Boolean)
    .join(', ')

  return (
    <button
      className={'co' + (main ? ' main' : '')}
      aria-label={t('auth.companies.open', { name: c.name })}
      onClick={() => {
        localStorage.setItem('chatick_v2_company', c.id)
        navigate(`/c/${c.id}`)
      }}
    >
      <div className="ch">
        <span className="lg" style={{ background: personColor(c.id), color: '#fff' }}>
          {c.logoUrl ? <img src={c.logoUrl} alt="" /> : letterOf(c.name)}
        </span>
        <div>
          <div className="nm bidi">{c.name}</div>
          <div className="rl">{roleLine}</div>
        </div>
        <span className="go">
          <Icon name="chevronEnd" />
        </span>
      </div>
      <div className="stats">
        <div className="stat">
          <b>{mine ? onMe.length : '·'}</b>
          <span>{t('auth.companies.onMe')}</span>
        </div>
        <div className={'stat' + (overdue ? ' hot' : '')}>
          <b>{mine ? overdue : '·'}</b>
          <span>{t('auth.companies.overdue')}</span>
        </div>
        <div className="stat">
          <b>{fromMe.data ? fromMe.data.length : '·'}</b>
          <span>{t('auth.companies.fromMe')}</span>
        </div>
      </div>
      <div className="ft">
        {people.length > 0 && (
          <>
            <div className="avs">
              {people.slice(0, 4).map((m) => (
                <i key={m.id} style={{ background: personColor(m.user.id) }}>
                  {m.user.avatarUrl ? <img src={m.user.avatarUrl} alt="" /> : letterOf(m.user.name)}
                </i>
              ))}
            </div>
            <span>{t('auth.companies.people', { count: people.length })}</span>
          </>
        )}
        {mine && !onMe.length && !people.length && <span className="quiet">{t('auth.companies.calm')}</span>}
        {last && (
          <span className="tm bidi">
            {last.actor ? `${firstName(last.actor.name)}, ` : ''}
            {timeAgo(i18n.language, last.at)}
          </span>
        )}
      </div>
    </button>
  )
}
