import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { api } from '@/lib/api'
import { errorCode, useFromMe, useMe, useMine, useProjects, useRefreshBall, type BallItem, type CompanyProject } from '../data'
import { useUi } from '../ui'
import { ProjectLogo } from '../ProjectLogo'
import { Icon } from '../Icon'
import { useBallActions } from './actions'
import { QuickInput, type QuickInputHandle } from './QuickInput'
import {
  dueDiff,
  dueGroup,
  dueText,
  heatOf,
  heldDays,
  isImportant,
  letterOf,
  moveKey,
  personColor,
  projectColor,
  shortProject,
  waitText,
} from '../util'

type Tab = 'mine' | 'from'
type Focus = 'fresh' | 'prio' | 'late' | 'rev' | 'ans' | 'long'
type SortKey = 'title' | 'prio' | 'mv' | 'due' | 'who' | 'wait'
type GroupBy = 'due' | 'proj' | 'person' | 'none'

const FOCUS: [Focus, string][] = [
  ['fresh', 'sp-new'],
  ['prio', 'sp-prio'],
  ['late', 'sp-late'],
  ['rev', 'sp-rev'],
  ['ans', 'sp-ans'],
  ['long', 'sp-long'],
]
const MOVE_ORDER: Record<string, number> = { review: 0, answer: 1, do: 2, client: 3 }

const pref = <T extends string>(key: string, fallback: T): T => (localStorage.getItem(key) as T | null) ?? fallback

/**
 * Главный экран (v2) — «что на мне и что важнее всего».
 *
 * Стола в этой версии нет: всё, где мяч у меня, — одним списком; задачи «на
 * столе» в нём обычные строки. Фильтры и сортировка — на клиенте, как в
 * макете: список в пределах человека небольшой, и переключение мгновенное.
 */
export function TasksView() {
  const { t, i18n } = useTranslation('v2')
  const { companyId, project, setProject } = useUi()
  const me = useMe()
  const mine = useMine(companyId)
  const fromMe = useFromMe(companyId)
  const projects = useProjects(companyId)
  const [tab, setTabState] = useState<Tab>(() => pref('chatick_v2_tab', 'mine'))
  const [focus, setFocus] = useState<Focus | null>(null)
  const [sortK, setSortK] = useState<SortKey | null>(null)
  const [sortD, setSortD] = useState<1 | -1>(1)
  const [grpBy, setGrpBy] = useState<GroupBy>(() => pref('chatick_v2_group', 'due'))
  const setTab = (v: Tab) => {
    setTabState(v)
    setFocus(null)
    localStorage.setItem('chatick_v2_tab', v)
  }

  const myId = me.data?.id
  const inProj = (i: BallItem) => !project || i.project?.id === project
  const mineAll = mine.data ?? []
  const fromAll = fromMe.data ?? []
  const src = (tab === 'mine' ? mineAll : fromAll).filter(inProj)

  const F: Record<Focus, (i: BallItem) => boolean> = {
    fresh: (i) => i.isNew,
    prio: (i) => isImportant(i.priority),
    late: (i) => dueGroup(i.dueDate) === 'late',
    rev: (i) => i.ball.move === 'review' && !i.ball.waitingClientSince,
    ans: (i) => i.ball.move === 'answer' && !i.ball.waitingClientSince,
    long: (i) => heatOf(i.ball.move, i.ball.heldSince) === 'burn' && !i.ball.waitingClientSince,
  }
  const list = focus ? src.filter(F[focus]) : src

  // «От кого» в «На мне» — кто отдал мяч (последний ход), иначе владелец.
  // В «От меня» — у кого он сейчас.
  const personOf = (i: BallItem) => (tab === 'from' ? i.holder : (i.last?.actor ?? i.owner))

  const groups = useMemo(() => {
    const cmp = (a: BallItem, b: BallItem) => {
      let r = 0
      if (sortK === 'title') r = a.title.localeCompare(b.title)
      else if (sortK === 'mv') r = (MOVE_ORDER[moveKey(a)] ?? 9) - (MOVE_ORDER[moveKey(b)] ?? 9)
      else if (sortK === 'due') r = (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')
      else if (sortK === 'who') r = (personOf(a)?.name ?? '').localeCompare(personOf(b)?.name ?? '')
      else if (sortK === 'wait') r = heldDays(b.ball.heldSince) - heldDays(a.ball.heldSince)
      else if (sortK === 'prio') r = Number(isImportant(b.priority)) - Number(isImportant(a.priority))
      if (sortK) return r * sortD || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')
      return Number(isImportant(b.priority)) - Number(isImportant(a.priority)) || (a.dueDate ?? '').localeCompare(b.dueDate ?? '')
    }
    let G: [string, string][]
    let keyOf: (i: BallItem) => string
    if (grpBy === 'proj') {
      keyOf = (i) => i.project?.id ?? ''
      G = [...new Map(list.map((i) => [keyOf(i), shortProject(i.project?.name ?? '—')])).entries()]
    } else if (grpBy === 'person') {
      keyOf = (i) => personOf(i)?.id ?? ''
      G = [
        ...new Map(
          list.map((i) => {
            const p = personOf(i)
            return [keyOf(i), p ? t(tab === 'from' ? 'tasks.gWith' : 'tasks.gFrom', { name: p.name }) : '—'] as [string, string]
          }),
        ).entries(),
      ]
    } else if (grpBy === 'none') {
      keyOf = () => '*'
      G = [['*', t('tasks.g.all')]]
    } else {
      keyOf = (i) => dueGroup(i.dueDate)
      G = (['late', 'today', 'week', 'later', 'none'] as const).map((k) => [k, t(`tasks.g.${k}`)])
    }
    return G.map(([k, label]) => ({ k, label, rows: list.filter((i) => keyOf(i) === k).sort(cmp) })).filter((g) => g.rows.length)
    // personOf зависит от tab — он в зависимостях через tab
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, grpBy, sortK, sortD, tab, t])

  // Сводка — по «На мне» в выбранном проекте, как в макете.
  const mp = mineAll.filter(inProj)
  const late = mp.filter(F.late).length
  const waitN = mp.filter((i) => (i.ball.move === 'review' || i.ball.move === 'answer') && !i.ball.waitingClientSince).length
  const nProj = new Set(mp.map((i) => i.project?.id)).size
  const parts = [late ? t('tasks.late', { count: late }) : '', waitN ? t('tasks.waiting', { count: waitN }) : ''].filter(Boolean)
  const head = mp.length ? t('tasks.headSome', { count: mp.length }) + (!project ? t('tasks.acrossProjects', { count: nProj }) : '') : t('tasks.headNone')
  const sub = mp.length ? (parts.length ? t('tasks.subStart', { parts: parts.join(', ') }) : t('tasks.subCalm')) : t('tasks.subNone')

  const loading = mine.isLoading || fromMe.isLoading
  const sortBtn = (k: SortKey, label: string) => {
    const on = sortK === k
    return (
      <button
        className={'lh-b' + (on ? ' on' : '')}
        onClick={() => {
          if (!on) {
            setSortK(k)
            setSortD(1)
          } else if (sortD === 1) setSortD(-1)
          else {
            setSortK(null)
            setSortD(1)
          }
        }}
      >
        {label}
        <i>{on ? (sortD === -1 ? '↑' : '↓') : ''}</i>
      </button>
    )
  }
  const GBO: GroupBy[] = ['due', 'proj', 'person', 'none']
  const gbLabel = grpBy === 'person' ? (tab === 'from' ? t('tasks.gb.personTo') : t('tasks.gb.personFrom')) : t(`tasks.gb.${grpBy}`)

  return (
    <div className="wrap">
      <p className="date">{new Date().toLocaleDateString(i18n.language, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      <h1 className="head">{head}</h1>
      <p className="sub">{sub}</p>

      <Carousel projects={projects.data ?? []} counts={mineAll} selected={project} onPick={setProject} />

      <div className="bar">
        <div className="seg" role="tablist">
          <button className={tab === 'mine' ? 'on' : ''} role="tab" aria-selected={tab === 'mine'} onClick={() => setTab('mine')}>
            {t('tasks.tabMine')}
            <span className="n">{mineAll.filter(inProj).length}</span>
          </button>
          <button className={tab === 'from' ? 'on' : ''} role="tab" aria-selected={tab === 'from'} onClick={() => setTab('from')}>
            {t('tasks.tabFrom')}
            <span className="n">{fromAll.filter(inProj).length}</span>
          </button>
        </div>
        <div style={{ flex: 1 }} />
        {FOCUS.map(([f, dot]) => {
          const c = src.filter(F[f]).length
          const on = focus === f
          return (
            <button key={f} className={'fx' + (on ? ' on' : '') + (!c && !on ? ' dim' : '')} aria-pressed={on} onClick={() => setFocus(on ? null : f)}>
              <i className={dot} />
              {t(`tasks.f.${f}`)}
              <span className="n">{c}</span>
            </button>
          )
        })}
      </div>

      <div className="sheet">
        <QuickAdd projects={projects.data ?? []} onCreated={(toMe) => setTab(toMe ? 'mine' : 'from')} />
        <div className={'lh' + (sortK || grpBy !== 'due' ? ' pinned' : '')} role="toolbar">
          <span />
          <span style={{ display: 'flex', gap: 6 }}>
            {sortBtn('title', t('tasks.lh.title'))}
            {sortBtn('prio', t('tasks.lh.prio'))}
          </span>
          <span>{sortBtn('mv', t('tasks.lh.mv'))}</span>
          <span>{sortBtn('due', t('tasks.lh.due'))}</span>
          <span>
            {sortBtn('who', tab === 'from' ? t('tasks.lh.holder') : t('tasks.lh.from'))}
            {sortBtn('wait', t('tasks.lh.wait'))}
          </span>
          <span style={{ textAlign: 'end' }}>
            <button
              className={'lh-g' + (grpBy !== 'due' ? ' on' : '')}
              onClick={() => {
                const next = GBO[(GBO.indexOf(grpBy) + 1) % GBO.length]!
                setGrpBy(next)
                localStorage.setItem('chatick_v2_group', next)
              }}
            >
              {t('tasks.groups', { by: gbLabel })}
              <Icon name="sort" sm />
            </button>
          </span>
        </div>

        {groups.map((g) => (
          <div key={g.k}>
            <div className={'gh' + (grpBy === 'due' && g.k === 'late' ? ' late' : '')}>
              {g.label}
              <span className="n">{g.rows.length}</span>
            </div>
            {g.rows.map((i, n) => (
              <Row key={i.id} item={i} tab={tab} first={n === 0} myId={myId} person={personOf(i)} />
            ))}
          </div>
        ))}
        {!loading && !groups.length && (
          <div className="none">{focus ? t('tasks.noneFilter') : tab === 'mine' ? t('tasks.noneMine') : t('tasks.noneFrom')}</div>
        )}
        {loading && <div className="none">{t('common.loading')}</div>}
      </div>
    </div>
  )
}

/**
 * Проекты сверху — фильтр всего экрана. Сортировка по числу моих задач:
 * где больше работы, тот и ближе. Поиск — когда проектов десятки.
 */
export function Carousel({
  projects,
  counts,
  selected,
  onPick,
}: {
  projects: CompanyProject[]
  counts: { project: { id: string } | null }[]
  selected: string | null
  onPick: (id: string | null) => void
}) {
  const { t } = useTranslation('v2')
  const [q, setQ] = useState('')
  const by = new Map<string, number>()
  for (const c of counts) if (c.project) by.set(c.project.id, (by.get(c.project.id) ?? 0) + 1)
  const sorted = [...projects].sort((a, b) => (by.get(b.id) ?? 0) - (by.get(a.id) ?? 0))
  const s = q.trim().toLowerCase()
  const shown = sorted.filter((p) => !s || p.id === selected || p.name.toLowerCase().includes(s))
  const none = s && !sorted.some((p) => p.name.toLowerCase().includes(s))
  return (
    <div className="sv-proj">
      <div className="car-wrap">
        <label className="car-q">
          <Icon name="search" sm />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQ('')
              if (e.key === 'Enter') {
                const hit = sorted.find((p) => s && p.name.toLowerCase().includes(s))
                if (hit) {
                  onPick(hit.id)
                  setQ('')
                }
              }
            }}
            placeholder={t('car.find')}
            aria-label={t('car.findAria')}
          />
        </label>
        <div className="car" role="tablist" aria-label="Projects">
          <button className={'chip' + (!selected ? ' sel' : '')} role="tab" aria-selected={!selected} onClick={() => onPick(null)} title={t('car.all')}>
            <span className="logo all">
              <Icon name="grid" sm />
            </span>
            <span className="nm">{t('car.all')}</span>
            {counts.length > 0 && <span className="c">{counts.length}</span>}
          </button>
          {shown.map((p) => {
            const n = by.get(p.id) ?? 0
            const sel = selected === p.id
            return (
              <button key={p.id} className={'chip' + (sel ? ' sel' : '') + (!sel && !n ? ' quiet' : '')} role="tab" aria-selected={sel} onClick={() => onPick(sel ? null : p.id)} title={p.name}>
                <ProjectLogo project={p} size="md" />
                <span className="nm">{shortProject(p.name)}</span>
                {n > 0 && <span className="c">{n}</span>}
              </button>
            )
          })}
        </div>
        {none && <span className="car-none">{t('car.none', { q })}</span>}
      </div>
    </div>
  )
}

function Row({ item: i, tab, first, myId, person }: { item: BallItem; tab: Tab; first: boolean; myId?: string; person: BallItem['owner'] }) {
  const { t, i18n } = useTranslation('v2')
  const { openTask } = useUi()
  const a = useBallActions(i, myId)
  const mk = moveKey(i)
  const n = dueDiff(i.dueDate)
  const long = tab === 'mine' && a.mine && heatOf(i.ball.move, i.ball.heldSince) === 'burn' && !i.ball.waitingClientSince
  const fromMeSelf = tab === 'mine' && person?.id === myId
  const wlabel = !person ? '—' : tab === 'from' ? t('tasks.with', { name: person.name }) : fromMeSelf ? t('tasks.yourTask') : t('tasks.from', { name: person.name })
  const wait = i.ball.waitingClientSince
    ? t('wait.since', { date: new Date(i.ball.waitingClientSince).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' }) })
    : waitText(t, i.ball.heldSince)
  const p = i.project
  return (
    <div className={'row' + (first ? ' first' : '') + (i.isNew ? ' fresh' : '')}>
      <ProjectLogo project={p} title={p?.name} />
      <div style={{ minWidth: 0 }}>
        <button className="ttl bidi" onClick={() => openTask(i.id)}>
          {i.title}
        </button>
        {i.isNew && i.last && <div className="nw">{newLine(t, i)}</div>}
        <div className="meta">
          {isImportant(i.priority) && (
            <span className="flag" title={t('tasks.important')}>
              !
            </span>
          )}
          <span className="pn">{p ? shortProject(p.name) : ''}</span>
          <span>{i.number}</span>
        </div>
      </div>
      <div className="mvcell">
        <span className={`mv mv-${mk}`}>
          <i />
          {t(`mv.${mk}`)}
        </span>
        {i.ball.round > 1 && <span className="rnd">{t('round', { n: i.ball.round })}</span>}
      </div>
      <span className={'due' + (n !== null && n < 0 ? ' late' : '') + (n === 0 ? ' today' : '')}>
        {dueText(t, i.dueDate, i18n.language)}
        <small>{n !== null && n < 0 ? t('due.days', { count: -n }) : ''}</small>
      </span>
      <span className="from">
        <span className="av" style={{ background: personColor(person?.id) }}>
          {letterOf(person?.name)}
        </span>
        <span className="bidi">{wlabel}</span>
        <span className={'wt' + (long ? ' long' : '')} title={long ? t('tasks.longTitle') : t('tasks.waitTitle')}>
          {long && <Icon name="hourglass" />}
          {wait}
        </span>
      </span>
      <div className={'acts' + (a.isRev ? ' always' : '')}>
        {a.isRev && (
          <>
            <button className="pass" onClick={a.back}>
              {t('act.return')}
            </button>
            <button className="pass acc" onClick={a.accept}>
              {t('act.accept')}
            </button>
          </>
        )}
        {a.isDo && (
          <button className="pass" onClick={a.toReview}>
            {t('act.review')}
          </button>
        )}
        {a.isAns && (
          <button className="pass acc" onClick={a.answer}>
            {t('act.answer')}
          </button>
        )}
        {a.isClient && (
          <button className="pass" onClick={a.clientReplied}>
            {t('act.clientReplied')}
          </button>
        )}
        {a.isAway && (
          <button className="pass" onClick={a.pass}>
            {t('act.pass')}
          </button>
        )}
      </div>
    </div>
  )
}

/** «Новое» в строке: кто и что сделал, с запиской, если она есть. */
function newLine(t: TFunction, i: BallItem) {
  const who = i.last?.actor?.name ?? ''
  const verb = t(`tasks.nv.${i.last?.action ?? 'pass'}`, { defaultValue: t('tasks.nv.pass') })
  return (
    <>
      <b>{t('tasks.newWord')}</b>
      <span>
        {who} {verb}
        {i.last?.note ? `: “${i.last.note}”` : ''}
      </span>
    </>
  )
}

/**
 * Быстрое создание одной строкой: «что сделать @кому #проект».
 *
 * Пока человек пишет, сервер разбирает строку (preview) — справа видно, куда
 * и кому уйдёт задача. Без # — проект, выбранный в карусели, иначе основной.
 */
function QuickAdd({ projects, onCreated }: { projects: CompanyProject[]; onCreated: (toMe: boolean) => void }) {
  const { t } = useTranslation('v2')
  const { companyId, project, flash, base } = useUi()
  const me = useMe()
  const navigate = useNavigate()
  const refresh = useRefreshBall()
  const input = useRef<QuickInputHandle>(null)
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<{ project: { id: string; name: string; color: string | null }; assignee: { id: string; name: string } | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Ошибку разбора показываем после попытки создать, а не на каждую букву:
  // «напиши, что сделать» под полем, где пишут, только мешает.
  const [tried, setTried] = useState(false)
  const people = useQuery({
    queryKey: ['v2', 'members', companyId],
    queryFn: () => api<{ user: { id: string; name: string } }[]>(`/api/v1/companies/${companyId}/members`).then((r) => r.map((m) => m.user)),
    staleTime: 5 * 60_000,
  })

  useEffect(() => {
    const s = text.trim()
    if (!s) {
      setPreview(null)
      setError(null)
      setTried(false)
      return
    }
    const h = window.setTimeout(() => {
      api<{ preview: NonNullable<typeof preview> }>('/api/v1/ball/quick', {
        method: 'POST',
        body: JSON.stringify({ companyId, text: s, preview: true, projectId: project ?? undefined }),
      })
        .then((r) => {
          setPreview(r.preview)
          setError(null)
        })
        .catch((e: unknown) => {
          setPreview(null)
          setError(parseError(t, e))
        })
    }, 250)
    return () => window.clearTimeout(h)
  }, [text, companyId, project, t])

  const create = useMutation({
    mutationFn: () =>
      api<{ task: { id: string; title: string; project: { name: string }; assignee: { id: string; name: string } | null } }>('/api/v1/ball/quick', {
        method: 'POST',
        body: JSON.stringify({ companyId, text: text.trim(), projectId: project ?? undefined }),
      }),
    onSuccess: (r) => {
      input.current?.clear()
      setText('')
      setPreview(null)
      setTried(false)
      const toMe = !r.task.assignee || r.task.assignee.id === me.data?.id
      flash(toMe ? t('tasks.created', { project: shortProject(r.task.project.name) }) : t('tasks.thrown', { name: r.task.assignee!.name, title: r.task.title }))
      onCreated(toMe)
      refresh()
    },
    onError: (e) => {
      setTried(true)
      setError(parseError(t, e))
    },
  })

  const submit = () => {
    if (!text.trim() || create.isPending) return
    setTried(true)
    create.mutate()
  }
  const pin = preview?.project ?? projects.find((p) => p.id === project) ?? null
  const toMe = !preview?.assignee || preview.assignee.id === me.data?.id
  const who = toMe ? (me.data ? { id: me.data.id, name: me.data.name } : null) : preview!.assignee
  return (
    <>
      <div className="newt">
        <Icon name="plus" style={{ color: 'var(--ink3)' }} />
        <QuickInput
          ref={input}
          placeholder={t('tasks.newPh')}
          people={(people.data ?? []).map((u) => ({ id: u.id, label: u.name, kind: 'person' as const }))}
          projects={projects.map((p) => ({ id: p.id, label: p.name, color: p.color, logoUrl: p.logoUrl, kind: 'project' as const }))}
          emptyPeople={t('tasks.noPerson')}
          emptyProjects={t('tasks.noProject')}
          onChange={setText}
          onSubmit={submit}
          onEscape={() => {
            input.current?.clear()
            setText('')
          }}
        />
        {text.trim() && pin && (
          <span className="pin" title={t('tasks.toProject')}>
            <ProjectLogo project={pin} size="xs" />
            <span className="bidi">{shortProject(pin.name)}</span>
          </span>
        )}
        {text.trim() && who && (
          <span className="qwho" title={t('tasks.toWhom')}>
            <span className="av" style={{ background: personColor(who.id) }}>
              {letterOf(who.name)}
            </span>
            <span className="bidi">{toMe ? t('tasks.toMe') : who.name}</span>
          </span>
        )}
        <button className="mini" onClick={() => navigate(`${base}/task/new`, { state: { title: text.trim(), projectId: pin?.id } })}>
          {t('tasks.details')}
        </button>
      </div>
      {error && tried && text.trim() && (
        <div className="need" role="alert" style={{ margin: '0 16px 8px' }}>
          <Icon name="info" />
          {error}
        </div>
      )}
    </>
  )
}

function parseError(t: TFunction, e: unknown): string {
  const code = errorCode(e)
  const body = (e as { body?: { token?: string; candidates?: { name: string }[]; person?: { name: string }; project?: { name: string } } }).body
  const key = `tasks.parse.${code}`
  const text = t(key, {
    token: body?.token ?? '',
    names: (body?.candidates ?? []).map((c) => c.name).join(', '),
    person: body?.person?.name ?? '',
    project: body?.project?.name ?? '',
    defaultValue: '',
  })
  return text || t(`err.${code}`, { defaultValue: t('err.generic') })
}
