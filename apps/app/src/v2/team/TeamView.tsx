import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { BallItem, ProjectRef } from '../data'
import { useUi } from '../ui'
import { Icon } from '../Icon'
import { ProjectLogo } from '../ProjectLogo'
import { dueDiff, dueText, fmtHm, letterOf, personColor, shortProject } from '../util'
import '../i18n/project'

type Person = {
  id: string
  name: string
  avatarUrl: string | null
  jobTitle: string | null
  open: number
  review: number
  answer: number
  late: number
  now: { startedAt: string; project: ProjectRef | null; task: { id: string; number: string; title: string } | null } | null
}

/** Минуты с начала — для «работает уже 1:20». Тикает раз в минуту. */
function useMinutes(since: string | null) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!since) return
    const h = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(h)
  }, [since])
  return since ? Math.max(0, (now - new Date(since).getTime()) / 60_000) : 0
}

/**
 * Команда: кто что делает и сколько на ком. Без статистики первой версии —
 * только то, что нужно, чтобы понять, кого не трогать и кого спросить.
 * Видно всем в компании; цифры — по проектам, которые видишь ты.
 */
export function TeamView() {
  const { t } = useTranslation('v2')
  const { companyId } = useUi()
  const [sel, setSel] = useState<string | null>(null)
  const q = useQuery({
    queryKey: ['v2', 'team', companyId],
    queryFn: () => api<{ people: Person[] }>(`/api/v1/ball/team?companyId=${encodeURIComponent(companyId)}`).then((r) => r.people),
    refetchInterval: 60_000,
  })
  const people = q.data ?? []
  const busy = people.filter((p) => p.now).length
  const person = sel ? people.find((p) => p.id === sel) : null
  return (
    <>
      <div className="wrap">
        <div className="rh">
          <div>
            <h1 className="head">{t('team.title')}</h1>
            <p className="sub">{q.data ? t('team.sub', { count: people.length, busy }) : '…'}</p>
          </div>
        </div>
        <div className="co-tbl" style={{ marginTop: 18 }}>
          <div className="tm-row tm-h">
            <span>{t('team.col.person')}</span>
            <span>{t('team.col.now')}</span>
            <span>{t('team.col.open')}</span>
            <span>{t('team.col.review')}</span>
            <span>{t('team.col.answer')}</span>
            <span>{t('team.col.late')}</span>
          </div>
          {q.isLoading && <div className="none">…</div>}
          {people.map((p) => (
            <button key={p.id} className={'tm-row' + (sel === p.id ? ' sel' : '')} onClick={() => setSel(p.id)} aria-label={t('team.openAria', { name: p.name })}>
              <span className="co-pj">
                <span className="av lg" style={{ background: personColor(p.id) }}>
                  {p.avatarUrl ? <img src={p.avatarUrl} alt="" /> : letterOf(p.name)}
                </span>
                <span>
                  <b className="bidi">{p.name}</b>
                  <small className="bidi">{p.jobTitle || ' '}</small>
                </span>
              </span>
              <Now now={p.now} />
              <span className={'tm-n' + (p.open ? '' : ' zero')}>{p.open}</span>
              <span className={'tm-n' + (p.review ? ' rev' : ' zero')}>{p.review}</span>
              <span className={'tm-n' + (p.answer ? ' ask' : ' zero')}>{p.answer}</span>
              <span className={'tm-n' + (p.late ? ' late' : ' zero')}>{p.late}</span>
            </button>
          ))}
        </div>
      </div>
      {person && <PersonTasks key={person.id} person={person} onClose={() => setSel(null)} />}
    </>
  )
}

function Now({ now }: { now: Person['now'] }) {
  const { t } = useTranslation('v2')
  const min = useMinutes(now?.startedAt ?? null)
  if (!now) return <span className="tm-now idle">—</span>
  const what = now.task ? `${now.task.number} · ${now.task.title}` : now.project ? shortProject(now.project.name) : t('team.company')
  return (
    <span className="tm-now">
      <i />
      <span className="bidi">{what}</span>
      <time>{fmtHm(min)}</time>
    </span>
  )
}

/** Задачи человека — по щелчку. Каждая открывается обычной панелью задачи. */
function PersonTasks({ person, onClose }: { person: Person; onClose: () => void }) {
  const { t, i18n } = useTranslation('v2')
  const { companyId, openTask } = useUi()
  const q = useQuery({
    queryKey: ['v2', 'team-tasks', companyId, person.id],
    queryFn: () =>
      api<{ items: BallItem[] }>(`/api/v1/ball/all?companyId=${encodeURIComponent(companyId)}&holder=${encodeURIComponent(person.id)}`).then((r) => r.items),
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const items = q.data ?? []
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <section className="panel" aria-label={person.name}>
        <div className="ph">
          <span className="av" style={{ background: personColor(person.id) }}>
            {letterOf(person.name)}
          </span>
          <span className="pn bidi">{person.name}</span>
          <span style={{ flex: 1 }} />
          <button className="ib" aria-label={t('me2.close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="pb">
          <h3 className="sec">{t('team.tasks', { count: items.length })}</h3>
          {q.isLoading && <p className="co-hint">…</p>}
          {!q.isLoading && !items.length && <p className="co-hint">{t('team.noTasks')}</p>}
          <div className="tm-list">
            {items.map((x) => {
              const n = dueDiff(x.dueDate)
              return (
                <button key={x.id} className="tm-task" onClick={() => openTask(x.id)}>
                  <span className="tm-t bidi">{x.title}</span>
                  <span className="tm-m">
                    {x.project && <ProjectLogo project={x.project} />}
                    <span>{x.number}</span>
                    <span className={`mv mv-${x.ball.move}`}>
                      <i />
                      {t(`mv.${x.ball.waitingClientSince ? 'client' : x.ball.move}`)}
                    </span>
                    {x.dueDate && <span className={'due' + (n !== null && n < 0 ? ' late' : '')}>{dueText(t, x.dueDate, i18n.language)}</span>}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </section>
    </>
  )
}
