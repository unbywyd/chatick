import { isImage } from '@/components/files/FileViewer'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, API_URL, ensureMediaToken, getMediaToken, getSessionToken, inlineImageUrl, withInlineImageAuth } from '@/lib/api'
import { RichEditor, type RichMention } from '@/components/ui/rich-editor'
import { parseDuration } from '@/lib/time-parse'
import { errorCode, inProject, keys, useComments, useHandoffs, useMe, type Handoff, type Person, type TaskFull } from '../data'
import { kindOf as libKind, srcOf, Viewer, type FileItem, type Row as FileRowFull } from '../library/FileViewer'
import '../i18n/list'
import { useUi } from '../ui'
import { Icon } from '../Icon'
import { Clamp } from '../Clamp'
import { fmtHm, letterOf, personColor, timeAgo } from '../util'

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
  reply: <path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 010 11H11" />,
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

/**
 * Оценка → минуты. Правило то же, что у часов и в первой версии
 * (lib/time-parse): голое число читается как на часах — «45» это 45 минут,
 * «230» это 2:30. Раньше голое число здесь было часами, и привычные «230»
 * давали оценку в 230 часов. Русские и ивритские единицы приводим к h/m:
 * «2ч», «1ч30», «90мин», «2 ש». Пусто — без оценки, непонятное — undefined.
 */
export function parseEstimate(s: string): number | null | undefined {
  const v = s.trim().toLowerCase()
  if (!v) return null
  const norm = v
    .replace(/\s+/g, '')
    .replace(/(часов|часа|час|ч|שעות|שעה|ש)/g, 'h')
    .replace(/(минуты|минут|мин|м|דקות|דק)/g, 'm')
  const n = parseDuration(norm)
  return n === null ? undefined : n
}

/** Загрузка файла в проект: FormData, поэтому мимо api() с его JSON. */
export async function uploadFile(projectId: string, file: File, taskId?: string, opts?: { keepOriginal?: boolean }): Promise<{ id: string; name: string }> {
  const fd = new FormData()
  fd.append('file', file)
  if (taskId) fd.append('taskId', taskId)
  // «Без сжатия»: картинка сохранится как есть — для макетов и скриншотов, где важен каждый пиксель.
  if (opts?.keepOriginal) fd.append('keepOriginal', '1')
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
export function FilesView({ tiles, onAdd, busy, note, extra }: { tiles: Tile[]; onAdd?: (files: File[]) => void; busy?: boolean; note?: string; extra?: React.ReactNode }) {
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
        {extra}
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

/**
 * Просмотр файла задачи — тот же, что в «Файлах»: посмотреть, скачать,
 * поделиться, удалить. Файл берём целиком с сервера: в списках задачи у него
 * нет размера и автора.
 */
function useFileViewer(project: TaskX['project'], onDeleted?: () => void) {
  const { t } = useTranslation('v2')
  const { flash } = useUi()
  const [row, setRow] = useState<FileRowFull | null>(null)
  const open = (id: string) => {
    if (!project) return
    void api<FileItem>(`/api/v1/files/${id}`, inProject(project.id))
      .then((f) => setRow({ ...f, taskNumber: f.taskNumber ?? null, project: { ...project }, kind: libKind(f), src: srcOf(f) }))
      .catch(() => flash(t('err.generic')))
  }
  const node = row ? <Viewer f={row} onClose={() => setRow(null)} onDeleted={onDeleted} /> : null
  return { open, node }
}

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
  const [keep, setKeep] = useState(false)
  const up = useMutation({
    mutationFn: async (files: File[]) => {
      for (const f of files) await uploadFile(pid, f, task.id, { keepOriginal: keep })
    },
    onError: () => flash(t('task.uploadFailed')),
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  })
  const viewer = useFileViewer(task.project, () => void qc.invalidateQueries({ queryKey: key }))
  const tiles: Tile[] = (q.data ?? [])
    .filter((f) => !f.deleted)
    .map((f) => ({ key: f.id, name: f.name, mime: f.mime, src: media ? withInlineImageAuth(inlineImageUrl(f.id)) : null, onOpen: () => viewer.open(f.id) }))
  return (
    <>
      <FilesView
        tiles={tiles}
        onAdd={canAttach ? (fs) => up.mutate(fs) : undefined}
        busy={up.isPending}
        extra={
          canAttach ? (
            <label className="keep-orig" title={t('task.keepOrigHint')}>
              <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
              {t('task.keepOrig')}
            </label>
          ) : null
        }
      />
      {viewer.node}
    </>
  )
}

/* ───────────── Связи ───────────── */

type LinkTask = { id: string; number: string; title: string; status: string; linkId?: string }
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
  // Ошибочную связь или снятый блокер — убрать.
  const drop = useMutation({
    mutationFn: ({ kind, linkId }: { kind: RelKind; linkId: string }) =>
      api(`/api/v1/tasks/${task.id}/${kind === 'blockers' || kind === 'blocking' ? 'blockers' : 'links'}/${linkId}`, { method: 'DELETE', ...inProject(pid) }),
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
                  <span key={x.id} className="tchip tp-chip rel-chip">
                    <button className="rel-go" title={x.title} onClick={() => navigate(`${base}/task/${x.id}`)}>
                      {x.number} <span className="bidi">{x.title}</span>
                    </button>
                    {canEdit && x.linkId && (
                      <button className="rel-x" aria-label={t('task.relRemove')} title={t('task.relRemove')} disabled={drop.isPending} onClick={() => drop.mutate({ kind, linkId: x.linkId! })}>
                        <Icon name="close" sm />
                      </button>
                    )}
                  </span>
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
  const unlink = useMutation({
    mutationFn: (id: string) => api(`/api/v1/tasks/${task.id}/resources/${id}`, { method: 'DELETE', ...inProject(pid) }),
    onError: (e) => flash(t(`err.${errorCode(e)}`, { defaultValue: t('err.generic') })),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key })
      void qc.invalidateQueries({ queryKey: ['v2', 'task-res-cands', task.id] })
    },
  })
  // Новый ресурс прямо из задачи: завести и сразу привязать.
  const [creating, setCreating] = useState(false)
  const [rName, setRName] = useState('')
  const [rUrl, setRUrl] = useState('')
  const create = useMutation({
    mutationFn: async () => {
      const r = await api<{ id: string }>('/api/v1/resources', { method: 'POST', body: JSON.stringify({ name: rName.trim(), url: rUrl.trim() || null }), ...inProject(pid) })
      await api(`/api/v1/tasks/${task.id}/resources`, { method: 'POST', body: JSON.stringify({ resourceIds: [r.id] }), ...inProject(pid) })
    },
    onSuccess: () => {
      setCreating(false)
      setRName('')
      setRUrl('')
    },
    onError: (e) => flash(t(`err.${errorCode(e)}`, { defaultValue: t('err.generic') })),
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
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
            <button className="addl" onClick={() => setCreating(!creating)}>
              <Icon name="plus" sm />
              {t('task.resNew')}
            </button>
          </span>
        )}
      </h3>
      {creating && (
        <div className="res-new">
          <input className="nin bidi" autoFocus value={rName} maxLength={200} onChange={(e) => setRName(e.target.value)} placeholder={t('task.resName')} aria-label={t('task.resName')} />
          <input className="nin" dir="ltr" value={rUrl} maxLength={2000} onChange={(e) => setRUrl(e.target.value)} placeholder="https://" aria-label={t('task.resUrl')} />
          <button className={'btn-acc' + (rName.trim() && !create.isPending ? '' : ' dis')} onClick={() => rName.trim() && create.mutate()}>
            {t('task.resCreate')}
          </button>
          <button className="btn" onClick={() => setCreating(false)}>
            {t('lt.cancel')}
          </button>
        </div>
      )}
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
          const x = canEdit ? (
            <button className="rel-x" aria-label={t('task.resRemove')} title={t('task.resRemove')} disabled={unlink.isPending} onClick={() => unlink.mutate(r.id)}>
              <Icon name="close" sm />
            </button>
          ) : null
          return r.url ? (
            <span key={r.id} className="rchip-w">
              <a className="rchip" href={r.url} target="_blank" rel="noopener noreferrer">
                {inner}
              </a>
              {x}
            </span>
          ) : (
            <span key={r.id} className="rchip-w">
              <span className="rchip">{inner}</span>
              {x}
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

type Cmt = { id: string; body: string; createdAt: string; author: Person | null; deleted?: boolean; replyToId?: string | null; files?: FileRow[] }

/** Текст комментария одной строкой — для цитаты над ответом. */
const plainOf = (html: string) =>
  (new DOMParser().parseFromString(html.replace(/<br\s*\/?>|<\/(p|li|h\d)>/gi, ' '), 'text/html').body.textContent ?? '').replace(/@\[([^\]]+)\]\([^)]+\)/g, '@$1').replace(/\s+/g, ' ').trim()

/** Над ответом — на что отвечают. Щелчок ведёт к исходной реплике. */
function ReplyQuote({ parent }: { parent: Cmt | undefined }) {
  const { t } = useTranslation('v2')
  const gone = !parent || parent.deleted
  return (
    <button
      className="cmt-quote"
      disabled={gone}
      onClick={() => parent && document.getElementById(`cmt-${parent.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
    >
      <I name="reply" sm />
      {!gone && parent.author && <b className="bidi">{parent.author.name}</b>}
      <span className="bidi">{gone ? t('task.cmtDeleted') : plainOf(parent.body)}</span>
    </button>
  )
}

/** Передача мяча в ленте обсуждения: кто → кому, какой ход, записка. */
export function PassEv({ h, lng }: { h: Handoff; lng: string }) {
  const { t } = useTranslation('v2')
  const who = h.actor ?? h.from
  const to = h.to
  const verb = t(`panel.verb.${h.action}`, { defaultValue: '' })
  const showMv = ['review', 'ask', 'answer', 'pass', 'return'].includes(h.action) && h.moveAfter
  return (
    <div className={'pass-ev' + (h.action === 'return' ? ' ret' : h.action === 'accept' ? ' ok' : '')}>
      <div className="hd2">
        <span className="av" style={{ background: personColor(who?.id) }}>
          {letterOf(who?.name)}
        </span>
        <b className="bidi">{who?.name ?? 'Chatick'}</b>
        {to && to.id !== who?.id && h.action !== 'accept' && h.action !== 'cancel' && (
          <>
            <span className="ar3">
              <Icon name="arrow" sm />
            </span>
            <span className="av" style={{ background: personColor(to.id) }}>
              {letterOf(to.name)}
            </span>
            <b className="bidi">{to.name}</b>
          </>
        )}
        {showMv && (
          <span className={`mv mv-${h.moveAfter}`}>
            <i />
            {t(`mv.${h.moveAfter}`)}
          </span>
        )}
        {verb && !showMv && <span className="vt">{verb}</span>}
        <time>{timeAgo(lng, h.createdAt)}</time>
      </div>
      {h.note && (
        <Clamp max={160}>
          <div className="note2 cbody">
            <RichEditor value={h.note} onChange={() => {}} mentions={[]} preset="minimal" readOnly />
          </div>
        </Clamp>
      )}
    </div>
  )
}

export function TaskDiscussion({ task, lng, mentions }: { task: TaskX; lng: string; mentions: RichMention[] }) {
  const { t } = useTranslation('v2')
  const { flash } = useUi()
  const qc = useQueryClient()
  const pid = task.project!.id
  const handoffs = useHandoffs(task)
  const comments = useComments(task)
  const myId = useMe().data?.id
  // Свой комментарий можно поправить или удалить (удалённый остаётся плашкой).
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [delAsk, setDelAsk] = useState<string | null>(null)
  const refreshCmts = () => void qc.invalidateQueries({ queryKey: keys.comments(task.id) })
  const edit = useMutation({
    mutationFn: (id: string) => api(`/api/v1/tasks/${task.id}/comments/${id}`, { method: 'PATCH', body: JSON.stringify({ body: editText }), ...inProject(pid) }),
    onSuccess: () => setEditing(null),
    onError: (e) => flash(t(`err.${errorCode(e)}`, { defaultValue: t('err.generic') })),
    onSettled: refreshCmts,
  })
  const del = useMutation({
    mutationFn: (id: string) => api(`/api/v1/tasks/${task.id}/comments/${id}`, { method: 'DELETE', ...inProject(pid) }),
    onSuccess: () => setDelAsk(null),
    onError: (e) => flash(t(`err.${errorCode(e)}`, { defaultValue: t('err.generic') })),
    onSettled: refreshCmts,
  })
  const viewer = useFileViewer(task.project, () => void qc.invalidateQueries({ queryKey: ['v2', 'task-files', task.id] }))
  // Комментарий — тот же редактор, что в панели задачи: разметка и @ с уведомлением.
  const [text, setText] = useState('')
  const [edKey, setEdKey] = useState(0)
  const empty = !text.replace(/<[^>]*>/g, '').trim()
  const [att, setAtt] = useState<{ id: string; name: string }[]>([])
  const [replyTo, setReplyTo] = useState<Cmt | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
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
        body: JSON.stringify({ body: text, replyToId: replyTo?.id ?? null, attachmentIds: att.map((a) => a.id) }),
        ...inProject(pid),
      }),
    onSuccess: () => {
      setText('')
      setEdKey((k) => k + 1)
      setAtt([])
      setReplyTo(null)
      void qc.invalidateQueries({ queryKey: keys.comments(task.id) })
      if (att.length) void qc.invalidateQueries({ queryKey: ['v2', 'task-files', task.id] })
    },
    onError: (e) => flash(t(`err.${errorCode(e)}`, { defaultValue: t('err.generic') })),
  })
  type Ev = { at: string; h?: Handoff; c?: Cmt }
  const list = (comments.data ?? []) as Cmt[]
  const live = list.filter((c) => !c.deleted)
  // Удалённые тоже: ответ на удалённую реплику показывает «комментарий удалён».
  const byId = new Map(list.map((c) => [c.id, c]))
  // Поле — под лентой: подвести к нему и поставить курсор.
  const reply = (c: Cmt) => {
    setReplyTo(c)
    boxRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    boxRef.current?.querySelector<HTMLElement>('.ProseMirror')?.focus()
  }
  // Удалённый остаётся в ленте плашкой: на него могли отвечать, и разговор не рвётся.
  const evs: Ev[] = [...(handoffs.data ?? []).map((h) => ({ at: h.createdAt, h })), ...list.map((c) => ({ at: c.createdAt, c }))].sort((a, b) =>
    a.at.localeCompare(b.at),
  )
  const can = !empty && !send.isPending
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
              ) : e.c!.deleted ? (
                <div key={e.c!.id} id={`cmt-${e.c!.id}`} className="cmt gone">
                  {personAv(e.c!.author, 'av lg')}
                  <div className="b">
                    <div className="n">
                      <span className="bidi">{e.c!.author?.name ?? '—'}</span>
                      <time>{timeAgo(lng, e.at)}</time>
                    </div>
                    <div className="cmt-gone">{t('task.cmtGone')}</div>
                  </div>
                </div>
              ) : (
                <div key={e.c!.id} id={`cmt-${e.c!.id}`} className="cmt">
                  {personAv(e.c!.author, 'av lg')}
                  <div className="b">
                    <div className="n">
                      <span className="bidi">{e.c!.author?.name ?? '—'}</span>
                      <time>{timeAgo(lng, e.at)}</time>
                      <button className="cmt-act" onClick={() => reply(e.c!)}>
                        <I name="reply" sm />
                        {t('task.reply')}
                      </button>
                      {myId && e.c!.author?.id === myId && editing !== e.c!.id && (
                        <>
                          <button
                            className="cmt-act"
                            onClick={() => {
                              setEditing(e.c!.id)
                              setEditText(e.c!.body)
                            }}
                          >
                            {t('task.cmtEdit')}
                          </button>
                          <button className={'cmt-act' + (delAsk === e.c!.id ? ' danger' : '')} onClick={() => (delAsk === e.c!.id ? del.mutate(e.c!.id) : setDelAsk(e.c!.id))} onBlur={() => setDelAsk(null)}>
                            {delAsk === e.c!.id ? t('task.cmtDeleteSure') : t('task.cmtDelete')}
                          </button>
                        </>
                      )}
                    </div>
                    {e.c!.replyToId && <ReplyQuote parent={byId.get(e.c!.replyToId)} />}
                    {editing === e.c!.id ? (
                      <div className="cmt-edit">
                        <div className="cbox-ed">
                          <RichEditor value={editText} onChange={setEditText} onSubmit={() => edit.mutate(e.c!.id)} mentions={mentions} preset="minimal" />
                        </div>
                        <div className="co-foot" style={{ marginTop: 8 }}>
                          <button className={'btn-acc' + (edit.isPending ? ' dis' : '')} onClick={() => edit.mutate(e.c!.id)}>
                            {t('task.cmtSave')}
                          </button>
                          <button className="btn" onClick={() => setEditing(null)}>
                            {t('lt.cancel')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <CommentBody body={e.c!.body} />
                    )}
                    {(e.c!.files ?? []).filter((f) => !f.deleted).length > 0 && (
                      <div className="cmt-files">
                        {(e.c!.files ?? [])
                          .filter((f) => !f.deleted)
                          .map((f) => (
                            <button key={f.id} className="tchip" onClick={() => viewer.open(f.id)} title={f.name}>
                              <Icon name="attach" sm />
                              <span className="bidi">{f.name}</span>
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                </div>
              ),
            )}
          </div>
        )}
        <div className="composer" ref={boxRef}>
          {replyTo && (
            <div className="cmt-replying">
              <I name="reply" sm />
              <span className="bidi">{t('task.replyTo', { name: replyTo.author?.name ?? '—' })}</span>
              <button aria-label={t('task.cancelReply')} title={t('task.cancelReply')} onClick={() => setReplyTo(null)}>
                <Icon name="close" sm />
              </button>
            </div>
          )}
          <div className="cbox-ed" aria-label={t('task.commentAria')}>
            <RichEditor
              key={edKey}
              value={text}
              onChange={(html) => setText(html)}
              onSubmit={() => can && send.mutate()}
              placeholder={t('task.commentPh')}
              mentions={mentions}
              preset="minimal"
            />
          </div>
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
      {viewer.node}
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
    if ('assigneeId' in a) parts.push(a.assigneeId ? t('task.hist.assign', { to: people[String(a.assigneeId)] ?? '—' }) : t('task.hist.unassign'))
    if ('estimateMinutes' in a) parts.push(a.estimateMinutes ? t('task.hist.estimate', { to: fmtHm(Number(a.estimateMinutes)) }) : t('task.hist.estimateOff'))
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
