import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DndContext, PointerSensor, KeyboardSensor, useSensor, useSensors, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { keys, useProjects, type CompanyProject } from '../data'
import { ProjectLogo } from '../ProjectLogo'
import { Icon } from '../Icon'
import { shortProject } from '../util'

/**
 * Свои проекты в карусели: какие показывать и в каком порядке.
 *
 * У человека бывают десятки проектов, а важны несколько. Порядок —
 * перетаскиванием (важные первыми), видимость — переключателем. Проекты,
 * которых в списке порядка нет (новые), идут после упорядоченных, как раньше —
 * по числу задач.
 *
 * Скрытые — на сервере, как в первой версии: человек скрыл проект на работе и
 * видит то же самое дома и в приложении. Порядок — пока в браузере.
 */
export type ProjectPrefs = { order: string[]; hidden: string[] }

const key = (companyId: string) => `chatick_v2_projprefs_${companyId}`

export function useProjectPrefs(companyId: string) {
  const projects = useProjects(companyId)
  const qc = useQueryClient()
  const [local, setLocal] = useState<ProjectPrefs>(() => read(companyId))
  useEffect(() => setLocal(read(companyId)), [companyId])
  const serverHidden = useMemo(() => (projects.data ?? []).filter((p) => p.hidden).map((p) => p.id), [projects.data])
  // Пока сервер не ответил — показываем то, что человек только что выбрал.
  const [pending, setPending] = useState<string[] | null>(null)
  const prefs: ProjectPrefs = { order: local.order, hidden: pending ?? serverHidden }

  const push = (before: string[], after: string[]) => {
    const was = new Set(before)
    const now = new Set(after)
    const changed = [...new Set([...before, ...after])].filter((id) => was.has(id) !== now.has(id))
    if (!changed.length) return
    setPending(after)
    void Promise.all(changed.map((id) => api(`/api/v1/projects/${id}/hide?hide=${now.has(id) ? '1' : '0'}`, { method: 'POST' }).catch(() => {})))
      .then(() => qc.invalidateQueries({ queryKey: keys.projects(companyId) }))
      .finally(() => setPending(null))
  }

  // Скрытые раньше в этом браузере — один раз переносим на сервер.
  useEffect(() => {
    if (!projects.data || !local.hidden.length) return
    push(serverHidden, [...new Set([...serverHidden, ...local.hidden])])
    write(companyId, { order: local.order, hidden: [] })
    setLocal({ order: local.order, hidden: [] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.data, companyId])

  const save = (p: ProjectPrefs) => {
    setLocal({ order: p.order, hidden: [] })
    write(companyId, { order: p.order, hidden: [] })
    push(prefs.hidden, p.hidden)
  }
  return [prefs, save] as const
}

function write(companyId: string, p: ProjectPrefs) {
  try {
    localStorage.setItem(key(companyId), JSON.stringify(p))
  } catch {
    /* хранилище закрыто — порядок проживёт до перезагрузки */
  }
}

function read(companyId: string): ProjectPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(key(companyId)) ?? 'null') as Partial<ProjectPrefs> | null
    return { order: Array.isArray(v?.order) ? v!.order : [], hidden: Array.isArray(v?.hidden) ? v!.hidden : [] }
  } catch {
    return { order: [], hidden: [] }
  }
}

/** Порядок карусели: сначала упорядоченные человеком, потом остальные по числу задач. */
export function orderProjects(projects: CompanyProject[], prefs: ProjectPrefs, count: (id: string) => number) {
  const pos = new Map(prefs.order.map((id, i) => [id, i]))
  return [...projects].sort((a, b) => {
    const pa = pos.get(a.id)
    const pb = pos.get(b.id)
    if (pa !== undefined || pb !== undefined) return (pa ?? Infinity) - (pb ?? Infinity)
    return count(b.id) - count(a.id)
  })
}

const PAGE = 60

export function ProjectPrefsPanel({
  projects,
  prefs,
  onSave,
  count,
  onClose,
}: {
  projects: CompanyProject[]
  prefs: ProjectPrefs
  onSave: (p: ProjectPrefs) => void
  count: (id: string) => number
  onClose: () => void
}) {
  const { t } = useTranslation('v2')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const sentinel = useRef<HTMLDivElement>(null)
  const ordered = useMemo(() => orderProjects(projects, prefs, count), [projects, prefs, count])
  const s = q.trim().toLowerCase()
  const list = s ? ordered.filter((p) => p.name.toLowerCase().includes(s)) : ordered
  const shown = list.slice(0, limit)
  const hidden = new Set(prefs.hidden)

  // Подгружаем по мере прокрутки: тысячу строк сразу рисовать незачем.
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && setLimit((l) => l + PAGE))
    io.observe(el)
    return () => io.disconnect()
  }, [shown.length])
  useEffect(() => setLimit(PAGE), [s])
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    // Перетащили — запоминаем порядок всего списка: место каждого становится явным.
    const ids = ordered.map((p) => p.id)
    const from = ids.indexOf(String(e.active.id))
    const to = ids.indexOf(String(e.over.id))
    onSave({ ...prefs, order: arrayMove(ids, from, to) })
  }
  const toggle = (id: string) => onSave({ ...prefs, hidden: hidden.has(id) ? prefs.hidden.filter((x) => x !== id) : [...prefs.hidden, id] })
  const visible = projects.length - projects.filter((p) => hidden.has(p.id)).length

  return (
    <>
      <div className="gt-scrim" onClick={onClose} />
      <div className="ppanel" role="dialog" aria-label={t('pprefs.title')}>
        <div className="pp-h">
          <b>{t('pprefs.title')}</b>
          <span className="pp-n">{t('pprefs.shown', { n: visible, total: projects.length })}</span>
          <button className="ib" aria-label={t('panel.close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <p className="pp-hint">{t('pprefs.hint')}</p>
        <label className="cbx-s" style={{ margin: '0 0 6px' }}>
          <Icon name="search" sm />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('car.find')} aria-label={t('car.findAria')} autoFocus />
        </label>
        <div className="pp-list">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={shown.map((p) => p.id)} strategy={verticalListSortingStrategy}>
              {shown.map((p) => (
                <Row key={p.id} p={p} on={!hidden.has(p.id)} n={count(p.id)} onToggle={() => toggle(p.id)} drag={!s} />
              ))}
            </SortableContext>
          </DndContext>
          {shown.length < list.length && <div ref={sentinel} className="pp-more" />}
          {!list.length && <div className="cbx-none">{t('car.none', { q })}</div>}
        </div>
        {(prefs.order.length > 0 || prefs.hidden.length > 0) && (
          <button className="pp-reset" onClick={() => onSave({ order: [], hidden: [] })}>
            {t('pprefs.reset')}
          </button>
        )}
      </div>
    </>
  )
}

function Row({ p, on, n, onToggle, drag }: { p: CompanyProject; on: boolean; n: number; onToggle: () => void; drag: boolean }) {
  const { t } = useTranslation('v2')
  const { setNodeRef, transform, transition, isDragging, attributes, listeners } = useSortable({ id: p.id, disabled: !drag })
  return (
    <div ref={setNodeRef} className={'pp-row' + (isDragging ? ' drag' : '') + (on ? '' : ' off')} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <button className="pp-grip" aria-label={t('pprefs.drag', { name: p.name })} disabled={!drag} {...attributes} {...listeners}>
        <Icon name="grip" sm />
      </button>
      <ProjectLogo project={p} />
      <span className="nm bidi" title={p.name}>
        {shortProject(p.name)}
      </span>
      {n > 0 && <span className="c">{n}</span>}
      <button className={'navpin' + (on ? ' on' : '')} role="switch" aria-checked={on} aria-label={t('pprefs.show', { name: p.name })} onClick={onToggle}>
        <i />
      </button>
    </div>
  )
}
