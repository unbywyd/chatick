import { isImage } from '@/components/files/FileViewer'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, API_URL, ensureMediaToken, getMediaToken, getSessionToken, inlineImageUrl, withInlineImageAuth } from '@/lib/api'
import { RichEditor } from '@/components/ui/rich-editor'
import { errorCode, inProject, keys, useComments, useHandoffs, type Handoff, type Person, type TaskFull } from '../data'
import { useUi } from '../ui'
import { Icon } from '../Icon'
import { PassEv } from '../tasks/TaskPanel'
import { letterOf, personColor, timeAgo } from '../util'

/**
 * Куски страницы задачи: общие для полной страницы и для новой задачи —
 * выбор из списка, чек-лист, плитки файлов — и разделы, которым нужна уже
 * существующая задача (связи, ресурсы, заметки, обсуждение, история).
 */

export type TaskX = TaskFull['task'] & { refs?: string; groupId?: string | null }

/** Контуры с холста, которых нет в общем наборе иконок. */
const PATHS: Record<string, React.ReactNode> = {
  back: <path d="M19 12H6M11 6l-6 6 6 6" />,
  list: <path d="M4 6.5l1.5 1.5L8.5 5M4 15.5l1.5 1.5L8.5 14M12 6.5h8M12 15.5h8" />,
  link: <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </>
  ),
  hist: (
    <>
      <path d="M3.5 12a8.5 8.5 0 102.5-6" />
      <path d="M3 4v4.5h4.5M12 7.5V12l3 2" />
    </>
  ),
  trash: <path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12a2 2 0 002 2h7a2 2 0 002-2l1-12M9 7V4h6v3" />,
  cal: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </>
  ),
  refresh: <path d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6" />,
  chevEnd: <path d="M9 6l6 6-6 6" />,
}
export function I({ name, sm, style }: { name: keyof typeof PATHS; sm?: boolean; style?: React.CSSProperties }) {
  return (
    <svg className={'ic' + (sm ? ' sm' : '')} viewBox="0 0 24 24" aria-hidden="true" style={style}>
      {PATHS[name]}
    </svg>
  )
}

export const PRIOS: [string, string][] = [
  ['low', 'var(--ink3)'],
  ['normal', 'var(--ink2)'],
  ['high', 'var(--work)'],
  ['urgent', 'var(--signal)'],
]

/** «1:30», «1.5», «2», «90м» → минуты. Пусто — без оценки. */
export function parseEstimate(s: string): number | null | undefined {
  const v = s.trim().toLowerCase()
  if (!v) return null
  const hm = v.match(/^(\d+):(\d{1,2})$/)
  if (hm) return Number(hm[1]) * 60 + Number(hm[2])
  const m = v.match(/^(\d+)\s*(m|м|min|мин|דק)/)
  if (m) return Number(m[1])
  const h = Number(v.replace(',', '.').replace(/\s*(h|ч|ש).*$/, ''))
  return Number.isFinite(h) && h >= 0 ? Math.round(h * 60) : undefined
}

/** Загрузка файла в проект: FormData, поэтому мимо api() с его JSON. */
export async function uploadFile(projectId: string, file: File, taskId?: string): Promise<{ id: string; name: string }> {
  const fd = new FormData()
  fd.append('file', file)
  if (taskId) fd.append('taskId', taskId)
  const token = getSessionToken()
  const res = await fetch(`${API_URL}/api/v1/files`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'X-Project': projectId },
    body: fd,
  })
  if (!res.ok) throw new Error('upload failed')
  return (await res.json()) as { id: string; name: string }
}

/* ───────────── Выбор из списка (комбобокс макета) ───────────── */

export type Opt = { id: string; label: string; sub?: string; lead?: React.ReactNode }

/**
 * Всплывающий список с поиском. Если задан onQuery — ищет сервер (задачи
 * проекта, ресурсы), иначе фильтруем то, что уже есть.
 */
export function PickPop({
  items,
  onPick,
  onClose,
  ph,
  selected,
  onQuery,
  className,
}: {
  items: Opt[]
  onPick: (id: string) => void
  onClose: () => void
  ph: string
  selected?: string | null
  onQuery?: (q: string) => void
  className?: string
}) {
  const { t } = useTranslation('v2')
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const s = q.trim().toLowerCase()
  const list = onQuery ? items : items.filter((o) => !s || `${o.label} ${o.sub ?? ''}`.toLowerCase().includes(s))
  return (
    <>
      <div className="cbx-scrim" onClick={onClose} />
      <div className={'cbx-pop' + (className ? ' ' + className : '')}>
        <label className="cbx-s">
          <Icon name="search" sm />
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setHi(0)
              onQuery?.(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              if (e.key === 'ArrowDown') setHi((h) => Math.min(h + 1, list.length - 1))
              if (e.key === 'ArrowUp') setHi((h) => Math.max(h - 1, 0))
              if (e.key === 'Enter' && list[hi]) onPick(list[hi].id)
            }}
            placeholder={ph}
            aria-label={ph}
          />
        </label>
        <div className="cbx-l" role="listbox">
          {list.map((o, i) => (
            <button key={o.id} className={'cbx-o' + (i === hi ? ' hi' : '')} role="option" aria-selected={o.id === selected} onClick={() => onPick(o.id)}>
              {o.lead}
              <span className="cbx-n">{o.label}</span>
              {o.sub && <small className="pcs">{o.sub}</small>}
              {o.id === selected && <Icon name="check" sm />}
            </button>
          ))}
          {!list.length && <div className="cbx-none">{q.trim() ? t('task.noneQ', { q: q.trim() }) : t('task.nothing')}</div>}
        </div>
      </div>
    </>
  )
}

/** Поле-комбобокс: кнопка с текущим значением и список под ней. */
export function Combo({ cur, items, selected, onPick, ph, aria }: { cur: React.ReactNode; items: Opt[]; selected: string | null; onPick: (id: string) => void; ph: string; aria: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="cbx">
      <button className="cbx-f" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open} aria-label={aria}>
        {cur}
        <Icon name="chevron" sm />
      </button>
      {open && (
        <PickPop
          items={items}
          selected={selected}
          ph={ph}
          onClose={() => setOpen(false)}
          onPick={(id) => {
            onPick(id)
            setOpen(false)
          }}
        />
      )}
    </div>
  )
}

export const personAv = (p: { id: string; name: string } | null | undefined, cls = 'av pcav') => (
  <span className={cls} style={{ background: personColor(p?.id) }}>
    {letterOf(p?.name)}
  </span>
)

/* ───────────── Чек-лист ───────────── */

export type CheckRow = { id: string; text: string; done: boolean }

/** Чек-лист как на макете: прогресс, пункты, строка «новый пункт». Данные — снаружи. */
export function ChecklistView({
  items,
  onToggle,
  onAdd,
  onRemove,
  canEdit,
}: {
  items: CheckRow[]
  onToggle?: (i: CheckRow) => void
  onAdd?: (text: string) => void
  onRemove?: (i: CheckRow) => void
  canEdit: boolean
}) {
  const { t } = useTranslation('v2')
  const [text, setText] = useState('')
  const done = items.filter((c) => c.done).length
  return (
    <div className="sec2">
      <h3>
        <I name="list" />
        {t('task.checklist')}
        <span className="n">
          {done}/{items.length}
        </span>
      </h3>
      {items.length > 0 && (
        <div className="prog">
          <i style={{ width: `${Math.round((done / items.length) * 100)}%` }} />
        </div>
      )}
      {items.map((c) => (
        <div key={c.id} className="cl-row">
          <button className={'cli2' + (c.done ? ' on' : '')} onClick={() => onToggle?.(c)} disabled={!onToggle} role="checkbox" aria-checked={c.done}>
            <span className={'box' + (c.done ? ' on' : '')}>{c.done && <Icon name="check" style={{ width: 12, height: 12, strokeWidth: 2.6 }} />}</span>
            <span className="bidi">{c.text}</span>
          </button>
          {canEdit && onRemove && (
            <button className="ib" aria-label={t('task.removeItem')} onClick={() => onRemove(c)}>
              <Icon name="close" sm />
            </button>
          )}
        </div>
      ))}
      {canEdit && onAdd && (
        <label className="addrow">
          <Icon name="plus" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && text.trim()) {
                onAdd(text.trim())
                setText('')
              }
            }}
            placeholder={t('task.itemPh')}
            aria-label={t('task.itemAria')}
            dir="auto"
          />
        </label>
      )}
    </div>
  )
}

/** Чек-лист существующей задачи — на сервере. */
export function TaskChecklist({ task, canEdit }: { task: TaskX; canEdit: boolean }) {
  const { t } = useTranslation('v2')
  const { flash } = useUi()
  const qc = useQueryClient()
  const pid = task.project!.id
  const key = ['v2', 'checklist', task.id]
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<{ items: CheckRow[] }>(`/api/v1/tasks/${task.id}/checklist`, inProject(pid)).then((r) => r.items),
  })
  const fail = (e: unknown) => flash(t(`err.${errorCode(e)}`, { defaultValue: t('err.generic') }))
  const settle = () => void qc.invalidateQueries({ queryKey: key })
  const toggle = useMutation({
    mutationFn: (i: CheckRow) => api(`/api/v1/tasks/${task.id}/checklist/${i.id}`, { method: 'PATCH', body: JSON.stringify({ done: !i.done }), ...inProject(pid) }),
    onMutate: (i) => qc.setQueryData<CheckRow[]>(key, (old) => old?.map((x) => (x.id === i.id ? { ...x, done: !x.done } : x))),
    onError: fail,
    onSettled: settle,
  })
  const add = useMutation({
    mutationFn: (text: string) => api(`/api/v1/tasks/${task.id}/checklist`, { method: 'POST', body: JSON.stringify({ text }), ...inProject(pid) }),
    onError: fail,
    onSettled: settle,
  })
  const remove = useMutation({
    mutationFn: (i: CheckRow) => api(`/api/v1/tasks/${task.id}/checklist/${i.id}`, { method: 'DELETE', ...inProject(pid) }),
    onMutate: (i) => qc.setQueryData<CheckRow[]>(key, (old) => old?.filter((x) => x.id !== i.id)),
    onError: fail,
    onSettled: settle,
  })
  return <ChecklistView items={q.data ?? []} canEdit={canEdit} onToggle={(i) => toggle.mutate(i)} onAdd={(s) => add.mutate(s)} onRemove={(i) => remove.mutate(i)} />
}

/* ───────────── Файлы ───────────── */

export type Tile = { key: string; name: string; mime: string; src?: string | null; onOpen?: () => void }

const kindOf = (f: { name: string; mime: string }) => {
  const ext = f.name.toLowerCase().split('.').pop() ?? ''
  // Картинку узнаёт общий isImage: файлы без типа (из почты, со старых загрузок) — тоже картинки.
  if (isImage(f)) return 'img'
  if (f.mime.startsWith('video/') || ['mp4', 'webm', 'mov'].includes(ext)) return 'vid'
  if (/pdf|word|excel|sheet|presentation|document|text|csv/.test(f.mime)) return 'doc'
  return 'oth'
}

/**
 * Плитки вложений и плитка «перетащи или вставь». Вставка из буфера ловится
 * на всей странице, кроме полей ввода и редактора: там вставка — это текст.
 */
export function FilesView({ tiles, onAdd, busy, note }: { tiles: Tile[]; onAdd?: (files: File[]) => void; busy?: boolean; note?: string }) {
  const { t } = useTranslation('v2')
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  useEffect(() => {
    if (!onAdd) return
    const onPaste = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el?.closest('input, textarea, [contenteditable="true"]')) return
      const files = Array.from(e.clipboardData?.files ?? [])
      if (files.length) {
        e.preventDefault()
        onAdd(files)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [onAdd])
  return (
    <div className="sec2">
      <h3>
        <Icon name="attach" />
        {t('task.files')}
        <span className="n">{tiles.length || ''}</span>
        {onAdd && (
          <button className="addl act" onClick={() => input.current?.click()}>
            <Icon name="plus" sm />
            {t('task.attach')}
          </button>
        )}
      </h3>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length) onAdd?.(files)
          e.target.value = ''
        }}
      />
      <div className="minis">
        {tiles.map((f) => {
          const kind = kindOf(f)
          return (
            <div key={f.key} className="ftile">
              <button className={`fthumb th-${kind}`} aria-label={t('task.openFile', { name: f.name })} onClick={f.onOpen} title={f.name}>
                {kind === 'img' && f.src && <img src={f.src} alt="" loading="lazy" />}
                {kind === 'vid' && (
                  <span className="pl">
                    <Icon name="play" fill />
                  </span>
                )}
                <span className="fext">{(f.name.split('.').pop() ?? '').toUpperCase().slice(0, 5)}</span>
              </button>
              <div className="fname bidi" title={f.name}>
                {f.name}
              </div>
            </div>
          )
        })}
        {onAdd && (
          <div className="ftile">
            <button
              className={'fthumb th-oth tp-drop' + (over ? ' over' : '')}
              onClick={() => input.current?.click()}
              onDragOver={(e) => {
                e.preventDefault()
                setOver(true)
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setOver(false)
                const files = Array.from(e.dataTransfer.files)
                if (files.length) onAdd(files)
              }}
            >
              {busy ? t('task.uploading') : t('task.drop')}
            </button>
          </div>
        )}
      </div>
      {note && tiles.length > 0 && <div className="hint2">{note}</div>}
    </div>
  )
}

type FileRow = { id: string; name: string; mime: string; deleted?: boolean }

/** Вложения существующей задачи: список с сервера, загрузка сразу в задачу. */
export function TaskFiles({ task, canAttach }: { task: TaskX; canAttach: boolean }) {
  const { t } = useTranslation('v2')
  const { flash } = useUi()
  const qc = useQueryClient()
  const pid = task.project!.id
  const key = ['v2', 'task-files', task.id]
  const [media, setMedia] = useState(getMediaToken())
  useEffect(() => {
    void ensureMediaToken().then(() => setMedia(getMediaToken()))
  }, [])
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<{ items: FileRow[] }>(`/api/v1/files?taskId=${encodeURIComponent(task.id)}`, inProject(pid)).then((r) => r.items),
  })
  const up = useMutation({
    mutationFn: async (files: File[]) => {
      for (const f of files) await uploadFile(pid, f, task.id)
    },
    onError: () => flash(t('task.uploadFailed')),
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  })
  const open = (f: FileRow) =>
    void api<{ url: string }>(`/api/v1/files/${f.id}/view-url`, inProject(pid))
      .then((r) => window.open(r.url, '_blank', 'noopener'))
      .catch(() => flash(t('err.generic')))
  const tiles: Tile[] = (q.data ?? [])
    .filter((f) => !f.deleted)
    .map((f) => ({ key: f.id, name: f.name, mime: f.mime, src: media ? withInlineImageAuth(inlineImageUrl(f.id)) : null, onOpen: () => open(f) }))
  return <FilesView tiles={tiles} onAdd={canAttach ? (fs) => up.mutate(fs) : undefined} busy={up.isPending} />
}

/* ───────────── Связи ───────────── */

type LinkTask = { id: string; number: string; title: string; status: string }
type RelKind = 'blockers' | 'blocking' | 'from' | 'into' | 'related'

export function TaskRelations({ task, canEdit }: { task: TaskX; canEdit: boolean }) {
  const { t } = useTranslation('v2')
  const { base, flash } = useUi()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const pid = task.project!.id
  const bKey = ['v2', 'task-blockers', task.id]
  const lKey = ['v2', 'task-links', task.id]
  const blockers = useQuery({
    queryKey: bKey,
    queryFn: () => api<{ blockers: LinkTask[]; blocking: LinkTask[] }>(`/api/v1/tasks/${task.id}/blockers`, inProject(pid)),
  })
  const links = useQuery({
    queryKey: lKey,
    queryFn: () => api<{ derivedFrom: LinkTask[]; derivedInto: LinkTask[]; related: LinkTask[] }>(`/api/v1/tasks/${task.id}/links`, inProject(pid)),
  })
  const [adding, setAdding] = useState<RelKind | null>(null)
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  useEffect(() => {
    const h = window.setTimeout(() => setDq(q.trim()), 250)
    return () => window.clearTimeout(h)
  }, [q])
  const isBlock = adding === 'blockers' || adding === 'blocking'
  const cands = useQuery({
    queryKey: ['v2', 'task-rel-cands', task.id, isBlock ? adding : 'links', dq],
    queryFn: () =>
      api<{ items: LinkTask[] }>(
        isBlock
          ? `/api/v1/tasks/${task.id}/blockers/candidates?side=${adding}&q=${encodeURIComponent(dq)}`
          : `/api/v1/tasks/${task.id}/links/candidates?q=${encodeURIComponent(dq)}`,
        inProject(pid),
      ).then((r) => r.items),
    enabled: Boolean(adding),
  })
  const add = useMutation({
    mutationFn: ({ kind, id }: { kind: RelKind; id: string }) =>
      kind === 'blockers' || kind === 'blocking'
        ? api(`/api/v1/tasks/${task.id}/blockers`, { method: 'POST', body: JSON.stringify({ taskIds: [id], side: kind }), ...inProject(pid) })
        : api(`/api/v1/tasks/${task.id}/links`, {
            method: 'POST',
            body: JSON.stringify({ taskIds: [id], kind: kind === 'related' ? 'related' : 'derived', direction: kind === 'into' ? 'into' : 'from' }),
            ...inProject(pid),
          }),
    onError: (e) => flash(t(`err.${errorCode(e)}`, { defaultValue: t('err.generic') })),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: bKey })
      void qc.invalidateQueries({ queryKey: lKey })
    },
  })
  const rows: [RelKind, LinkTask[]][] = [
    ['blockers', blockers.data?.blockers ?? []],
    ['blocking', blockers.data?.blocking ?? []],
    ['from', links.data?.derivedFrom ?? []],
    ['into', links.data?.derivedInto ?? []],
    ['related', links.data?.related ?? []],
  ]
  return (
    <div className="sec2">
      <h3>
        <I name="link" />
        {t('task.links')}
      </h3>
      <div className="relbox">
        {rows.map(([kind, items], i) => {
          const [label, empty, addLabel] = t(`task.rel.${kind}`, { returnObjects: true }) as [string, string, string]
          return (
            <div key={kind} className={'rel' + (i === 0 ? ' first' : '')}>
              <span className="k">{label}</span>
              <div className="v">
                {items.map((x) => (
                  <button key={x.id} className="tchip tp-chip" title={x.title} onClick={() => navigate(`${base}/task/${x.id}`)}>
                    {x.number} <span className="bidi">{x.title}</span>
                  </button>
                ))}
                {!items.length && <span>{empty}</span>}
              </div>
              {canEdit && (
                <div className="cbx tp-pop-end">
                  <button
                    className="addl"
                    onClick={() => {
                      setQ('')
                      setDq('')
                      setAdding(kind)
                    }}
                  >
                    <Icon name="plus" sm />
                    {addLabel}
                  </button>
                  {adding === kind && (
                    <PickPop
                      items={(cands.data ?? []).map((c) => ({ id: c.id, label: `${c.number} · ${c.title}` }))}
                      ph={t('task.findTask')}
                      onQuery={setQ}
                      onClose={() => setAdding(null)}
                      onPick={(id) => {
                        add.mutate({ kind, id })
                        setAdding(null)
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ───────────── Ресурсы ───────────── */

type Res = { id: string; name: string; url: string | null }

export function TaskResources({ task, canEdit }: { task: TaskX; canEdit: boolean }) {
  const { t } = useTranslation('v2')
  const { flash } = useUi()
  const qc = useQueryClient()
  const pid = task.project!.id
  const key = ['v2', 'task-res', task.id]
  const [open, setOpen] = useState(false)
  const q = useQuery({ queryKey: key, queryFn: () => api<{ items: Res[] }>(`/api/v1/tasks/${task.id}/resources`, inProject(pid)).then((r) => r.items) })
  const cands = useQuery({
    queryKey: ['v2', 'task-res-cands', task.id],
    queryFn: () => api<{ items: Res[] }>(`/api/v1/tasks/${task.id}/resources/candidates`, inProject(pid)).then((r) => r.items),
    enabled: open,
  })
  const add = useMutation({
    mutationFn: (id: string) => api(`/api/v1/tasks/${task.id}/resources`, { method: 'POST', body: JSON.stringify({ resourceIds: [id] }), ...inProject(pid) }),
    onError: (e) => flash(t(`err.${errorCode(e)}`, { defaultValue: t('err.generic') })),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key })
      void qc.invalidateQueries({ queryKey: ['v2', 'task-res-cands', task.id] })
    },
  })
  const items = q.data ?? []
  return (
    <div className="sec2">
      <h3>
        <I name="lock" />
        {t('task.resources')}
        {canEdit && (
          <span className="cbx tp-pop-end act" style={{ marginInlineStart: 'auto' }}>
            <button className="addl" onClick={() => setOpen(true)}>
              <Icon name="plus" sm />
              {t('task.linkRes')}
            </button>
            {open && (
              <PickPop
                items={(cands.data ?? []).map((r) => ({ id: r.id, label: r.name, sub: r.url ?? undefined }))}
                ph={t('task.findRes')}
                onClose={() => setOpen(false)}
                onPick={(id) => {
                  add.mutate(id)
                  setOpen(false)
                }}
              />
            )}
          </span>
        )}
      </h3>
      <div className="minis">
        {items.map((r) => {
          const inner = (
            <>
              <span className="rk">
                <I name="link" sm />
              </span>
              <span className="bidi">{r.name}</span>
            </>
          )
          return r.url ? (
            <a key={r.id} className="rchip" href={r.url} target="_blank" rel="noopener noreferrer">
              {inner}
            </a>
          ) : (
            <span key={r.id} className="rchip">
              {inner}
            </span>
          )
        })}
        {!items.length && q.isSuccess && <span style={{ color: 'var(--ink3)', fontSize: 14 }}>{t('task.noRes')}</span>}
      </div>
    </div>
  )
}

/* ───────────── Заметки ИИ ───────────── */

export function TaskNotes({ task, canEdit }: { task: TaskX; canEdit: boolean }) {
  const { t } = useTranslation('v2')
  const { flash } = useUi()
  const qc = useQueryClient()
  const pid = task.project!.id
  const key = ['v2', 'task-notes', task.id]
  const q = useQuery({ queryKey: key, queryFn: () => api<{ id: string; body: string }[]>(`/api/v1/tasks/${task.id}/notes`, inProject(pid)) })
  const regen = useMutation({
    mutationFn: () => api(`/api/v1/tasks/${task.id}/notes/regenerate`, { method: 'POST', ...inProject(pid) }),
    onError: () => flash(t('task.aiFailed')),
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  })
  const notes = q.data ?? []
  if (!q.isSuccess || (!notes.length && !canEdit)) return null
  return (
    <div className="aiN">
      <span className="spark">
        <Icon name="spark" />
      </span>
      <div style={{ flex: 1 }}>
        {notes.length ? (
          notes.map((n, i) => (
            <p key={n.id} className="bidi">
              {i === 0 && <b>{t('task.aiNotes')} </b>}
              {n.body}
            </p>
          ))
        ) : (
          <p>
            <b>{t('task.aiNotes')} </b>
            {t('task.aiNone')}
          </p>
        )}
      </div>
      {canEdit && (
        <button className="ib" aria-label={t('task.aiRefresh')} title={t('task.aiRefresh')} onClick={() => regen.mutate()} disabled={regen.isPending}>
          <I name="refresh" style={regen.isPending ? { opacity: 0.4 } : undefined} />
        </button>
      )}
    </div>
  )
}

/* ───────────── Обсуждение ───────────── */

/** Длинный комментарий сворачивается, как на макете: «Показать целиком». */
function CommentBody({ body }: { body: string }) {
  const { t } = useTranslation('v2')
  const ref = useRef<HTMLDivElement>(null)
  const [tall, setTall] = useState(false)
  const [full, setFull] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setTall(el.scrollHeight > 140))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <>
      <div ref={ref} className={'cmt-body bidi' + (full || !tall ? ' full' : ' cut')}>
        <RichEditor value={body} onChange={() => {}} mentions={[]} preset="full" readOnly />
      </div>
      {tall && !full && (
        <button className="more2" style={{ marginTop: 6 }} onClick={() => setFull(true)}>
          {t('task.showAll')}
        </button>
      )}
    </>
  )
}

type Cmt = { id: string; body: string; createdAt: string; author: Person | null; deleted?: boolean }

export function TaskDiscussion({ task, lng }: { task: TaskX; lng: string }) {
  const { t } = useTranslation('v2')
  const { flash } = useUi()
  const qc = useQueryClient()
  const pid = task.project!.id
  const handoffs = useHandoffs(task)
  const comments = useComments(task)
  const [text, setText] = useState('')
  const [att, setAtt] = useState<{ id: string; name: string }[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const up = useMutation({
    mutationFn: async (files: File[]) => {
      const out: { id: string; name: string }[] = []
      for (const f of files) out.push(await uploadFile(pid, f))
      return out
    },
    onSuccess: (r) => setAtt((a) => [...a, ...r]),
    onError: () => flash(t('task.uploadFailed')),
  })
  const send = useMutation({
    mutationFn: () =>
      api(`/api/v1/tasks/${task.id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: text.trim(), attachmentIds: att.map((a) => a.id) }),
        ...inProject(pid),
      }),
    onSuccess: () => {
      setText('')
      setAtt([])
      void qc.invalidateQueries({ queryKey: keys.comments(task.id) })
      if (att.length) void qc.invalidateQueries({ queryKey: ['v2', 'task-files', task.id] })
    },
    onError: (e) => flash(t(`err.${errorCode(e)}`, { defaultValue: t('err.generic') })),
  })
  type Ev = { at: string; h?: Handoff; c?: Cmt }
  const list = (comments.data ?? []) as Cmt[]
  const live = list.filter((c) => !c.deleted)
  const evs: Ev[] = [...(handoffs.data ?? []).map((h) => ({ at: h.createdAt, h })), ...live.map((c) => ({ at: c.createdAt, c }))].sort((a, b) =>
    a.at.localeCompare(b.at),
  )
  const can = text.trim() && !send.isPending
  return (
    <div className="sec2">
      <h3>
        {t('task.discussion')}
        <span className="n">{live.length || ''}</span>
      </h3>
      <div className="cmts">
        {evs.length > 0 && (
          <div className="feed">
            {evs.map((e) =>
              e.h ? (
                <PassEv key={e.h.id} h={e.h} lng={lng} />
              ) : (
                <div key={e.c!.id} className="cmt">
                  {personAv(e.c!.author, 'av lg')}
                  <div className="b">
                    <div className="n">
                      <span className="bidi">{e.c!.author?.name ?? '—'}</span>
                      <time>{timeAgo(lng, e.at)}</time>
                    </div>
                    <CommentBody body={e.c!.body} />
                  </div>
                </div>
              ),
            )}
          </div>
        )}
        <div className="composer">
          <textarea
            value={text}
            dir="auto"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && can) {
                e.preventDefault()
                send.mutate()
              }
            }}
            placeholder={t('task.commentPh')}
            aria-label={t('task.commentAria')}
          />
          {att.length > 0 && (
            <div className="tp-att">
              {att.map((a) => (
                <span key={a.id} className="tchip bidi">
                  {a.name}
                  <button aria-label={t('task.removeItem')} onClick={() => setAtt((x) => x.filter((y) => y.id !== a.id))}>
                    <Icon name="close" sm />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="r">
            <button className="addl" onClick={() => fileRef.current?.click()} disabled={up.isPending}>
              <Icon name="attach" sm />
              {up.isPending ? t('task.uploading') : t('task.attach')}
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? [])
                if (files.length) up.mutate(files)
                e.target.value = ''
              }}
            />
            <button className={'btn-acc' + (can ? '' : ' dis')} style={{ marginInlineStart: 'auto', height: 36 }} onClick={() => can && send.mutate()}>
              {t('task.send')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ───────────── История ───────────── */

type HistItem = {
  id: string
  action: string
  meta: { changed?: string[]; before?: Record<string, unknown>; after?: Record<string, unknown> } | null
  createdAt: string
  actor: Person | null
}

export function TaskHistory({ task, lng }: { task: TaskX; lng: string }) {
  const { t } = useTranslation('v2')
  const [open, setOpen] = useState(false)
  const pid = task.project!.id
  const q = useQuery({
    queryKey: ['v2', 'task-history', task.id, task.updatedAt],
    queryFn: () => api<{ items: HistItem[]; people: Record<string, string> }>(`/api/v1/tasks/${task.id}/history`, inProject(pid)),
  })
  const items = q.data?.items ?? []
  const people = q.data?.people ?? {}
  const st = (v: unknown) => t(`task.st.${String(v)}`, { defaultValue: String(v ?? '—') })
  const pr = (v: unknown) => t(`task.prio.${String(v)}`, { defaultValue: String(v ?? '—') })
  const line = (x: HistItem): string => {
    if (x.action === 'create') return t('task.hist.create')
    if (x.action === 'delete') return t('task.hist.delete')
    if (x.action === 'restore') return t('task.hist.restore')
    const a = x.meta?.after ?? {}
    const b = x.meta?.before ?? {}
    const parts: string[] = []
    if ('status' in a) parts.push(t('task.hist.status', { from: st(b.status), to: st(a.status) }))
    if ('assigneeId' in a) parts.push(t('task.hist.assign', { to: a.assigneeId ? (people[String(a.assigneeId)] ?? '—') : '—' }))
    if ('priority' in a) parts.push(t('task.hist.priority', { from: pr(b.priority), to: pr(a.priority) }))
    if ('dueDate' in a)
      parts.push(t('task.hist.due', { to: a.dueDate ? new Date(String(a.dueDate)).toLocaleDateString(lng, { month: 'short', day: 'numeric' }) : t('due.none') }))
    return parts.join(' · ') || t('task.hist.update')
  }
  return (
    <>
      <button className="hist-l" onClick={() => setOpen(!open)} aria-expanded={open}>
        <I name="hist" />
        {t('task.history')}
        <span style={{ marginInlineStart: 'auto', color: 'var(--ink3)', fontWeight: 400 }}>{t('task.changes', { count: items.length })}</span>
        <I name="chevEnd" style={{ transform: open ? 'rotate(90deg)' : undefined }} />
      </button>
      {open && (
        <div className="feed tp-hist">
          {[...items].reverse().map((x) => (
            <div key={x.id} className="cm sys">
              {personAv(x.actor, 'av')}
              <div className="b">
                <span className="n bidi">{x.actor?.name ?? t('task.hist.ai')}</span>
                <span className="x bidi">{line(x)}</span>
                <time style={{ color: 'var(--ink3)', fontSize: 12.5, marginInlineStart: 'auto' }}>{timeAgo(lng, x.createdAt)}</time>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/* ───────────── Описание ───────────── */

/**
 * Описание в редакторе. Длинное сворачивается («Показать описание
 * целиком»); щелчок внутрь разворачивает — править вслепую под шторкой нельзя.
 */
export function DescEditor({
  value,
  onChange,
  readOnly,
  mentions,
  placeholder,
}: {
  value: string
  onChange: (html: string) => void
  readOnly: boolean
  mentions: { id: string; label: string }[]
  placeholder: string
}) {
  const { t } = useTranslation('v2')
  const ref = useRef<HTMLDivElement>(null)
  const [tall, setTall] = useState(false)
  const [full, setFull] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setTall(el.scrollHeight > 380))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const clipped = tall && !full
  const ment = useMemo(() => mentions, [mentions])
  return (
    <div className="edit tp-edit">
      <div ref={ref} className={'doc' + (clipped ? ' clip' : '')} onFocusCapture={() => setFull(true)}>
        <RichEditor value={value} onChange={(html) => onChange(html)} mentions={ment} preset="full" readOnly={readOnly} placeholder={placeholder} />
      </div>
      {clipped && (
        <button className="more2" onClick={() => setFull(true)}>
          {t('task.showFull')}
        </button>
      )}
    </div>
  )
}
