import { useEffect, useMemo, useRef, useState } from 'react'
import { ShareTask } from '../ShareTask'
import { TaskChecklist as ClassicChecklist } from '@/components/tabs/tasks/TaskChecklist'
import { DatePop } from '../ui/Calendar'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, setScreenProject } from '@/lib/api'
import { errorCode, inProject, keys, useMe, useProjects, useRefreshBall, useTask, type TaskFull } from '../data'
import { useUi } from '../ui'
import { ProjectLogo } from '../ProjectLogo'
import { Icon } from '../Icon'
import { Ball } from '../tasks/TaskPanel'
import { dueText, fmtHm, shortProject } from '../util'
import {
  ChecklistView,
  Combo,
  DescEditor,
  FilesView,
  I,
  PRIOS,
  PickPop,
  TaskDiscussion,
  TaskFiles,
  TaskHistory,
  TaskNotes,
  TaskRelations,
  TaskResources,
  parseEstimate,
  personAv,
  uploadFile,
  type TaskX,
} from './parts'
import '../i18n/task'
import '../styles/task.css'

/**
 * Полная страница задачи (v2). То же, что панель, но всё сразу: мяч, поля,
 * описание, чек-лист, связи, файлы, ресурсы, обсуждение и история. Правки
 * сохраняются сами — кнопки «Сохранить» нет, как на макете.
 */
export function TaskPage() {
  const { t, i18n } = useTranslation('v2')
  const { taskId } = useParams()
  const { base } = useUi()
  const navigate = useNavigate()
  const me = useMe()
  const full = useTask(taskId ?? null)
  const refresh = useRefreshBall()

  // Открыл задачу — прочитал всё, что о ней было: «новое» гаснет.
  const isNew = full.data?.task.isNew
  useEffect(() => {
    if (!isNew || !taskId) return
    void api('/api/v1/inbox/read', { method: 'POST', body: JSON.stringify({ entityType: 'task', entityId: taskId }) }).then(() => refresh())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, taskId])

  if (!full.data || !me.data || !full.data.task.project)
    return (
      <div className="wrap" style={{ maxWidth: 1120 }}>
        <div className="tp-bar">
          <button className="back" onClick={() => navigate(base)}>
            <I name="back" />
            {t('task.back')}
          </button>
        </div>
        <div className="none" style={{ padding: '64px 0' }}>
          {full.isError ? (errorCode(full.error) === '404' ? t('task.notFound') : t('common.error')) : t('common.loading')}
        </div>
      </div>
    )
  return <Page key={full.data.task.id} data={full.data} myId={me.data.id} lng={i18n.language} />
}

function Page({ data, myId, lng }: { data: TaskFull; myId: string; lng: string }) {
  const { t } = useTranslation('v2')
  const { base, company, flash, setAiOpen } = useUi()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const refresh = useRefreshBall()
  const task = data.task as TaskX
  const pid = task.project!.id
  // Проект «с экрана» для старых виджетов (чек-лист, загрузка картинок).
  // Ставим при отрисовке, а не в эффекте: дочерние компоненты начинают
  // запросы раньше, чем срабатывают эффекты родителя.
  setScreenProject(pid)
  useEffect(() => {
    setScreenProject(pid)
    return () => setScreenProject(null)
  }, [pid])
  // Править поля — своё (завёл или держит) или всё, если управляешь. Последнее
  // слово за сервером; здесь только не показываем заведомо закрытое.
  const manager = company.myRole === 'admin' || company.myRole === 'manager'
  const canEdit = Boolean(data.can.edit) && (manager || task.owner?.id === myId || task.holder?.id === myId)
  const [saving, setSaving] = useState<'idle' | 'saving' | 'failed'>('idle')

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/api/v1/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify(body), ...inProject(pid) }),
    onMutate: (body) => {
      setSaving('saving')
      // Сразу на экране: выбор важности или срока не должен ждать сервера.
      qc.setQueryData<TaskFull>(keys.task(task.id), (old) => (old ? { ...old, task: { ...old.task, ...body } } : old))
    },
    onSuccess: () => setSaving('idle'),
    onError: (e) => {
      setSaving('failed')
      flash(errorCode(e) === '403' ? t('err.forbidden') : t('task.saveFailed'))
    },
    onSettled: () => refresh(task.id),
  })

  // Описание — с задержкой: сохраняем, когда человек перестал печатать.
  const pending = useRef<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const flushDesc = () => {
    window.clearTimeout(timer.current)
    if (pending.current === null) return
    const html = pending.current
    pending.current = null
    patch.mutate({ description: html })
  }
  const flushRef = useRef(flushDesc)
  flushRef.current = flushDesc
  useEffect(() => () => flushRef.current(), [])
  const onDesc = (html: string) => {
    pending.current = html
    setSaving('saving')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(flushDesc, 1200)
  }

  const mentions = useMemo(() => data.team.map((p) => ({ id: p.id, label: p.name, avatarUrl: p.avatarUrl })), [data.team])

  // «Поделиться» — диалог старого клиента: внутренняя и публичная ссылка.
  const [sharing, setSharing] = useState(false)
  const share = () => setSharing(true)
  const del = useMutation({
    mutationFn: () => api(`/api/v1/tasks/${task.id}`, { method: 'DELETE', ...inProject(pid) }),
    onSuccess: () => {
      flash(t('task.deleted', { id: task.number }))
      refresh()
      navigate(base)
    },
    onError: (e) => flash(t(`err.${errorCode(e)}`, { defaultValue: errorCode(e) === '403' ? t('err.forbidden') : t('err.generic') })),
  })

  return (
    <div className="wrap" style={{ maxWidth: 1120 }}>
      {sharing && <ShareTask taskId={task.id} title={`${task.number} · ${task.title}`} canPublish={Boolean(data.can.edit)} onClose={() => setSharing(false)} />}
      <div className="tp-bar">
        <button className="back" onClick={() => navigate(base)}>
          <I name="back" />
          {t('task.back')}
        </button>
        <div className="crumb">
          <ProjectLogo project={task.project} size="xs" />
          <span className="pn">{shortProject(task.project!.name)}</span>
          <span>/</span>
          <span>{task.number}</span>
        </div>
        <span className="saved" role="status">
          {saving === 'idle' && canEdit && (
            <>
              <Icon name="check" sm />
              {t('task.saved')}
            </>
          )}
          {saving === 'saving' && t('task.saving')}
          {saving === 'failed' && <span style={{ color: 'var(--signal)' }}>{t('task.saveFailed')}</span>}
        </span>
        <button className="btn" onClick={share}>
          <Icon name="share" sm />
          {t('task.share')}
        </button>
      </div>
      <div className="tp">
        <div className="tp-main">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <TitleField value={task.title} readOnly={!canEdit} onSave={(title) => patch.mutate({ title })} />
            <Ball data={data} myId={myId} lng={lng} />
          </div>
          {canEdit || task.description?.trim() ? (
            <DescEditor value={task.description ?? ''} onChange={onDesc} readOnly={!canEdit} mentions={mentions} placeholder={t('task.descPh')} />
          ) : (
            <div className="doc doc-ph" style={{ minHeight: 0 }}>
              {t('task.noDesc')}
            </div>
          )}
          {/* Чек-лист — тот же, что в старом клиенте: ответы на пункты, копирование,
              перетаскивание. Проект он берёт «с экрана» (setScreenProject выше). */}
          <div className="v2chk"><ClassicChecklist taskId={task.id} canEdit={canEdit} /></div>
          <TaskRelations task={task} canEdit={canEdit} />
          <TaskFiles task={task} canAttach={!task.closed} />
          <TaskResources task={task} canEdit={canEdit} />
          <TaskNotes task={task} canEdit={canEdit} />
          <TaskDiscussion task={task} lng={lng} />
          <TaskHistory task={task} lng={lng} />
        </div>

        <aside className="tp-side">
          <div className="sbox">
            <div className="sf">
              <div className="k">{t('task.owner')}</div>
              <div className="ownr">
                {personAv(task.owner, 'av lg')}
                <div className="b bidi">
                  {task.owner ? (task.owner.id === myId ? t('task.you') : task.owner.name) : '—'}
                  <small>{t('task.ownerHint')}</small>
                </div>
              </div>
            </div>
            <Fields
              prio={task.priority}
              due={task.dueDate}
              est={task.estimateMinutes}
              readOnly={!canEdit}
              lng={lng}
              onChange={(b) => patch.mutate(b)}
            />
            <Screens refs={task.refs ?? ''} readOnly={!canEdit} onChange={(refs) => patch.mutate({ refs })} />
            <Sprint projectId={pid} groupId={task.groupId ?? null} readOnly={!canEdit} onChange={(groupId) => patch.mutate({ groupId })} />
          </div>
          <div className="sbox" style={{ padding: 10, gap: 2 }}>
            <div className="side-acts">
              <button onClick={() => setAiOpen(true)}>
                <Icon name="spark" />
                {t('task.aiCheck')}
              </button>
              <button onClick={share}>
                <Icon name="share" />
                {t('task.share')}
              </button>
              {canEdit && (
                <button
                  className="danger"
                  disabled={del.isPending}
                  onClick={() => window.confirm(t('task.confirmDelete', { id: task.number })) && del.mutate()}
                >
                  <I name="trash" />
                  {t('task.delete')}
                </button>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

/** Название: правится на месте, сохраняется, когда человек ушёл из поля. */
function TitleField({ value, readOnly, onSave }: { value: string; readOnly: boolean; onSave: (v: string) => void }) {
  const { t } = useTranslation('v2')
  const [text, setText] = useState(value)
  const [focus, setFocus] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  // Пока человек не в поле — показываем то, что на сервере (могли поменять другие).
  useEffect(() => {
    if (!focus) setText(value)
  }, [value, focus])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])
  if (readOnly)
    return (
      <h1 className="tp-title" dir="auto">
        {value}
      </h1>
    )
  const commit = () => {
    const v = text.trim()
    if (v && v !== value) onSave(v)
    else setText(value)
  }
  return (
    <textarea
      ref={ref}
      className="tp-title tp-title-ta"
      dir="auto"
      rows={1}
      value={text}
      onChange={(e) => setText(e.target.value.replace(/\n/g, ' '))}
      onFocus={() => setFocus(true)}
      onBlur={() => {
        setFocus(false)
        commit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ;(e.target as HTMLTextAreaElement).blur()
        }
        if (e.key === 'Escape') {
          setText(value)
          ;(e.target as HTMLTextAreaElement).blur()
        }
      }}
      aria-label={t('task.titleAria')}
      placeholder={t('task.titlePh')}
    />
  )
}

/** Важность, срок, оценка — общее для страницы задачи и новой задачи. */
function Fields({
  prio,
  due,
  est,
  readOnly,
  lng,
  onChange,
}: {
  prio: string
  due: string | null
  est: number | null
  readOnly: boolean
  lng: string
  onChange: (b: { priority?: string; dueDate?: string | null; estimateMinutes?: number | null }) => void
}) {
  const { t } = useTranslation('v2')
  const [dueOpen, setDueOpen] = useState(false)
  const [dueBtn, setDueBtn] = useState<HTMLButtonElement | null>(null)
  const [estEdit, setEstEdit] = useState(false)
  const [estText, setEstText] = useState('')
  const iso = due ? new Date(due).toLocaleDateString('sv-SE') : ''
  const commitEst = () => {
    setEstEdit(false)
    const v = parseEstimate(estText)
    if (v !== undefined && v !== est) onChange({ estimateMinutes: v })
  }
  return (
    <>
      <div className="sf">
        <div className="k">{t('task.priority')}</div>
        <div className="chs">
          {PRIOS.map(([k, color]) => (
            <button key={k} className={'ch' + (prio === k ? ' on' : '')} disabled={readOnly} aria-pressed={prio === k} onClick={() => prio !== k && onChange({ priority: k })}>
              <i style={{ background: color }} />
              {t(`task.prio.${k}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="two">
        <div className="sf">
          <div className="k">{t('task.due')}</div>
          <div className="tp-due">
            <button ref={setDueBtn} className="fieldbtn" disabled={readOnly} onClick={() => setDueOpen(!dueOpen)} aria-expanded={dueOpen} aria-label={`${t('task.due')}: ${dueText(t, due, lng)}`}>
              <span>{dueText(t, due, lng)}</span>
              <I name="cal" />
            </button>
            <DatePop
              open={dueOpen}
              anchor={dueBtn}
              onClose={() => setDueOpen(false)}
              value={iso || null}
              quick
              onPick={(v) => {
                setDueOpen(false)
                onChange({ dueDate: v ? new Date(`${v}T12:00:00`).toISOString() : null })
              }}
            />
            {due && !readOnly && (
              <button className="tp-x" aria-label={t('task.clearDue')} title={t('task.clearDue')} onClick={() => onChange({ dueDate: null })}>
                <Icon name="close" sm />
              </button>
            )}
          </div>
        </div>
        <div className="sf">
          <div className="k">{t('task.estimate')}</div>
          {estEdit ? (
            <label className="fieldbtn">
              <input
                className="tp-est"
                autoFocus
                value={estText}
                onChange={(e) => setEstText(e.target.value)}
                onBlur={commitEst}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEst()
                  if (e.key === 'Escape') setEstEdit(false)
                }}
                placeholder="1:30"
                aria-label={t('task.estAria')}
              />
            </label>
          ) : (
            <button
              className="fieldbtn"
              disabled={readOnly}
              aria-label={t('task.estAria')}
              onClick={() => {
                setEstText(est ? fmtHm(est) : '')
                setEstEdit(true)
              }}
            >
              <span>{est ? fmtHm(est) : '—'}</span>
            </button>
          )}
        </div>
      </div>
    </>
  )
}

/** «Экраны в макете» — свои номера задачи (refs), через запятую. */
function Screens({ refs, readOnly, onChange }: { refs: string; readOnly: boolean; onChange: (refs: string) => void }) {
  const { t } = useTranslation('v2')
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const list = refs
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (readOnly && !list.length) return null
  const commit = () => {
    const add = text
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !list.includes(s))
    if (add.length) onChange([...list, ...add].join(', '))
    setText('')
    setAdding(false)
  }
  return (
    <div className="sf">
      <div className="k">{t('task.screens')}</div>
      <div className="chs">
        {list.map((s) =>
          readOnly ? (
            <span key={s} className="ch" style={{ padding: '0 10px' }}>
              {s}
            </span>
          ) : (
            <button key={s} className="ch tp-ref" style={{ padding: '0 10px' }} aria-label={t('task.removeScreen', { n: s })} title={t('task.removeScreen', { n: s })} onClick={() => onChange(list.filter((x) => x !== s).join(', '))}>
              {s}
            </button>
          ),
        )}
        {!readOnly &&
          (adding ? (
            <input
              className="ch tp-ref-in"
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') setAdding(false)
              }}
              placeholder={t('task.screenPh')}
              aria-label={t('task.addScreen')}
            />
          ) : (
            <button className="ch" aria-label={t('task.addScreen')} onClick={() => setAdding(true)}>
              <Icon name="plus" sm />
            </button>
          ))}
      </div>
    </div>
  )
}

/** Спринт — группа задач проекта. Групп нет — и выбирать не из чего. */
function Sprint({ projectId, groupId, readOnly, onChange }: { projectId: string; groupId: string | null; readOnly: boolean; onChange: (id: string | null) => void }) {
  const { t } = useTranslation('v2')
  const [open, setOpen] = useState(false)
  const groups = useQuery({
    queryKey: ['v2', 'task-groups', projectId],
    queryFn: () => api<{ id: string; name: string; color: string | null }[]>('/api/v1/tasks/groups', inProject(projectId)),
    staleTime: 60_000,
  })
  const list = groups.data ?? []
  if (!list.length) return null
  const cur = list.find((g) => g.id === groupId)
  return (
    <div className="sf">
      <div className="k">{t('task.sprint')}</div>
      <div className="cbx">
        <button className="fieldbtn" disabled={readOnly} onClick={() => setOpen(true)} aria-haspopup="listbox" aria-expanded={open}>
          <i style={{ width: 8, height: 8, borderRadius: '50%', background: cur?.color || 'var(--ink3)', flex: 'none' }} />
          <span>{cur?.name ?? t('task.noSprint')}</span>
          <Icon name="chevron" />
        </button>
        {open && (
          <PickPop
            items={[{ id: '', label: t('task.noSprint') }, ...list.map((g) => ({ id: g.id, label: g.name }))]}
            selected={groupId ?? ''}
            ph={t('task.sprint')}
            onClose={() => setOpen(false)}
            onPick={(id) => {
              setOpen(false)
              if ((id || null) !== groupId) onChange(id || null)
            }}
          />
        )}
      </div>
    </div>
  )
}

/* ───────────────────────── Новая задача ───────────────────────── */

type Member = { user: { id: string; name: string; email?: string; avatarUrl: string | null } }

/**
 * Новая задача целиком: проект, кому мяч, важность, срок, описание, чек-лист
 * и файлы. Пока задачи нет, чек-лист и файлы копятся здесь и уходят на сервер
 * сразу после создания. «Подробно» из быстрого ввода приносит название и проект.
 */
export function TaskNew() {
  const { t, i18n } = useTranslation('v2')
  const { companyId, base, project, flash } = useUi()
  const navigate = useNavigate()
  const location = useLocation()
  const pre = (location.state ?? {}) as { title?: string; projectId?: string }
  const me = useMe()
  const projects = useProjects(companyId)
  const refresh = useRefreshBall()
  const [title, setTitle] = useState(pre.title ?? '')
  const [pid, setPid] = useState<string | null>(pre.projectId ?? project ?? null)
  const [to, setTo] = useState<string | null>(null)
  const [prio, setPrio] = useState('normal')
  const [due, setDue] = useState<string | null>(null)
  const [est, setEst] = useState<number | null>(null)
  const [desc, setDesc] = useState('')
  const [checks, setChecks] = useState<{ id: string; text: string; done: boolean }[]>([])
  const [files, setFiles] = useState<File[]>([])
  const seq = useRef(0)

  const list = projects.data ?? []
  const projectId = pid && list.some((p) => p.id === pid) ? pid : (list[0]?.id ?? null)
  const cur = list.find((p) => p.id === projectId) ?? null
  const members = useQuery({
    queryKey: ['v2', 'project-members', projectId],
    queryFn: () => api<Member[]>(`/api/v1/projects/${projectId}/members`),
    enabled: Boolean(projectId),
    staleTime: 60_000,
  })
  const team = (members.data ?? []).map((m) => m.user)
  const myId = me.data?.id ?? null
  // Кому мяч: выбранный, если он есть в проекте; иначе — я.
  const who = (to && team.find((p) => p.id === to)) || team.find((p) => p.id === myId) || (me.data ? { id: me.data.id, name: me.data.name, avatarUrl: null } : null)
  const previews = useMemo(() => files.map((f) => (f.type.startsWith('image/') ? URL.createObjectURL(f) : null)), [files])
  useEffect(() => () => previews.forEach((u) => u && URL.revokeObjectURL(u)), [previews])

  const create = useMutation({
    mutationFn: async () => {
      const row = await api<{ id: string; number: string }>('/api/v1/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          description: desc,
          priority: prio,
          dueDate: due,
          assigneeId: who?.id ?? null,
          estimateMinutes: est,
        }),
        ...inProject(projectId!),
      })
      // Чек-лист и файлы — после: им нужна уже существующая задача.
      for (const c of checks)
        await api(`/api/v1/tasks/${row.id}/checklist`, { method: 'POST', body: JSON.stringify({ text: c.text }), ...inProject(projectId!) }).catch(() => null)
      for (const f of files) await uploadFile(projectId!, f, row.id).catch(() => null)
      return row
    },
    onSuccess: (row) => {
      refresh(row.id)
      flash(who && who.id !== myId ? t('task.createdTo', { id: row.number, name: who.name }) : t('task.created', { id: row.number }))
      navigate(`${base}/task/${row.id}`, { replace: true })
    },
    onError: (e) => flash(t(`err.${errorCode(e)}`, { defaultValue: errorCode(e) === '403' ? t('err.forbidden') : t('err.generic') })),
  })
  const ready = Boolean(title.trim() && projectId && !create.isPending)
  const mentions = useMemo(() => team.map((p) => ({ id: p.id, label: p.name })), [team])

  return (
    <div className="wrap" style={{ maxWidth: 1120 }}>
      <div className="tp-bar">
        <button className="back" onClick={() => navigate(base)}>
          <I name="back" />
          {t('task.back')}
        </button>
        <div className="crumb">
          {cur && <ProjectLogo project={cur} size="xs" />}
          {cur && <span className="pn">{shortProject(cur.name)}</span>}
          {cur && <span>/</span>}
          <span>{t('task.newCrumb')}</span>
        </div>
        <span className="saved" />
        <button className="btn" onClick={() => navigate(base)}>
          {t('task.cancel')}
        </button>
        <button className={'btn-acc' + (ready ? '' : ' dis')} onClick={() => ready && create.mutate()}>
          <Icon name="plus" />
          {create.isPending ? t('task.creating') : t('task.create')}
        </button>
      </div>
      <div className="tp">
        <div className="tp-main">
          <input
            className="tp-title"
            dir="auto"
            autoFocus={!pre.title}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && ready && create.mutate()}
            placeholder={t('task.titlePh')}
            aria-label={t('task.titleAria')}
          />
          <DescEditor value="" onChange={setDesc} readOnly={false} mentions={mentions} placeholder={t('task.descPh')} />
          <ChecklistView
            items={checks}
            canEdit
            onToggle={(c) => setChecks((xs) => xs.map((x) => (x.id === c.id ? { ...x, done: !x.done } : x)))}
            onAdd={(text) => setChecks((xs) => [...xs, { id: `n${seq.current++}`, text, done: false }])}
            onRemove={(c) => setChecks((xs) => xs.filter((x) => x.id !== c.id))}
          />
          <FilesView
            tiles={files.map((f, i) => ({ key: `${i}-${f.name}`, name: f.name, mime: f.type, src: previews[i], onOpen: () => setFiles((xs) => xs.filter((x) => x !== f)) }))}
            onAdd={(fs) => setFiles((xs) => [...xs, ...fs])}
            note={t('task.willAttach')}
          />
          <div className="aiN">
            <span className="spark">
              <Icon name="spark" />
            </span>
            <div style={{ flex: 1 }}>
              <p>{t('task.newHint')}</p>
            </div>
          </div>
        </div>

        <aside className="tp-side">
          <div className="sbox">
            <div className="sf">
              <div className="k">{t('task.project')}</div>
              {projects.isSuccess && !list.length ? (
                <div className="hint2" style={{ margin: 0 }}>
                  {t('task.noProjects')}
                </div>
              ) : (
                <Combo
                  cur={
                    <>
                      {cur && <ProjectLogo project={cur} size="sm" />}
                      <span className="cbx-n">{cur ? shortProject(cur.name) : t('task.pickProject')}</span>
                    </>
                  }
                  items={list.map((p) => ({ id: p.id, label: shortProject(p.name), lead: <ProjectLogo project={p} size="sm" /> }))}
                  selected={projectId}
                  onPick={setPid}
                  ph={t('task.findProject', { n: list.length })}
                  aria={`${t('task.project')}: ${cur ? shortProject(cur.name) : ''}`}
                />
              )}
            </div>
            <div className="sf">
              <div className="k">{t('task.ballTo')}</div>
              <div className="hint2" style={{ margin: '0 0 8px' }}>
                {t('task.ballToHint')}
              </div>
              <Combo
                cur={
                  <>
                    {personAv(who)}
                    <span className="cbx-n bidi">{who ? (who.id === myId ? t('task.me') : who.name) : '—'}</span>
                  </>
                }
                items={[...team]
                  .sort((a, b) => (a.id === myId ? -1 : b.id === myId ? 1 : a.name.localeCompare(b.name)))
                  .map((p) => ({ id: p.id, label: p.id === myId ? t('task.me') : p.name, lead: personAv(p) }))}
                selected={who?.id ?? null}
                onPick={setTo}
                ph={t('task.findPerson', { n: team.length })}
                aria={`${t('task.ballTo')}: ${who?.name ?? ''}`}
              />
            </div>
            <Fields
              prio={prio}
              due={due}
              est={est}
              readOnly={false}
              lng={i18n.language}
              onChange={(b) => {
                if (b.priority !== undefined) setPrio(b.priority)
                if (b.dueDate !== undefined) setDue(b.dueDate)
                if (b.estimateMinutes !== undefined) setEst(b.estimateMinutes)
              }}
            />
          </div>
        </aside>
      </div>
    </div>
  )
}
