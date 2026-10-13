import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useProjects, type Notice } from '../data'
import { noticeTarget, useOpenNotice } from '../notices'
import { useUi } from '../ui'
import { ProjectLogo } from '../ProjectLogo'
import { letterOf, personColor, shortProject, timeAgo } from '../util'
import { useFail } from './parts'
import '../i18n/settings'
import '../styles/settings.css'

type Filter = 'all' | 'unread' | 'pass' | 'mention' | 'comment' | 'sys'
const FILTERS: Filter[] = ['all', 'unread', 'pass', 'mention', 'comment', 'sys']

// Разбор событий сервера (lib/notify.ts) по фильтрам макета. «Ассистента» из
// макета нет: сервер таких уведомлений не шлёт.
const KIND: Record<string, Exclude<Filter, 'all' | 'unread'>> = {
  task_handoff: 'pass',
  task_assigned: 'pass',
  chat_mention: 'mention',
  task_mention: 'mention',
  comment_mention: 'mention',
  note_mention: 'mention',
  task_comment: 'comment',
  checklist_answer: 'comment',
}
const kindOf = (n: Notice) => KIND[n.event] ?? 'sys'
const LIMIT = 200
const PAGE = 40

/**
 * «Все уведомления» — то же, что в колокольчике, но целиком и с фильтрами.
 *
 * Заголовок уведомления пишет сервер на языке получателя в момент рассылки —
 * показываем его как есть, имя автора выделяем. Куда ведёт клик — решает
 * noticeTarget (v2/notices.ts): задача, заметка, документ, часы и т. д.
 */
export function NotificationsView() {
  const { t, i18n } = useTranslation('v2')
  const { companyId, base, openTask, flash } = useUi()
  const qc = useQueryClient()
  const fail = useFail()
  const projects = useProjects(companyId)
  const [f, setFilter] = useState<Filter>('all')
  // Лента длинная (до 200): показываем порциями, чтобы страница не тянулась на метры.
  const [count, setCount] = useState(PAGE)
  const setF = (k: Filter) => {
    setFilter(k)
    setCount(PAGE)
  }
  const inbox = useQuery({
    queryKey: ['v2', 'inbox', companyId, 'all'],
    queryFn: () => api<{ unreadTotal: number; items: Notice[] }>(`/api/v1/inbox?limit=${LIMIT}&companyId=${encodeURIComponent(companyId)}`),
  })
  const read = useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/api/v1/inbox/read', { method: 'POST', body: JSON.stringify(body) }),
    onError: fail,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['v2', 'inbox'] })
      void qc.invalidateQueries({ queryKey: ['v2', 'ball'] })
    },
  })

  const items = useMemo(() => inbox.data?.items ?? [], [inbox.data])
  const byId = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p])), [projects.data])
  const match = (n: Notice, k: Filter) => k === 'all' || (k === 'unread' ? !n.readAt : kindOf(n) === k)
  const matched = items.filter((n) => match(n, f))
  const shown = matched.slice(0, count)
  const unread = inbox.data?.unreadTotal ?? items.filter((n) => !n.readAt).length

  const groups = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const yest = today.getTime() - 86_400_000
    const out: { key: 'today' | 'yest' | 'early'; items: Notice[] }[] = [
      { key: 'today', items: [] },
      { key: 'yest', items: [] },
      { key: 'early', items: [] },
    ]
    for (const n of shown) {
      const at = new Date(n.createdAt).getTime()
      out[at >= today.getTime() ? 0 : at >= yest ? 1 : 2]!.items.push(n)
    }
    return out.filter((g) => g.items.length)
  }, [shown])

  const readAll = () => {
    // «Все» по компании сервер гасит только у уведомлений с проектом —
    // поэтому ещё и видимые непрочитанные по id (у объявлений проекта нет).
    const ids = items.filter((n) => !n.readAt).map((n) => n.id)
    read.mutate({ all: true, companyId }, { onSuccess: () => flash(t('notices.allRead')) })
    if (ids.length) read.mutate({ ids })
  }
  const openIt = useOpenNotice()
  const open = (n: Notice) => {
    if (!n.readAt) read.mutate({ ids: [n.id] })
    openIt(n)
  }

  return (
    <div className="ntf">
      <div className="ph">
        <div>
          <h1>{t('notices.title')}</h1>
          <p>{unread ? t('notices.sub', { count: unread }) : t('notices.subNone')}</p>
        </div>
        <span className="sp" />
        <button className="btn" onClick={readAll} disabled={!unread || read.isPending}>
          {t('notices.readAll')}
        </button>
        <Link className="btn" to={`${base}/settings/notifications`}>
          {t('notices.setup')}
        </Link>
      </div>
      <div className="fb" role="group" aria-label={t('notices.filters')}>
        {FILTERS.map((k) => {
          const c = items.filter((n) => match(n, k)).length
          return (
            <button key={k} className={'fx' + (f === k ? ' on' : '')} aria-pressed={f === k} onClick={() => setF(k)}>
              {t(`notices.f.${k}`)}
              {k !== 'all' && <span className="n">{c}</span>}
            </button>
          )
        })}
      </div>
      <div className="lst">
        {inbox.isLoading && <div className="empty">{t('common.loading')}</div>}
        {inbox.isError && (
          <div className="empty">
            {t('common.error')} · <button onClick={() => void inbox.refetch()}>{t('common.retry')}</button>
          </div>
        )}
        {groups.map((g) => (
          <div key={g.key}>
            <div className="dh">{t(`notices.g.${g.key}`)}</div>
            {g.items.map((n) => {
              const isNew = !n.readAt
              const canOpen = Boolean(noticeTarget(n))
              const p = n.projectId ? byId.get(n.projectId) : undefined
              const ref = /\b[A-Z][A-Z0-9]*-\d+\b/.exec(n.title)?.[0]
              const quote = n.summary || (n.body && n.body !== n.title ? n.body : '')
              const name = n.actor?.name
              const title = name && n.title.startsWith(name) ? n.title.slice(name.length) : n.title
              const hasName = Boolean(name && n.title.startsWith(name))
              const sys = !n.actor
              return (
                <div
                  key={n.id}
                  className={'it' + (isNew ? ' new' : '') + (canOpen ? ' can' : '')}
                  onClick={() => (canOpen ? open(n) : isNew && read.mutate({ ids: [n.id] }))}
                >
                  <span className="ud" aria-hidden="true" />
                  <span className={'av' + (sys ? ' sys' : '')} style={sys ? undefined : { background: personColor(n.actor?.id) }}>
                    {n.actor?.avatarUrl ? <img src={n.actor.avatarUrl} alt="" /> : sys ? '!' : letterOf(name)}
                  </span>
                  <div className="bd">
                    {/* Имя в <bdi>: dir=auto берёт направление по самому заголовку, а латинское
                        имя перед ивритом иначе разворачивало бы строку. */}
                    <div className="t" dir="auto">
                      {hasName && (
                        <bdi>
                          <b>{name}</b>
                        </bdi>
                      )}
                      {title}
                    </div>
                    {quote && (
                      <div className="q" dir="auto">
                        {quote}
                      </div>
                    )}
                    {(p || n.projectName || ref) && (
                      <div className="m">
                        {(p || n.projectName) && <ProjectLogo project={p ?? { id: n.projectId ?? '', name: n.projectName ?? '', color: null }} size="xs" />}
                        {(p || n.projectName) && <span className="pn bidi">{shortProject(p?.name ?? n.projectName ?? '')}</span>}
                        {ref && (
                          <>
                            ·<span className="id">{ref}</span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  <span className="tm">{timeAgo(i18n.language, n.createdAt)}</span>
                  <div className="acts" onClick={(e) => e.stopPropagation()}>
                    {canOpen && (
                      <button className="btn sm" onClick={() => open(n)}>
                        {t('notices.open')}
                      </button>
                    )}
                    {isNew && (
                      <button className="btn sm" onClick={() => read.mutate({ ids: [n.id] })}>
                        {t('notices.markRead')}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ))}
        {inbox.isSuccess && !groups.length && <div className="empty">{f === 'all' ? t('notices.empty') : t('notices.emptyFilter')}</div>}
        {matched.length > count && (
          <button className="btn more" onClick={() => setCount(count + PAGE)}>
            {t('notices.more', { count: Math.min(PAGE, matched.length - count) })}
          </button>
        )}
        {inbox.isSuccess && matched.length <= count && items.length >= LIMIT && <div className="empty" style={{ padding: '20px 0' }}>{t('notices.limit', { count: LIMIT })}</div>}
      </div>
    </div>
  )
}
