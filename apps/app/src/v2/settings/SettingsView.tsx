import { useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, API_URL } from '@/lib/api'
import { LOCALES } from '@/i18n'
import { useTheme } from '@/providers/theme'
import { saveNotifySettings } from '@/lib/notify-settings'
import { browserPermission, requestBrowserPermission, useNotifySettings } from '@/hooks/useSystemNotifications'
import { keys, useMe, useProjects, type CompanyProject } from '../data'
import { useUi } from '../ui'
import { Icon } from '../Icon'
import { letterOf, personColor, timeAgo } from '../util'
import { Confirm, Sw, copyText, upload, useFail } from './parts'
import { CompanySettings } from './CompanySettings'
import '../i18n/settings'
import '../styles/settings.css'

type Tab = 'profile' | 'notifications' | 'ai' | 'company'
const ME_TABS: Tab[] = ['profile', 'notifications', 'ai']

/**
 * Настройки (v2): слева разделы «Вы» и компания, справа карточки.
 *
 * Показываем только то, что сервер действительно умеет. В макете было больше
 * (тихие часы, каналы по каждому событию, список устройств входа) — этого нет
 * на сервере, и переключатель, который ничего не меняет, хуже его отсутствия.
 */
export function SettingsView() {
  const { t } = useTranslation('v2')
  const { tab } = useParams()
  const { company, base } = useUi()
  const me = useMe()
  const navigate = useNavigate()
  const isAdmin = company.myRole === 'admin'
  const cur: Tab = tab === 'notifications' || tab === 'ai' || tab === 'company' ? tab : 'profile'
  // Компания — только админу: прямую ссылку от участника уводим в профиль.
  if (cur === 'company' && !isAdmin) return <Navigate to={`${base}/settings/profile`} replace />
  const go = (k: Tab) => navigate(`${base}/settings/${k}`)
  return (
    <div className="stg">
      <div className="ph">
        <div>
          <h1>{t('settings.title')}</h1>
          <p className="bidi">
            {me.data?.name ? `${me.data.name} · ` : ''}
            {t('settings.roleIn', { role: t(`me.roles.${company.myRole}`), company: company.name })}
          </p>
        </div>
      </div>
      <div className="lay">
        <nav className="side" aria-label={t('settings.navAria')}>
          <span className="k">{t('settings.you')}</span>
          {ME_TABS.map((k) => (
            <button key={k} className={cur === k ? 'on' : ''} aria-current={cur === k ? 'page' : undefined} onClick={() => go(k)}>
              {t(`settings.tabs.${k}`)}
            </button>
          ))}
          {isAdmin && (
            <>
              <span className="k bidi">{company.name}</span>
              <button className={cur === 'company' ? 'on' : ''} aria-current={cur === 'company' ? 'page' : undefined} onClick={() => go('company')}>
                {t('settings.tabs.company')}
                <small>{t('settings.adminBadge')}</small>
              </button>
            </>
          )}
        </nav>
        <div>
          {cur === 'profile' && <Profile />}
          {cur === 'notifications' && <Notify />}
          {cur === 'ai' && <AiConnections />}
          {cur === 'company' && <CompanySettings />}
        </div>
      </div>
    </div>
  )
}

/* ---------------- Профиль ---------------- */

function Profile() {
  const { t, i18n } = useTranslation('v2')
  const { flash } = useUi()
  const qc = useQueryClient()
  const fail = useFail()
  const me = useMe()
  const { theme, setTheme } = useTheme()
  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  // Имя заполняем один раз, когда профиль приехал: иначе фоновое обновление
  // затирает то, что человек набирает.
  useEffect(() => {
    if (me.data && !name) setName(me.data.name)
  }, [me.data, name])

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.me })
    void qc.invalidateQueries({ queryKey: ['me'] })
  }
  const saveName = useMutation({
    mutationFn: (n: string) => api('/api/v1/auth/me', { method: 'PATCH', body: JSON.stringify({ name: n }) }),
    onSuccess: () => {
      refresh()
      flash(t('settings.saved'))
    },
    onError: fail,
  })
  const photo = useMutation({
    mutationFn: (f: File) => upload('/api/v1/auth/me/avatar', f),
    onSuccess: () => {
      refresh()
      flash(t('settings.profile.photoDone'))
    },
    onError: fail,
  })
  // Язык — и интерфейсу, и профилю: на нём сервер пишет уведомления и письма.
  const setLang = (code: string) => {
    void i18n.changeLanguage(code)
    api('/api/v1/auth/me', { method: 'PATCH', body: JSON.stringify({ locale: code }) }).then(refresh, fail)
  }

  const trimmed = name.trim()
  const dirty = Boolean(me.data && trimmed && trimmed !== me.data.name)
  const lang = i18n.resolvedLanguage ?? 'ru'
  return (
    <section className="card sec">
      <h2>{t('settings.profile.title')}</h2>
      <p className="d">{t('settings.profile.sub')}</p>
      <div className="row first">
        <span className="l">{t('settings.profile.photo')}</span>
        <div className="inl">
          <span className="bigav" style={{ background: personColor(me.data?.id) }}>
            {me.data?.avatarUrl ? <img src={me.data.avatarUrl} alt="" /> : letterOf(me.data?.name)}
          </span>
          <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={photo.isPending}>
            {photo.isPending ? t('settings.uploading') : t('settings.upload')}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              // Сбрасываем, иначе тот же файл второй раз не выберется.
              e.target.value = ''
              if (f) photo.mutate(f)
            }}
          />
        </div>
      </div>
      <div className="row">
        <span className="l">{t('settings.profile.name')}</span>
        <div className="inl">
          <label className="f" style={{ width: 300 }}>
            <input
              className="bidi"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && dirty && saveName.mutate(trimmed)}
              aria-label={t('settings.profile.name')}
            />
          </label>
          {dirty && (
            <button className="btn sm pr" onClick={() => saveName.mutate(trimmed)} disabled={saveName.isPending}>
              {t('settings.save')}
            </button>
          )}
        </div>
      </div>
      <div className="row">
        <span className="l">
          {t('settings.profile.email')}
          <small>{t('settings.profile.emailHint')}</small>
        </span>
        <span className="f ro" style={{ width: 300 }} dir="ltr">
          {me.data?.email ?? '—'}
        </span>
      </div>
      <div className="row">
        <span className="l">{t('settings.profile.lang')}</span>
        <div className="radio">
          {LOCALES.map((l) => (
            <button key={l.code} className={lang === l.code ? 'on' : ''} aria-pressed={lang === l.code} lang={l.code} onClick={() => setLang(l.code)}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
      <div className="row">
        <span className="l">{t('settings.profile.theme')}</span>
        <div className="radio">
          {(['light', 'dark', 'system'] as const).map((th) => (
            <button key={th} className={theme === th ? 'on' : ''} aria-pressed={theme === th} onClick={() => setTheme(th)}>
              {t(`settings.profile.themes.${th}`)}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ---------------- Уведомления ---------------- */

// Личные подписки: те же события, что принимает /notifications/prefs.
const MY_EVENTS = ['task_handoff', 'task_assigned', 'comment_mention', 'task_mention', 'chat_mention', 'task_comment', 'task_status', 'task_due'] as const
type MyEvent = (typeof MY_EVENTS)[number]
// Что компания вообще рассылает (lib/notify-config.ts).
const CO_EVENTS = MY_EVENTS
const LEAD_HOURS = [1, 2, 4, 8, 12, 24, 48, 72, 168]

type Agg = Record<MyEvent, { on: number; total: number }>

function Notify() {
  const { t } = useTranslation('v2')
  const { companyId, company, flash } = useUi()
  const qc = useQueryClient()
  const fail = useFail()
  const projects = useProjects(companyId)
  // Подписки сервер хранит по проектам. В v2 проект — только фильтр, поэтому
  // здесь одна галочка на всю компанию: читаем по всем своим проектам и
  // пишем во все сразу. Где-то выключено, а где-то нет — показываем «частично».
  const mine = (projects.data ?? []).filter((p) => (p as CompanyProject & { isMember?: boolean }).isMember !== false && p.myRole)
  const ids = mine.map((p) => p.id)
  const prefs = useQuery({
    queryKey: ['v2', 'notif-prefs', companyId, ids.join(',')],
    enabled: projects.isSuccess,
    queryFn: async () => {
      const res = await Promise.allSettled(
        ids.map((id) => api<{ prefs: Partial<Record<MyEvent, boolean>> }>('/api/v1/notifications/prefs', { headers: { 'X-Project': id } })),
      )
      const agg = Object.fromEntries(MY_EVENTS.map((e) => [e, { on: 0, total: 0 }])) as Agg
      for (const r of res) {
        if (r.status !== 'fulfilled') continue
        for (const e of MY_EVENTS) {
          agg[e].total++
          if (r.value.prefs[e] !== false) agg[e].on++
        }
      }
      return agg
    },
  })
  const toggle = useMutation({
    mutationFn: async ({ event, enabled }: { event: MyEvent; enabled: boolean }) => {
      const res = await Promise.allSettled(
        ids.map((id) =>
          api('/api/v1/notifications/prefs', { method: 'PATCH', body: JSON.stringify({ event, enabled }), headers: { 'X-Project': id } }),
        ),
      )
      const bad = res.find((r) => r.status === 'rejected')
      if (bad && bad.status === 'rejected') throw bad.reason
    },
    onSuccess: () => flash(t('settings.saved')),
    onError: fail,
    onSettled: () => qc.invalidateQueries({ queryKey: ['v2', 'notif-prefs', companyId] }),
  })

  const local = useNotifySettings()
  const [perm, setPerm] = useState(browserPermission)
  const isDesktop = Boolean((window as { chatickDesktop?: unknown }).chatickDesktop)
  const setLocal = (patch: Partial<typeof local>) => saveNotifySettings({ ...local, ...patch })

  const digest = useQuery({
    queryKey: ['v2', 'inbox-prefs'],
    queryFn: () => api<{ dailyDigest: boolean; digestHourUtc: number }>('/api/v1/inbox/prefs'),
  })
  const saveDigest = useMutation({
    mutationFn: (b: { dailyDigest: boolean; digestHourUtc: number }) => api('/api/v1/inbox/prefs', { method: 'PUT', body: JSON.stringify(b) }),
    onSuccess: () => flash(t('settings.saved')),
    onError: fail,
    onSettled: () => qc.invalidateQueries({ queryKey: ['v2', 'inbox-prefs'] }),
  })
  // Сервер хранит час сводки в UTC; человеку показываем его часы.
  const off = Math.round(-new Date().getTimezoneOffset() / 60)
  const utcHour = digest.data?.digestHourUtc ?? 9
  const localHour = (((utcHour + off) % 24) + 24) % 24

  const coCfg = useQuery({
    queryKey: ['v2', 'co-notify', companyId],
    queryFn: () =>
      api<{ config: { events: Partial<Record<MyEvent, boolean>>; dueLeadHours: number }; canEdit: boolean }>(`/api/v1/companies/${companyId}/notify-config`),
  })
  const saveCo = useMutation({
    mutationFn: (b: { events?: Partial<Record<MyEvent, boolean>>; dueLeadHours?: number }) =>
      api(`/api/v1/companies/${companyId}/notify-config`, { method: 'PATCH', body: JSON.stringify(b) }),
    onSuccess: () => flash(t('settings.saved')),
    onError: fail,
    onSettled: () => qc.invalidateQueries({ queryKey: ['v2', 'co-notify', companyId] }),
  })

  const agg = prefs.data
  return (
    <>
      <section className="card sec">
        <h2>{t('settings.notify.title')}</h2>
        <p className="d">{t('settings.notify.sub')}</p>
        {!agg ? (
          <div className="hint">{prefs.isError ? t('common.error') : t('common.loading')}</div>
        ) : (
          <table className="mx">
            <thead>
              <tr>
                <th>{t('settings.notify.event')}</th>
                <th>{t('settings.notify.send')}</th>
              </tr>
            </thead>
            <tbody>
              {MY_EVENTS.map((e) => {
                const a = agg[e]
                const on = a.total > 0 && a.on === a.total
                const mix = a.on > 0 && a.on < a.total
                return (
                  <tr key={e}>
                    <td>
                      {t(`settings.ev.${e}.n`)}
                      <small>{mix ? t('settings.notify.mixed', { on: a.on, total: a.total }) : t(`settings.ev.${e}.d`)}</small>
                    </td>
                    <td>
                      <button
                        className={'cb' + (on ? ' on' : mix ? ' mix' : '')}
                        aria-pressed={mix ? 'mixed' : on}
                        aria-label={t(`settings.ev.${e}.n`)}
                        disabled={toggle.isPending || !a.total}
                        onClick={() => toggle.mutate({ event: e, enabled: !on })}
                      >
                        {mix ? <Icon name="plus" /> : <Icon name="check" />}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          <span className="l">
            {t('settings.notify.digest')}
            <small>{t('settings.notify.digestHint')}</small>
          </span>
          <div className="inl">
            <Sw
              on={digest.data?.dailyDigest ?? true}
              label={t('settings.notify.digest')}
              disabled={!digest.data}
              onChange={(v) => saveDigest.mutate({ dailyDigest: v, digestHourUtc: utcHour })}
            />
            {(digest.data?.dailyDigest ?? true) && (
              <label className="f" style={{ width: 110 }}>
                <select
                  value={localHour}
                  aria-label={t('settings.notify.digestAt')}
                  onChange={(e) => saveDigest.mutate({ dailyDigest: true, digestHourUtc: (((Number(e.target.value) - off) % 24) + 24) % 24 })}
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, '0')}:00
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>
      </section>

      <section className="card sec">
        <h2>{t('settings.notify.deviceTitle')}</h2>
        <p className="d">{t('settings.notify.deviceSub')}</p>
        {!isDesktop && perm !== 'granted' && (
          <div className="row first">
            <span className="l">
              {t('settings.notify.perm')}
              <small>{perm === 'denied' ? t('settings.notify.permDenied') : perm === 'unsupported' ? t('settings.notify.permNo') : t('settings.notify.permAsk')}</small>
            </span>
            {perm === 'default' && (
              <button className="btn sm" style={{ justifySelf: 'start' }} onClick={() => void requestBrowserPermission().then(setPerm)}>
                {t('settings.notify.permAllow')}
              </button>
            )}
          </div>
        )}
        <div className={'row' + (isDesktop || perm === 'granted' ? ' first' : '')}>
          <span className="l">
            {t('settings.notify.popups')}
            <small>{t('settings.notify.popupsHint')}</small>
          </span>
          <Sw on={local.enabled} label={t('settings.notify.popups')} onChange={(v) => setLocal({ enabled: v })} />
        </div>
        <div className="row">
          <span className="l">{t('settings.notify.sound')}</span>
          <Sw on={local.sound} label={t('settings.notify.sound')} disabled={!local.enabled} onChange={(v) => setLocal({ sound: v })} />
        </div>
        <div className="row">
          <span className="l">
            {t('settings.notify.focused')}
            <small>{t('settings.notify.focusedHint')}</small>
          </span>
          <Sw on={local.muteWhenFocused} label={t('settings.notify.focused')} disabled={!local.enabled} onChange={(v) => setLocal({ muteWhenFocused: v })} />
        </div>
      </section>

      {coCfg.data?.canEdit && (
        <section className="card sec">
          <h2>
            {t('settings.notify.coTitle')} <small>{t('settings.adminBadge')}</small>
          </h2>
          <p className="d">{t('settings.notify.coSub', { company: company.name })}</p>
          {CO_EVENTS.map((e, i) => {
            const on = coCfg.data!.config.events[e] !== false
            return (
              <div key={e} className={'row' + (i === 0 ? ' first' : '')}>
                <span className="l">{t(`settings.coEv.${e}`)}</span>
                <Sw on={on} label={t(`settings.coEv.${e}`)} disabled={saveCo.isPending} onChange={(v) => saveCo.mutate({ events: { [e]: v } })} />
              </div>
            )
          })}
          <div className="row">
            <span className="l">
              {t('settings.notify.lead')}
              <small>{t('settings.notify.leadHint')}</small>
            </span>
            <label className="f" style={{ width: 200 }}>
              <select
                value={coCfg.data.config.dueLeadHours}
                disabled={coCfg.data.config.events.task_due === false}
                aria-label={t('settings.notify.lead')}
                onChange={(e) => saveCo.mutate({ dueLeadHours: Number(e.target.value) })}
              >
                {[...new Set([...LEAD_HOURS, coCfg.data.config.dueLeadHours])]
                  .sort((a, b) => a - b)
                  .map((h) => (
                    <option key={h} value={h}>
                      {h % 24 === 0 ? t('settings.notify.days', { count: h / 24 }) : t('settings.notify.hours', { count: h })}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        </section>
      )}
    </>
  )
}

/* ---------------- Подключения ИИ ---------------- */

type BridgeSession = {
  id: string
  clientName: string
  scope: 'company' | 'project' | 'all'
  project: { id: string; name: string } | null
  company: { id: string; name: string } | null
  lastUsedAt: string
  expiresAt: string
  createdAt: string
}

function clientMark(name: string): { bg: string; l: string } {
  const n = name.toLowerCase()
  if (n.includes('claude')) return { bg: '#C96442', l: 'C' }
  if (n.includes('cursor')) return { bg: '#1B1D1A', l: 'Cu' }
  if (n.includes('chatgpt') || n.includes('openai')) return { bg: '#10A37F', l: 'G' }
  return { bg: 'var(--moss)', l: letterOf(name) }
}

function AiConnections() {
  const { t, i18n } = useTranslation('v2')
  const { flash } = useUi()
  const qc = useQueryClient()
  const fail = useFail()
  const [copied, setCopied] = useState<'url' | 'cmd' | null>(null)
  const [asking, setAsking] = useState<string | null>(null)
  const mcpUrl = `${API_URL.replace(/\/$/, '')}/mcp`
  const cmd = `claude mcp add --transport http chatick ${mcpUrl}`
  const sessions = useQuery({
    queryKey: ['v2', 'bridge-sessions'],
    queryFn: () => api<{ items: BridgeSession[] }>('/api/v1/auth/bridge/sessions').then((r) => r.items),
    refetchInterval: 30_000,
  })
  const close = useMutation({
    mutationFn: (id: string) => api(`/api/v1/auth/bridge/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: (_d, id) => {
      const s = sessions.data?.find((x) => x.id === id)
      setAsking(null)
      flash(t('settings.ai.closed', { name: s?.clientName ?? '' }))
    },
    onError: fail,
    onSettled: () => qc.invalidateQueries({ queryKey: ['v2', 'bridge-sessions'] }),
  })
  const copy = (what: 'url' | 'cmd') =>
    void copyText(what === 'url' ? mcpUrl : cmd).then((ok) => {
      if (!ok) return flash(t('settings.copyFail'))
      setCopied(what)
      window.setTimeout(() => setCopied(null), 2000)
    })
  const date = (iso: string) => new Date(iso).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' })

  return (
    <>
      <section className="card sec">
        <h2>{t('settings.ai.title')}</h2>
        <p className="d">{t('settings.ai.sub')}</p>
        <div className="url">
          <span>{mcpUrl}</span>
          <button className="btn sm" onClick={() => copy('url')}>
            {copied === 'url' ? t('settings.copied') : t('settings.copy')}
          </button>
        </div>
        <ul className="how">
          <li>
            <b>claude.ai, Claude Desktop</b> — {t('settings.ai.howWeb')}
          </li>
          <li>
            <b>Claude Code</b> — {t('settings.ai.howCode')}{' '}
            <code>{cmd}</code>{' '}
            <button className="btn sm" onClick={() => copy('cmd')}>
              {copied === 'cmd' ? t('settings.copied') : t('settings.copy')}
            </button>
          </li>
          <li>{t('settings.ai.consent')}</li>
        </ul>
      </section>
      <section className="card sec">
        <h2>{t('settings.ai.listTitle')}</h2>
        <p className="d">{t('settings.ai.listSub')}</p>
        {sessions.isLoading && <div className="hint">{t('common.loading')}</div>}
        {sessions.data?.length === 0 && <div className="hint">{t('settings.ai.none')}</div>}
        {(sessions.data ?? []).map((s) => {
          const m = clientMark(s.clientName)
          const where =
            s.scope === 'all' ? t('settings.ai.scopeAll') : s.scope === 'company' ? (s.company?.name ?? '') : (s.project?.name ?? '')
          return (
            <div key={s.id} className="cn">
              <span className="ico" style={{ background: m.bg }}>
                {m.l}
              </span>
              <div className="bd">
                <b className="bidi">
                  {s.clientName}
                  <span className="tag">{t('settings.ai.live')}</span>
                </b>
                <small>
                  {t('settings.ai.meta', { since: date(s.createdAt), last: timeAgo(i18n.language, s.lastUsedAt) })}
                </small>
                <div className="sc">
                  <span className="bidi">{s.scope === 'project' ? t('settings.ai.scopeProject', { name: where }) : where}</span>
                </div>
              </div>
              {asking !== s.id && (
                <button className="btn sm" onClick={() => setAsking(s.id)}>
                  {t('settings.ai.close')}
                </button>
              )}
              {asking === s.id && (
                <Confirm
                  text={t('settings.ai.confirm', { name: s.clientName })}
                  yes={t('settings.ai.closeYes')}
                  busy={close.isPending}
                  onYes={() => close.mutate(s.id)}
                  onNo={() => setAsking(null)}
                />
              )}
            </div>
          )
        })}
      </section>
    </>
  )
}
