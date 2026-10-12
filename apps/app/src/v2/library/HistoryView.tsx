import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { api } from '@/lib/api'
import { inProject, useMe, type CompanyProject } from '../data'
import { useUi } from '../ui'
import { Carousel } from '../tasks/TasksView'
import { ProjectLogo } from '../ProjectLogo'
import { Icon } from '../Icon'
import { letterOf, personColor } from '../util'
import { byDay, dayLabel, errText, PersonCombo, useDebounced, useLibProjects, usePeople, usePerProject, type Person } from './shared'

type Actor = { id: string; name: string; avatarUrl: string | null } | null
type Activity = {
  id: string
  action: string
  entityType: string
  entityId: string | null
  entityLabel: string
  meta: { changed?: string[]; before?: Record<string, unknown>; after?: Record<string, unknown>; handoff?: string } | null
  createdAt: string
  actor: Actor
}
type Ev = Activity & { project: CompanyProject; type: Type | null }
type TrashRaw = { id: string; number?: string; title?: string; name?: string; deletedAt: string; deletedBy: Actor }
type TrashRow = { id: string; kind: 'task' | 'file' | 'res'; name: string; deletedAt: string; deletedBy: Actor; project: CompanyProject }

type Type = 'task' | 'doc' | 'res' | 'ver' | 'file'
const TYPES: Type[] = ['task', 'doc', 'res', 'ver', 'file']
const TYPE_OF: Record<string, Type> = { task: 'task', comment: 'task', document: 'doc', resource: 'res', release: 'ver', file: 'file' }
const TRASH_TYPE: Record<TrashRow['kind'], Type> = { task: 'task', file: 'file', res: 'res' }
/** Сколько корзина держит удалённое — столько же, сколько чистильщик на сервере (file-cleanup). */
const KEEP_DAYS = 7
const DAY = 864e5

const STATUS_CLS: Record<string, string> = { todo: 'st st-todo', in_progress: 'st st-work', review: 'st st-review', verified: 'st st-review', done: 'st st-done', cancelled: 'st st-todo' }

/**
 * «История» — что происходило в проектах, и корзина с восстановлением.
 *
 * Журнал на сервере — по проекту; здесь первая страница каждого проекта,
 * склеенная по времени. Поиск по названию идёт на сервере.
 */
export function HistoryView() {
  const { t, i18n } = useTranslation('v2')
  const { companyId, project, setProject } = useUi()
  const { list: projects } = useLibProjects(companyId)
  const people = usePeople(companyId)
  const [tab, setTab] = useState<'act' | 'trash'>('act')
  const [q, setQ] = useState('')
  const dq = useDebounced(q.trim())
  const [type, setType] = useState<Type | null>(null)
  const [who, setWho] = useState<string | null>(null)

  const act = usePerProject<{ items: Activity[] }>('act', projects, `/api/v1/activity${dq ? `?q=${encodeURIComponent(dq)}` : ''}`)
  // Корзину спрашиваем после событий (или сразу, если открыли её): запросов
  // по проектам много, и первым должен прийти тот список, что на экране.
  const trashOn = tab === 'trash' || !act.loading
  const tTasks = usePerProject<TrashRaw[]>('trash', projects, '/api/v1/tasks/trash', [], trashOn)
  const tFiles = usePerProject<TrashRaw[]>('trash', projects, '/api/v1/files/trash', [], trashOn)
  // Корзина ресурсов — только тем, кто ими управляет; остальным сервер скажет 403, это просто пусто.
  const tRes = usePerProject<TrashRaw[]>('trash', projects, '/api/v1/resources/trash', [], trashOn)

  const events: Ev[] = useMemo(
    () =>
      act.parts
        .flatMap(({ project: p, data }) => (data?.items ?? []).map((e) => ({ ...e, project: p, type: TYPE_OF[e.entityType] ?? null })))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [act.parts],
  )
  const trash: TrashRow[] = useMemo(() => {
    const mk = (parts: typeof tTasks.parts, kind: TrashRow['kind']) =>
      parts.flatMap(({ project: p, data }) =>
        (data ?? []).map((x) => ({
          id: x.id,
          kind,
          name: kind === 'task' ? `${x.number ?? ''} · ${x.title ?? ''}` : (x.name ?? ''),
          deletedAt: x.deletedAt,
          deletedBy: x.deletedBy,
          project: p,
        })),
      )
    return [...mk(tTasks.parts, 'task'), ...mk(tFiles.parts, 'file'), ...mk(tRes.parts, 'res')].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
  }, [tTasks.parts, tFiles.parts, tRes.parts])

  const inP = (x: { project: CompanyProject }) => !project || x.project.id === project
  const s = dq.toLowerCase()
  const eBase = events.filter(inP).filter((e) => !who || e.actor?.id === who)
  const trBase = trash
    .filter(inP)
    .filter((x) => !who || x.deletedBy?.id === who)
    .filter((x) => !s || x.name.toLowerCase().includes(s))
  const base = tab === 'act' ? eBase : trBase
  const typeOf = (x: Ev | TrashRow) => ('kind' in x ? TRASH_TYPE[x.kind] : x.type)
  const eList = eBase.filter((e) => !type || e.type === type)
  const trList = trBase.filter((x) => !type || TRASH_TYPE[x.kind] === type)

  // В фильтре «кто» — люди компании; если кто-то из журнала уже не в ней, он всё равно в списке.
  const whoList: Person[] = useMemo(() => {
    const m = new Map(people.list.map((p) => [p.id, p]))
    for (const e of events) if (e.actor && !m.has(e.actor.id)) m.set(e.actor.id, e.actor)
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [people.list, events])

  const loading = tab === 'act' ? act.loading : tTasks.loading || tFiles.loading
  return (
    <div className="wrap">
      <div className="rh">
        <div>
          <h1 className="head">{t('library.hist.title')}</h1>
          <p className="sub">{t('library.hist.sub')}</p>
        </div>
        <div className="rh-a">
          <div className="seg" role="tablist">
            {(['act', 'trash'] as const).map((k) => (
              <button key={k} className={tab === k ? 'on' : ''} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
                {t(`library.hist.tab.${k}`)}
                <span className="n">{k === 'act' ? eBase.length : trBase.length}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <Carousel projects={projects} counts={tab === 'act' ? events : trash} selected={project} onPick={setProject} />

      <div className="rbar">
        <label className="rsearch" style={{ maxWidth: 300 }}>
          <Icon name="search" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('library.hist.search')} aria-label={t('library.hist.searchAria')} />
        </label>
        {TYPES.map((k) => {
          const c = base.filter((x) => typeOf(x) === k).length
          const on = type === k
          return (
            <button key={k} className={'fx' + (on ? ' on' : '') + (!c && !on ? ' dim' : '')} aria-pressed={on} onClick={() => setType(on ? null : k)}>
              {t(`library.hist.type.${k}`)}
              <span className="n">{c}</span>
            </button>
          )
        })}
        <div style={{ flex: 1 }} />
        <div style={{ minWidth: 220 }}>
          <PersonCombo people={whoList} value={who} onChange={setWho} />
        </div>
      </div>

      <div className="sheet" style={{ padding: '4px 8px 12px' }}>
        {tab === 'act' && (
          <>
            {byDay(eList, (e) => e.createdAt).map((d) => (
              <div key={d.key}>
                <div className="fday">
                  {dayLabel(t, i18n.language, d.first)}
                  <span className="n">{d.items.length}</span>
                </div>
                {d.items.map((e) => (
                  <EventRow key={e.id} e={e} people={people.byId} />
                ))}
              </div>
            ))}
            {!loading && !eList.length && <div className="none">{t('library.hist.none')}</div>}
          </>
        )}
        {tab === 'trash' && (
          <>
            <div className="fday">{t('library.hist.keep', { count: KEEP_DAYS })}</div>
            {trList.map((x) => (
              <TrashLine key={x.kind + x.id} x={x} />
            ))}
            {!loading && !trList.length && <div className="none">{t('library.hist.trashNone')}</div>}
          </>
        )}
        {loading && !(tab === 'act' ? eList : trList).length && <div className="none">{t('common.loading')}</div>}
      </div>
    </div>
  )
}

const TASK_LABEL = /^([A-Z][A-Z0-9]*-\d+):\s*([\s\S]*)$/

function EventRow({ e, people }: { e: Ev; people: Map<string, Person> }) {
  const { t, i18n } = useTranslation('v2')
  const { openTask } = useUi()
  const sys = !e.actor
  const name = e.actor?.name ?? t('library.hist.system')
  const m = e.entityType === 'task' ? TASK_LABEL.exec(e.entityLabel) : null
  const id = m?.[1] ?? ''
  const label = m?.[2] ?? e.entityLabel
  const canOpen = e.entityType === 'task' && e.entityId && e.action !== 'delete'
  const changes = changesOf(t, e, people, i18n.language)
  return (
    <div className="ev2">
      <time>{new Date(e.createdAt).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })}</time>
      <span className={'av lg' + (sys ? ' sys' : '')} style={sys ? undefined : { background: personColor(e.actor!.id) }}>
        {sys ? <Icon name="spark" sm /> : letterOf(name)}
      </span>
      <div className="tx">
        <b className="bidi">{name}</b> {verbOf(t, e)}{' '}
        {label &&
          (canOpen ? (
            <button className="tgt" onClick={() => openTask(e.entityId!)}>
              {id && <span className="id">{id}</span>}
              <span>{label}</span>
            </button>
          ) : (
            <span className="tgt">
              {id && <span className="id">{id}</span>}
              <span>{label}</span>
            </span>
          ))}
        {changes.map((c, i) => (
          <div key={i} className="dt2">
            <span>{c.field}:</span>
            {c.from !== null && <span className={c.fromCls}>{c.from}</span>}
            {c.from !== null && <span className="ar2">→</span>}
            <span className={c.toCls}>{c.to}</span>
          </div>
        ))}
      </div>
      <span style={{ marginTop: 7 }}>
        <ProjectLogo project={e.project} size="xs" title={e.project.name} />
      </span>
    </div>
  )
}

/** Глагол строки: ход мяча — его словом, остальное — «действие + что». */
function verbOf(t: TFunction, e: Activity): string {
  if (e.meta?.handoff) return t(`tasks.nv.${e.meta.handoff}`, { defaultValue: t('tasks.nv.pass') })
  return t(`library.hist.v.${e.action}_${e.entityType}`, {
    defaultValue: `${t(`library.hist.act.${e.action}`, { defaultValue: e.action })} ${t(`library.hist.ent.${e.entityType}`, { defaultValue: e.entityType })}`,
  })
}

type Change = { field: string; from: string | null; to: string; fromCls: string; toCls: string }

/** Что именно поменялось — статус, исполнитель, срок, важность. Из meta журнала. */
function changesOf(t: TFunction, e: Activity, people: Map<string, Person>, lng: string): Change[] {
  const b = e.meta?.before ?? {}
  const a = e.meta?.after ?? {}
  const out: Change[] = []
  const nameOf = (id: unknown) => (typeof id === 'string' ? (people.get(id)?.name ?? '—') : t('library.hist.nobody'))
  if ('status' in a && a.status !== b.status) {
    const st = (v: unknown) => t(`library.hist.st.${String(v)}`, { defaultValue: String(v) })
    out.push({ field: t('library.hist.f.status'), from: 'status' in b ? st(b.status) : null, to: st(a.status), fromCls: STATUS_CLS[String(b.status)] ?? 'tchip', toCls: STATUS_CLS[String(a.status)] ?? 'tchip' })
  }
  if ('assigneeId' in a && a.assigneeId !== b.assigneeId)
    out.push({ field: t('library.hist.f.assignee'), from: 'assigneeId' in b ? nameOf(b.assigneeId) : null, to: nameOf(a.assigneeId), fromCls: 'tchip', toCls: 'tchip' })
  if ('priority' in a && a.priority !== b.priority) {
    const pr = (v: unknown) => t(`library.hist.pr.${String(v)}`, { defaultValue: String(v) })
    out.push({ field: t('library.hist.f.priority'), from: 'priority' in b ? pr(b.priority) : null, to: pr(a.priority), fromCls: 'tchip', toCls: 'tchip' })
  }
  if ('dueDate' in a && a.dueDate !== b.dueDate) {
    const d = (v: unknown) => (typeof v === 'string' ? new Date(v).toLocaleDateString(lng, { day: 'numeric', month: 'short' }) : t('library.hist.noDue'))
    out.push({ field: t('library.hist.f.due'), from: 'dueDate' in b ? d(b.dueDate) : null, to: d(a.dueDate), fromCls: 'tchip', toCls: 'tchip' })
  }
  // Правка текста без «было/стало» — просто какие поля.
  if (!out.length && e.meta?.changed?.length && !e.meta.handoff) {
    const fields = e.meta.changed.filter((f) => f !== 'dueNotifiedAt').map((f) => t(`library.hist.f.${f}`, { defaultValue: f }))
    if (fields.length) out.push({ field: t('library.hist.f.changed'), from: null, to: fields.join(', '), fromCls: 'tchip', toCls: 'tchip' })
  }
  return out
}

function TrashLine({ x }: { x: TrashRow }) {
  const { t, i18n } = useTranslation('v2')
  const { flash } = useUi()
  const me = useMe()
  const qc = useQueryClient()
  // Восстановленное прячем сразу, не дожидаясь, пока корзина перечитается.
  const [done, setDone] = useState(false)
  const left = Math.max(0, Math.ceil((new Date(x.deletedAt).getTime() + KEEP_DAYS * DAY - Date.now()) / DAY))
  const path = x.kind === 'task' ? `/api/v1/tasks/${x.id}/restore` : x.kind === 'file' ? `/api/v1/files/${x.id}/restore` : `/api/v1/resources/${x.id}/restore`
  const restore = useMutation({
    mutationFn: () => api(path, { method: 'POST', ...inProject(x.project.id) }),
    onSuccess: () => {
      setDone(true)
      flash(t('library.hist.restored', { name: x.name }))
      // Только этот проект: перечитывать журнал и корзины всех проектов ради одной строки — лишние десятки запросов.
      const list = x.kind === 'task' ? null : x.kind === 'file' ? 'files' : 'res'
      void qc.invalidateQueries({ queryKey: ['v2', 'lib', 'trash', x.project.id] })
      void qc.invalidateQueries({ queryKey: ['v2', 'lib', 'act', x.project.id] })
      if (list) void qc.invalidateQueries({ queryKey: ['v2', 'lib', list, x.project.id] })
      if (x.kind === 'task') void qc.invalidateQueries({ queryKey: ['v2', 'ball'] })
    },
    onError: (e) => flash(errText(t, e)),
  })
  const by = x.deletedBy ? (x.deletedBy.id === me.data?.id ? t('library.hist.byMe') : x.deletedBy.name) : t('library.hist.system')
  const when = new Date(x.deletedAt).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' })
  if (done) return null
  return (
    <div className="trow">
      <ProjectLogo project={x.project} title={x.project.name} />
      <div style={{ minWidth: 0 }}>
        <div className="nm">{x.name}</div>
        <div className="mt">{t('library.hist.trashMeta', { kind: t(`library.hist.kind.${x.kind}`), who: by, date: when })}</div>
      </div>
      <span className="exp">{left ? t('library.hist.left', { count: left }) : t('library.hist.leftToday')}</span>
      <button className="mini" disabled={restore.isPending} onClick={() => restore.mutate()}>
        {t('library.hist.restore')}
      </button>
    </div>
  )
}
