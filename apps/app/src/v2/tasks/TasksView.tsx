import { useEffect, useMemo, useRef, useState } from 'react'
import { ShareTask } from '../ShareTask'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { api } from '@/lib/api'
import {
  errorCode,
  useAllTasks,
  useClosed,
  useClosedCount,
  useFromMe,
  useMe,
  useMine,
  useProjects,
  useRefreshBall,
  type BallItem,
  type CompanyProject,
} from '../data'
import { useUi } from '../ui'
import { ProjectLogo } from '../ProjectLogo'
import { Icon } from '../Icon'
import { useBallActions } from './actions'
import { QuickInput, type QuickInputHandle } from './QuickInput'
import { DueCell, MoveCell, PersonCell, PrioFlag } from './RowEdit'
import { orderProjects, ProjectPrefsPanel, useProjectPrefs } from './ProjectPrefs'
import { BulkBar, EmptyStart, RowMenu, SortMore, TasksMenu, type ExtraSort } from './ListTools'
import { I } from '../task/parts'
import {
  dueDiff,
  dueGroup,
  dueText,
  fmtHm,
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

type Tab = 'mine' | 'from' | 'all'
type Focus = 'fresh' | 'prio' | 'late' | 'rev' | 'ans' | 'long'
type SortKey = 'id' | 'title' | 'prio' | 'mv' | 'due' | 'who' | 'wait' | ExtraSort
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
  const all = useAllTasks(companyId, tab === 'all')
  const [focus, setFocus] = useState<Focus | null>(null)
  const [sortK, setSortK] = useState<SortKey | null>(null)
  const [sortD, setSortD] = useState<1 | -1>(1)
  const [grpBy, setGrpBy] = useState<GroupBy>(() => {
    const g = pref<GroupBy>('chatick_v2_group', 'due')
    return g === 'proj' ? 'due' : g
  })
  // «По проектам» — отдельный переключатель: каждый проект свёрнутой группой
  // с числом задач. Сортировка колонок действует внутри каждого проекта.
  const [byProj, setByProjState] = useState(() => localStorage.getItem('chatick_v2_byproj') === '1')
  const setByProj = (v: boolean) => {
    setByProjState(v)
    try {
      localStorage.setItem('chatick_v2_byproj', v ? '1' : '0')
    } catch {
      /* не запомним — не страшно */
    }
  }
  const [prefs] = useProjectPrefs(companyId)
  const openKey = `chatick_v2_projopen_${companyId}`
  const [openProj, setOpenProj] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(openKey) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const toggleProj = (id: string) =>
    setOpenProj((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(openKey, JSON.stringify([...next]))
      } catch {
        /* не запомним — не страшно */
      }
      return next
    })
  const setTab = (v: Tab) => {
    setTabState(v)
    setFocus(null)
    localStorage.setItem('chatick_v2_tab', v)
  }

  // Поиск задачи по номеру или названию — в пределах вкладки и проекта.
  const [q, setQ] = useState('')
  const qs = q.trim().toLowerCase()
  const hit = (i: BallItem) => !qs || i.title.toLowerCase().includes(qs) || i.number.toLowerCase().includes(qs) || i.number.replace(/\D/g, '') === qs
  // Выбранные строки (массовые действия) и меню по правому клику.
  const [sel, setSel] = useState<Set<string>>(() => new Set())
  const [menu, setMenu] = useState<{ item: BallItem; x: number; y: number } | null>(null)
  const toggleSel = (id: string) =>
    setSel((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  useEffect(() => setSel(new Set()), [tab, project])

  const myId = me.data?.id
  const inProj = (i: BallItem) => !project || i.project?.id === project
  const mineAll = mine.data ?? []
  const fromAll = fromMe.data ?? []
  const allAll = all.data ?? []
  const src = (tab === 'mine' ? mineAll : tab === 'from' ? fromAll : allAll).filter(inProj)

  const F: Record<Focus, (i: BallItem) => boolean> = {
    fresh: (i) => i.isNew,
    prio: (i) => isImportant(i.priority),
    late: (i) => dueGroup(i.dueDate) === 'late',
    rev: (i) => i.ball.move === 'review' && !i.ball.waitingClientSince,
    ans: (i) => i.ball.move === 'answer' && !i.ball.waitingClientSince,
    long: (i) => heatOf(i.ball.move, i.ball.heldSince) === 'burn' && !i.ball.waitingClientSince,
  }
  const list = (focus ? src.filter(F[focus]) : src).filter(hit)

  // «От кого» в «На мне» — кто отдал мяч (последний ход), иначе владелец.
  // В «От меня» и «Все» — у кого он сейчас.
  const personOf = (i: BallItem) => (tab === 'mine' ? (i.last?.actor ?? i.owner) : i.holder)

  const groups = useMemo(() => {
    const cmp = (a: BallItem, b: BallItem) => {
      let r = 0
      if (sortK === 'id') r = (Number(a.number.replace(/\D/g, '')) || 0) - (Number(b.number.replace(/\D/g, '')) || 0)
      else if (sortK === 'title') r = a.title.localeCompare(b.title)
      else if (sortK === 'mv') r = (MOVE_ORDER[moveKey(a)] ?? 9) - (MOVE_ORDER[moveKey(b)] ?? 9)
      else if (sortK === 'due') r = (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')
      else if (sortK === 'who') r = (personOf(a)?.name ?? '').localeCompare(personOf(b)?.name ?? '')
      else if (sortK === 'wait') r = heldDays(b.ball.heldSince) - heldDays(a.ball.heldSince)
      else if (sortK === 'prio') r = Number(isImportant(b.priority)) - Number(isImportant(a.priority))
      else if (sortK === 'est') r = (b.estimateMinutes ?? -1) - (a.estimateMinutes ?? -1)
      else if (sortK === 'created') r = b.createdAt.localeCompare(a.createdAt)
      else if (sortK === 'blk') r = (b.blockedBy ?? 0) - (a.blockedBy ?? 0)
      if (sortK) return r * sortD || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')
      return Number(isImportant(b.priority)) - Number(isImportant(a.priority)) || (a.dueDate ?? '').localeCompare(b.dueDate ?? '')
    }
    let G: [string, string][]
    let keyOf: (i: BallItem) => string
    if (byProj && !project) {
      // Проекты — в порядке, который человек настроил в ленте, дальше по числу задач.
      keyOf = (i) => i.project?.id ?? ''
      const present = new Map<string, NonNullable<BallItem['project']>>()
      for (const i of list) if (i.project) present.set(i.project.id, i.project)
      const n = (id: string) => list.filter((i) => i.project?.id === id).length
      const ordered = orderProjects([...present.values()].map((p) => ({ ...p, companyId })), prefs, n)
      G = ordered.map((p) => [p.id, p.name])
    } else if (grpBy === 'proj') {
      keyOf = (i) => i.project?.id ?? ''
      G = [...new Map(list.map((i) => [keyOf(i), shortProject(i.project?.name ?? '—')])).entries()]
    } else if (grpBy === 'person') {
      keyOf = (i) => personOf(i)?.id ?? ''
      G = [
        ...new Map(
          list.map((i) => {
            const p = personOf(i)
            return [keyOf(i), p ? t(tab === 'mine' ? 'tasks.gFrom' : 'tasks.gWith', { name: p.name }) : t('tasks.nobody')] as [string, string]
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
  }, [list, grpBy, sortK, sortD, tab, t, byProj, project, prefs, companyId])

  // Сводка — по «На мне» в выбранном проекте, как в макете.
  const mp = mineAll.filter(inProj)
  const late = mp.filter(F.late).length
  const waitN = mp.filter((i) => (i.ball.move === 'review' || i.ball.move === 'answer') && !i.ball.waitingClientSince).length
  const nProj = new Set(mp.map((i) => i.project?.id)).size
  const parts = [late ? t('tasks.late', { count: late }) : '', waitN ? t('tasks.waiting', { count: waitN }) : ''].filter(Boolean)
  const head = mp.length ? t('tasks.headSome', { count: mp.length }) + (!project ? t('tasks.acrossProjects', { count: nProj }) : '') : t('tasks.headNone')
  const sub = mp.length ? (parts.length ? t('tasks.subStart', { parts: parts.join(', ') }) : t('tasks.subCalm')) : t('tasks.subNone')

  const loading = tab === 'all' ? all.isLoading : mine.isLoading || fromMe.isLoading
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
        {(k === 'prio' || k === 'wait') && on ? (
          // Важность и ожидание — не стрелкой, а словами: «сначала важные»,
          // «сначала заждавшиеся» понятнее, чем ↓.
          <span className={'lh-tag ' + (sortD === 1 ? 'hi' : 'lo')}>
            {k === 'prio' ? (sortD === 1 ? t('tasks.prioFirst') : t('tasks.prioLast')) : sortD === 1 ? t('tasks.waitFirst') : t('tasks.waitLast')}
          </span>
        ) : (
          <i>{on ? (sortD === -1 ? '↑' : '↓') : ''}</i>
        )}
      </button>
    )
  }
  // «По проекту» — теперь отдельным переключателем «Списком | По проектам».
  const GBO: GroupBy[] = ['due', 'person', 'none']
  const grouped = byProj && !project
  const gbLabel = grpBy === 'person' ? (tab === 'mine' ? t('tasks.gb.personFrom') : t('tasks.gb.personTo')) : t(`tasks.gb.${grpBy}`)

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
          <button className={tab === 'all' ? 'on' : ''} role="tab" aria-selected={tab === 'all'} onClick={() => setTab('all')}>
            {t('tasks.tabAll')}
            {all.data && <span className="n">{allAll.filter(inProj).length}</span>}
          </button>
        </div>
        {!project && (
          <div className="seg vmode" role="radiogroup" aria-label={t('tasks.view')}>
            <button className={!byProj ? 'on' : ''} role="radio" aria-checked={!byProj} aria-label={t('tasks.viewFlat')} title={t('tasks.viewFlat')} onClick={() => setByProj(false)}>
              <Icon name="list" sm />
            </button>
            <button className={byProj ? 'on' : ''} role="radio" aria-checked={byProj} aria-label={t('tasks.viewProj')} title={t('tasks.viewProj')} onClick={() => setByProj(true)}>
              <Icon name="folders" sm />
            </button>
          </div>
        )}
        <label className="rsearch tq">
          <Icon name="search" sm />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('lt.find')} aria-label={t('lt.find')} />
        </label>
        <div style={{ flex: 1 }} />
        {FOCUS.map(([f, dot]) => {
          const c = src.filter(F[f]).length
          const on = focus === f
          // Пустой фокус прячем: с тремя вкладками всё в одну строку не помещалось.
          if (!c && !on) return null
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
        <div className="lh pinned" role="toolbar">
          <span />
          <span style={{ display: 'flex', gap: 6 }}>
            {sortBtn('id', t('tasks.lh.id'))}
            {sortBtn('title', t('tasks.lh.title'))}
            {sortBtn('prio', t('tasks.lh.prio'))}
            <SortMore
              value={sortK === 'est' || sortK === 'created' || sortK === 'blk' ? sortK : null}
              dir={sortD}
              onPick={(k) => {
                if (k && k === sortK) setSortD(sortD === 1 ? -1 : 1)
                else {
                  setSortK(k)
                  setSortD(1)
                }
              }}
            />
          </span>
          <span>{sortBtn('mv', t('tasks.lh.mv'))}</span>
          <span>{sortBtn('due', t('tasks.lh.due'))}</span>
          <span>
            {sortBtn('who', tab === 'mine' ? t('tasks.lh.from') : t('tasks.lh.holder'))}
            {sortBtn('wait', t('tasks.lh.wait'))}
          </span>
          <span className="lh-end">
            <TasksMenu
              items={list}
              projects={projects.data ?? []}
              project={project}
              label={project ? shortProject(projects.data?.find((p) => p.id === project)?.name ?? '') : t(`tasks.tab${tab === 'mine' ? 'Mine' : tab === 'from' ? 'From' : 'All'}`)}
            />
            {!grouped && (
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
            )}
          </span>
        </div>

        {groups.map((g) => {
          if (!grouped)
            return (
              <div key={g.k}>
                <div className={'gh' + (grpBy === 'due' && g.k === 'late' ? ' late' : '')}>
                  {g.label}
                  <span className="n">{g.rows.length}</span>
                </div>
                {g.rows.map((i, n) => (
                  <Row
                    key={i.id}
                    item={i}
                    tab={tab}
                    first={n === 0}
                    myId={myId}
                    person={personOf(i)}
                    picked={sel.has(i.id)}
                    picking={sel.size > 0}
                    onPick={() => toggleSel(i.id)}
                    onMenu={(x, y) => setMenu({ item: i, x, y })}
                  />
                ))}
              </div>
            )
          const open = openProj.has(g.k)
          const p = g.rows[0]?.project ?? null
          return (
            <div key={g.k} className={'pgrp' + (open ? ' open' : '')}>
              <button className="pgh" aria-expanded={open} onClick={() => toggleProj(g.k)}>
                <Icon name={open ? 'chevron' : 'chevronEnd'} sm />
                <ProjectLogo project={p} />
                <span className="nm bidi">{g.label}</span>
                <span className="pgc">{g.rows.length}</span>
              </button>
              {open &&
                g.rows.map((i, n) => (
                  <Row
                    key={i.id}
                    item={i}
                    tab={tab}
                    first={n === 0}
                    myId={myId}
                    person={personOf(i)}
                    picked={sel.has(i.id)}
                    picking={sel.size > 0}
                    onPick={() => toggleSel(i.id)}
                    onMenu={(x, y) => setMenu({ item: i, x, y })}
                  />
                ))}
            </div>
          )
        })}
        {!loading && !groups.length && tab === 'mine' && !focus && !qs && !mineAll.length && !fromAll.length ? (
          <EmptyStart onQuick={() => document.querySelector<HTMLElement>('.newt [contenteditable], .newt input')?.focus()} />
        ) : (
          !loading &&
          !groups.length && (
            <div className="none">
              {qs ? t('lt.noHits', { q }) : focus ? t('tasks.noneFilter') : tab === 'mine' ? t('tasks.noneMine') : tab === 'from' ? t('tasks.noneFrom') : t('tasks.noneAll')}
            </div>
          )
        )}
        {loading && <div className="none">{t('common.loading')}</div>}
        {/* Фокус-фильтры — про текущую работу; закрытым под ними не место. */}
        {!focus && !qs && <ClosedBlock key={`${tab}:${project ?? ''}`} tab={tab} project={project} />}
      </div>
      {sel.size > 0 && <BulkBar items={src.filter((i) => sel.has(i.id))} onClear={() => setSel(new Set())} />}
      {menu && <RowMenu item={menu.item} x={menu.x} y={menu.y} myId={myId} onClose={() => setMenu(null)} />}
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
  const { companyId } = useUi()
  const [q, setQ] = useState('')
  const [prefs, savePrefs] = useProjectPrefs(companyId)
  const [setup, setSetup] = useState(false)
  const car = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState({ prev: false, next: false })
  // Полосы прокрутки у ленты нет — листают стрелками и обычным колесом мыши.
  useEffect(() => {
    const el = car.current
    if (!el) return
    const rtl = getComputedStyle(el).direction === 'rtl'
    const upd = () => {
      const x = Math.abs(el.scrollLeft)
      const max = el.scrollWidth - el.clientWidth
      setEdge(rtl ? { prev: x > 4, next: x < max - 4 } : { prev: x > 4, next: x < max - 4 })
    }
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return
      e.preventDefault()
      el.scrollLeft += rtl ? -e.deltaY : e.deltaY
    }
    upd()
    el.addEventListener('scroll', upd, { passive: true })
    el.addEventListener('wheel', wheel, { passive: false })
    const ro = new ResizeObserver(upd)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', upd)
      el.removeEventListener('wheel', wheel)
      ro.disconnect()
    }
  }, [projects.length])
  const page = (dir: 1 | -1) => {
    const el = car.current
    if (!el) return
    const rtl = getComputedStyle(el).direction === 'rtl'
    el.scrollBy({ left: dir * (rtl ? -1 : 1) * el.clientWidth * 0.8, behavior: 'smooth' })
  }
  const by = new Map<string, number>()
  for (const c of counts) if (c.project) by.set(c.project.id, (by.get(c.project.id) ?? 0) + 1)
  const count = (id: string) => by.get(id) ?? 0
  // Скрытые человеком не показываем — кроме выбранного сейчас: иначе непонятно, что отфильтровано.
  const hidden = new Set(prefs.hidden)
  const sorted = orderProjects(
    projects.filter((p) => !hidden.has(p.id) || p.id === selected),
    prefs,
    count,
  )
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
        {edge.prev && (
          <button className="car-arr prev" aria-label={t('car.prev')} onClick={() => page(-1)}>
            <Icon name="chevronStart" />
          </button>
        )}
        <div ref={car} className="car" role="tablist" aria-label="Projects">
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
        {edge.next && (
          <button className="car-arr next" aria-label={t('car.next')} onClick={() => page(1)}>
            <Icon name="chevronEnd" />
          </button>
        )}
        {none && <span className="car-none">{t('car.none', { q })}</span>}
        <button className="car-set" aria-label={t('pprefs.open')} title={t('pprefs.open')} aria-expanded={setup} onClick={() => setSetup(!setup)}>
          <Icon name="sliders" />
        </button>
        {setup && <ProjectPrefsPanel projects={projects} prefs={prefs} onSave={savePrefs} count={count} onClose={() => setSetup(false)} />}
      </div>
    </div>
  )
}

function Row({
  item: i,
  tab,
  first,
  myId,
  person,
  picked,
  picking,
  onPick,
  onMenu,
}: {
  item: BallItem
  tab: Tab
  first: boolean
  myId?: string
  person: BallItem['owner']
  picked: boolean
  picking: boolean
  onPick: () => void
  onMenu: (x: number, y: number) => void
}) {
  const { t, i18n } = useTranslation('v2')
  const { openTask } = useUi()
  const a = useBallActions(i, myId)
  const [sharing, setSharing] = useState(false)
  const mk = moveKey(i)
  const n = dueDiff(i.dueDate)
  const long = tab === 'mine' && a.mine && heatOf(i.ball.move, i.ball.heldSince) === 'burn' && !i.ball.waitingClientSince
  const fromMeSelf = tab === 'mine' && person?.id === myId
  const wlabel = !person
    ? tab === 'mine'
      ? '—'
      : t('tasks.nobody')
    : tab !== 'mine'
      ? t('tasks.with', { name: person.name })
      : fromMeSelf
        ? t('tasks.yourTask')
        : t('tasks.from', { name: person.name })
  const wait = i.ball.waitingClientSince
    ? t('wait.since', { date: new Date(i.ball.waitingClientSince).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' }) })
    : waitText(t, i.ball.heldSince)
  const p = i.project
  // Возраст задачи: с какого дня она вообще существует (не путать с «ждёт»).
  const age = Math.floor((Date.now() - new Date(i.createdAt).getTime()) / 86_400_000)
  return (
    <div
      className={'row' + (first ? ' first' : '') + (i.isNew ? ' fresh' : '') + (picked ? ' picked' : '') + (picking ? ' picking' : '')}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
    >
      <span className="rsel">
        <ProjectLogo project={p} title={p?.name} />
        <button className={'rsel-cb' + (picked ? ' on' : '')} role="checkbox" aria-checked={picked} aria-label={t('lt.pick', { id: i.number })} onClick={onPick}>
          {picked && <Icon name="check" sm />}
        </button>
      </span>
      <div style={{ minWidth: 0 }}>
        <button className="ttl bidi" onClick={() => openTask(i.id)}>
          {i.title}
        </button>
        {i.isNew && i.last && <div className="nw">{newLine(t, i)}</div>}
        <div className="meta">
          {/* Номер — первым, меткой одной ширины: столбцом, а не ступеньками после проекта.
              Флажок важности — в конце: невидимый у обычных задач, он не сдвигает строку. */}
          <span className="tnum">{i.number}</span>
          <span className="pn">{p ? shortProject(p.name) : ''}</span>
          {(i.blockedBy ?? 0) > 0 && (
            <span className="rx lock" title={t('lt.blocked', { count: i.blockedBy })}>
              <I name="lock" sm />
            </span>
          )}
          {i.estimateMinutes ? (
            <span className="rx" title={t('lt.estimate')}>
              <Icon name="clock" sm />
              {fmtHm(i.estimateMinutes)}
            </span>
          ) : null}
          {(i.files ?? 0) > 0 && (
            <span className="rx" title={t('lt.files', { count: i.files })}>
              <Icon name="attach" sm />
              {i.files}
            </span>
          )}
          {age >= 1 && (
            <span className="rx age" title={t('lt.created', { date: new Date(i.createdAt).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short', year: 'numeric' }) })}>
              {t('lt.age', { count: age })}
            </span>
          )}
          <PrioFlag item={i} />
        </div>
      </div>
      <MoveCell item={i} a={a} />
      <DueCell item={i} />
      <PersonCell
        item={i}
        person={tab === 'mine' ? person : i.holder}
        label={wlabel}
        wait={
          <span className={'wt' + (long ? ' long' : '')} title={long ? t('tasks.longTitle') : t('tasks.waitTitle')}>
            {long && <Icon name="hourglass" />}
            {wait}
          </span>
        }
      />
      <div className={'acts' + (a.isRev ? ' always' : '')}>
        <button className="ib" aria-label={t('act.share')} title={t('act.share')} onClick={() => setSharing(true)}>
          <Icon name="share" />
        </button>
        {sharing && <ShareTask taskId={i.id} title={`${i.number} · ${i.title}`} canPublish={a.mine || a.canTake} onClose={() => setSharing(false)} />}
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

/**
 * Завершённые — свёрнутым блоком под списком, как «показать выполненные» в
 * первой версии. Свёрнутый показывает только число; строки грузятся по
 * клику и дальше порциями по 30 — простыни из сотен закрытых задач нет.
 * Смена вкладки или проекта сворачивает блок заново (key у родителя).
 */
function ClosedBlock({ tab, project }: { tab: Tab; project: string | null }) {
  const { t } = useTranslation('v2')
  const { companyId } = useUi()
  const [open, setOpen] = useState(false)
  const count = useClosedCount(companyId, tab, project)
  const q = useClosed(companyId, tab, project, open)
  const total = q.data?.pages[0]?.total ?? count.data ?? 0
  if (!total) return null
  const rows = q.data?.pages.flatMap((p) => p.items) ?? []
  const left = total - rows.length
  return (
    <div className={'cgrp' + (open ? ' open' : '')}>
      <button className="cgh" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron' : 'chevronEnd'} sm />
        <span className="nm">{t('tasks.closed.head')}</span>
        <span className="pgc">{total}</span>
        <span className="cgh-h">{open ? t('tasks.closed.hide') : t('tasks.closed.show')}</span>
      </button>
      {open && rows.map((i) => <ClosedRow key={i.id} item={i} />)}
      {open && q.isLoading && <div className="none">{t('tasks.closed.loading')}</div>}
      {open && q.hasNextPage && (
        <button className="cmore" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {q.isFetchingNextPage ? t('tasks.closed.loading') : t('tasks.closed.more', { count: Math.min(30, left) })}
        </button>
      )}
    </div>
  )
}

/** Строка закрытой задачи: итог вместо хода, дата закрытия вместо срока, кто закрыл. */
function ClosedRow({ item: i }: { item: BallItem }) {
  const { t, i18n } = useTranslation('v2')
  const { openTask } = useUi()
  const done = i.status === 'done'
  const closer = i.last && (i.last.action === 'accept' || i.last.action === 'cancel') ? i.last.actor : null
  const who = closer ?? i.holder
  const p = i.project
  const at = i.closedAt ? new Date(i.closedAt).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' }) : ''
  return (
    <div className="row closed">
      <ProjectLogo project={p} title={p?.name} />
      <div style={{ minWidth: 0 }}>
        <button className="ttl bidi" onClick={() => openTask(i.id)}>
          {i.title}
        </button>
        <div className="meta">
          <span className="tnum">{i.number}</span>
          <span className="pn">{p ? shortProject(p.name) : ''}</span>
        </div>
      </div>
      <span className="mvcell rcell">
        <span className={'mv cst ' + (done ? 'cst-ok' : 'cst-x')}>
          {done && <Icon name="check" sm />}
          {done ? t('tasks.closed.done') : t('tasks.closed.cancelled')}
        </span>
      </span>
      <span className="rcell">
        <span className="due">
          {at}
          <small>{t('tasks.closed.at')}</small>
        </span>
      </span>
      <span className="from rcell">
        {who && (
          <span className="rperson" title={closer ? t('tasks.closed.by', { name: closer.name }) : undefined}>
            <span className="av" style={{ background: personColor(who.id) }}>
              {letterOf(who.name)}
            </span>
            <span className="bidi">{who.name}</span>
          </span>
        )}
      </span>
      <div className="acts" />
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
/** «Сегодня» и пояс человека: от них сервер считает «завтра» и «до пятницы». */
const here = () => {
  const d = new Date()
  return { today: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, tzOffset: d.getTimezoneOffset() }
}

function QuickAdd({ projects, onCreated }: { projects: CompanyProject[]; onCreated: (toMe: boolean) => void }) {
  const { t, i18n } = useTranslation('v2')
  const { companyId, project, flash, base } = useUi()
  const me = useMe()
  const navigate = useNavigate()
  const refresh = useRefreshBall()
  const input = useRef<QuickInputHandle>(null)
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<{ project: { id: string; name: string; color: string | null }; assignee: { id: string; name: string } | null; due?: string | null } | null>(null)
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
        body: JSON.stringify({ companyId, text: s, preview: true, projectId: project ?? undefined, ...here() }),
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
        body: JSON.stringify({ companyId, text: text.trim(), projectId: project ?? undefined, ...here() }),
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
        {text.trim() && preview?.due && (
          <span className="pin" title={t('tasks.dueWord')}>
            <Icon name="calendar" sm />
            <span>{dueText(t, `${preview.due}T12:00:00`, i18n.language)}</span>
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
