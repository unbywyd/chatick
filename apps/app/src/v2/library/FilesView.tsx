import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import '../i18n/list'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { api, ensureMediaToken, getMediaToken, inlineImageUrl } from '@/lib/api'
import { inProject, type CompanyProject } from '../data'
import { useUi } from '../ui'
import { Carousel } from '../tasks/TasksView'
import { ProjectLogo } from '../ProjectLogo'
import { Icon } from '../Icon'
import { ShareItem } from '../ShareTask'
import { firstName, shortProject } from '../util'
import { byDay, dayLabel, errText, fmtSize, Modal, ProjectCombo, uploadTo, useDebounced, useLibProjects, usePerProject } from './shared'
import { kindOf, srcOf, Viewer, type FileItem, type Kind, type Row, type Src } from './FileViewer'
import { isMac } from '../keys'

type Page = { items: FileItem[]; hasMore: boolean; storage?: { used: number; limit: number; custom?: boolean } }
const SRCS: ('all' | Src)[] = ['all', 'chat', 'task', 'up']
const KINDS: Kind[] = ['img', 'vid', 'doc', 'oth']

const extOf = (name: string) => (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toUpperCase()

/**
 * «Файлы» — всё, что приложено к задачам, прислано в чат или загружено руками.
 *
 * Сервер отдаёт файлы страницами по 24 на проект. На «Все проекты» — первая
 * страница каждого, склеенная по дате; в одном проекте можно листать дальше.
 * Поиск по имени идёт на сервере, чтобы находились и старые файлы.
 */
export function FilesView() {
  const { t, i18n } = useTranslation('v2')
  const { companyId, base, project, setProject, flash } = useUi()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { search } = useLocation()
  // Адрес файла: /files/f/<проект>/<id> — им делятся, и открываться он должен
  // сразу файлом, а не списком, где его ещё искать.
  const deep = /^f\/([^/]+)\/([^/]+)/.exec(useParams()['*'] ?? '')
  const { list: projects } = useLibProjects(companyId)
  const [q, setQ] = useState('')
  const dq = useDebounced(q.trim())
  const [src, setSrc] = useState<'all' | Src>('all')
  const [kind, setKind] = useState<Kind | null>(null)
  const [pages, setPages] = useState(1)
  const [open, setOpen] = useState<Row | null>(null)
  const [ask, setAsk] = useState<File[] | 'pick' | null>(null)
  const [busy, setBusy] = useState(0)
  const [, setMediaReady] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const target = useRef<string | null>(null)

  // Картинки-миниатюры идут по медиа-токену: <img> не умеет слать заголовок.
  useEffect(() => {
    void ensureMediaToken().then(() => setMediaReady((n) => n + 1))
  }, [])
  useEffect(() => setPages(1), [project, dq])

  const qs = `/api/v1/files?withTaskFiles=1${dq ? `&q=${encodeURIComponent(dq)}` : ''}`
  const per = usePerProject<Page>('files', projects, qs)
  const selected = projects.find((p) => p.id === project) ?? null
  // Следующие страницы — в выбранном проекте, а на «Все проекты» — в каждом,
  // где они есть: раньше «ещё» было только внутри одного проекта, и дальше
  // 24 свежих файлов с проекта на общем экране не заглянуть.
  const targets = selected ? [selected] : projects
  const firstOf = (pid: string): Page | undefined => per.parts.find((x) => x.project.id === pid)?.data ?? undefined
  const moreSpecs = targets.flatMap((p) => Array.from({ length: pages - 1 }, (_, i) => ({ p, page: i + 2 })))
  const more = useQueries({
    queries: moreSpecs.map(({ p, page }) => ({
      queryKey: ['v2', 'lib', 'files', p.id, qs, 'page', page],
      queryFn: () => api<Page>(`${qs}&page=${page}`, inProject(p.id)),
      staleTime: 30_000,
      // Страницу просим, только если на предыдущей сервер сказал «есть ещё».
      enabled: page === 2 ? Boolean(firstOf(p.id)?.hasMore) : Boolean(qc.getQueryData<Page>(['v2', 'lib', 'files', p.id, qs, 'page', page - 1])?.hasMore),
    })),
  })
  const pageOf = (pid: string, page: number): Page | undefined =>
    page === 1 ? firstOf(pid) : more[moreSpecs.findIndex((x) => x.p.id === pid && x.page === page)]?.data

  const all: Row[] = useMemo(() => {
    const mk = (p: CompanyProject, items: FileItem[]) => items.map((f) => ({ ...f, project: p, kind: kindOf(f), src: srcOf(f) }))
    const base = per.parts.flatMap(({ project: p, data }) => mk(p, data?.items ?? []))
    const extra = moreSpecs.flatMap((x, i) => mk(x.p, more[i]?.data?.items ?? []))
    return [...base, ...extra].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [per.parts, more, selected, pages])
  // Открыт по адресу: берём из списка, а если файла нет в первой порции —
  // спрашиваем сервер о нём одном.
  const deepId = deep?.[2] ?? null
  const deepProject = deep?.[1] ?? null
  const single = useQuery({
    queryKey: ['v2', 'lib', 'file', deepId],
    queryFn: () => api<FileItem & { deleted?: boolean }>(`/api/v1/files/${deepId}`, inProject(deepProject!)),
    enabled: Boolean(deepId && deepProject && !all.some((f) => f.id === deepId)),
    retry: false,
  })
  useEffect(() => {
    if (!deepId) return setOpen(null)
    const inList = all.find((f) => f.id === deepId)
    const p = projects.find((x) => x.id === deepProject)
    if (inList) setOpen(inList)
    else if (single.data && p) setOpen({ ...single.data, taskNumber: single.data.taskNumber ?? null, project: p, kind: kindOf(single.data), src: srcOf(single.data) })
    // all меняется при каждой подгрузке — открытый файл от этого не меняется
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepId, deepProject, single.data, projects.length, all.length])
  const openFile = (f: Row) => {
    setOpen(f)
    navigate(`${base}/files/f/${f.project.id}/${f.id}${search}`)
  }
  const closeFile = () => {
    setOpen(null)
    if (deepId) navigate(`${base}/files${search}`)
  }
  // «Ещё» есть, если хоть у одного проекта последняя загруженная страница не последняя.
  const hasMore = targets.some((p) => Boolean(pageOf(p.id, pages)?.hasMore))
  // Место: у выбранного проекта сервер отдаёт занятое и лимит с первой страницей.
  const storage = selected ? firstOf(selected.id)?.storage : undefined
  // Выбор нескольких файлов — удалить разом.
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const togglePick = (id: string) =>
    setPicked((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const [delAsk, setDelAsk] = useState(false)
  const bulkDelete = useMutation({
    mutationFn: async () => {
      const byProject = new Map<string, string[]>()
      for (const f of all) if (picked.has(f.id)) byProject.set(f.project.id, [...(byProject.get(f.project.id) ?? []), f.id])
      let deleted = 0
      let skipped = 0
      for (const [pid, ids] of byProject) {
        const r = await api<{ deleted: number; skipped: number }>('/api/v1/files/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }), ...inProject(pid) })
        deleted += r.deleted
        skipped += r.skipped
        void qc.invalidateQueries({ queryKey: ['v2', 'lib', 'files', pid] })
      }
      return { deleted, skipped }
    },
    onSuccess: (r) => {
      setPicked(new Set())
      setDelAsk(false)
      flash(r.skipped ? `${t('library.files.bulkDeleted', { count: r.deleted })} ${t('library.files.bulkSkipped', { count: r.skipped })}` : t('library.files.bulkDeleted', { count: r.deleted }))
    },
    onError: (e) => flash(errText(t, e)),
  })
  // «Без сжатия»: картинки загрузятся как есть — для макетов и скриншотов.
  const [keepOrig, setKeepOrig] = useState(false)

  const inProj = all.filter((f) => !project || f.project.id === project)
  const bySrc = inProj.filter((f) => src === 'all' || f.src === src)
  const list = bySrc.filter((f) => !kind || f.kind === kind)
  const days = byDay(list, (f) => f.createdAt)

  const upload = async (files: File[], projectId: string) => {
    if (!files.length) return
    setBusy((n) => n + files.length)
    let ok = 0
    let fail: string | null = null
    for (const f of files) {
      const form = new FormData()
      form.set('file', f)
      form.set('manager', '1') // прямая загрузка — файл постоянный, не черновик вложения
      if (keepOrig) form.set('keepOriginal', '1')
      try {
        const res = await uploadTo(projectId, '/api/v1/files', form)
        if (res.ok) ok++
        else fail = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status)
      } catch {
        fail = t('err.generic')
      }
      setBusy((n) => n - 1)
    }
    void qc.invalidateQueries({ queryKey: ['v2', 'lib', 'files', projectId] })
    const pname = shortProject(projects.find((p) => p.id === projectId)?.name ?? '')
    flash(fail ? t('library.files.upFailed', { error: fail }) : t('library.files.uploaded', { count: ok, project: pname }))
  }
  // Проект выбран — грузим в него сразу; на «Все проекты» сначала спросим куда.
  const start = (files: File[] | null) => {
    if (project) {
      if (files) void upload(files, project)
      else {
        target.current = project
        input.current?.click()
      }
    } else setAsk(files ?? 'pick')
  }

  // Вставка из буфера (Ctrl+V) — скриншот прямо в файлы.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el?.closest('input, textarea, [contenteditable="true"]') || document.querySelector('.lib-modal, .lib-view')) return
      const files = Array.from(e.clipboardData?.files ?? [])
      if (!files.length) return
      e.preventDefault()
      start(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  })

  const paste = async () => {
    try {
      const items = await navigator.clipboard.read()
      const files: File[] = []
      for (const it of items) {
        const type = it.types.find((x) => x.startsWith('image/'))
        if (type) files.push(new File([await it.getType(type)], `paste-${Date.now()}.${type.split('/')[1]}`, { type }))
      }
      if (files.length) start(files)
      else flash(t('library.files.pasteEmpty'))
    } catch {
      flash(t('library.files.pasteHint', { key: isMac ? '⌘V' : 'Ctrl+V' }))
    }
  }

  const [drag, setDrag] = useState(false)
  return (
    <div className="wrap">
      <div className="rh">
        <div>
          <h1 className="head">{t('library.files.title')}</h1>
          <p className="sub">{t('library.files.sub')}</p>
        </div>
        <div className="rh-a">
          <label className="keep-orig" title={t('task.keepOrigHint')}>
            <input type="checkbox" checked={keepOrig} onChange={(e) => setKeepOrig(e.target.checked)} />
            {t('task.keepOrig')}
          </label>
          <button className="btn-acc" onClick={() => start(null)}>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 15V4M7.5 8.5L12 4l4.5 4.5" />
              <path d="M5 15v3a2 2 0 002 2h10a2 2 0 002-2v-3" />
            </svg>
            {busy ? t('library.files.uploading', { count: busy }) : t('library.files.upload')}
          </button>
        </div>
      </div>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (target.current) void upload(files, target.current)
        }}
      />

      <Carousel projects={projects} counts={all} selected={project} onPick={setProject} />

      <div className="rbar">
        <div className="seg" role="tablist">
          {SRCS.map((k) => (
            <button key={k} className={src === k ? 'on' : ''} role="tab" aria-selected={src === k} onClick={() => setSrc(k)}>
              {t(`library.files.src.${k}`)}
              <span className="n">{inProj.filter((f) => k === 'all' || f.src === k).length}</span>
            </button>
          ))}
        </div>
        <label className="rsearch" style={{ maxWidth: 300 }}>
          <Icon name="search" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('library.files.search')} aria-label={t('library.files.searchAria')} />
        </label>
        <span className="flab">{t('library.files.type')}</span>
        {KINDS.map((k) => {
          const c = bySrc.filter((f) => f.kind === k).length
          const on = kind === k
          return (
            <button key={k} className={'fx' + (on ? ' on' : '') + (!c && !on ? ' dim' : '')} aria-pressed={on} onClick={() => setKind(on ? null : k)}>
              {t(`library.files.k.${k}`)}
              <span className="n">{c}</span>
            </button>
          )
        })}
      </div>

      {storage && !storage.custom && storage.limit > 0 && (
        <div className="lib-store" title={t('library.files.storageTitle')}>
          <span>{t('library.files.storage', { used: fmtSize(storage.used, t), limit: fmtSize(storage.limit, t) })}</span>
          <span className="lib-store-bar">
            <i className={storage.used / storage.limit > 0.9 ? 'hot' : ''} style={{ width: `${Math.min(100, Math.round((storage.used / storage.limit) * 100))}%` }} />
          </span>
        </div>
      )}

      <div className="sheet" style={{ padding: '12px 8px 14px' }}>
        <div
          className={'dz' + (drag ? ' lib-drag' : '')}
          onDragOver={(e) => {
            e.preventDefault()
            setDrag(true)
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDrag(false)
            const files = Array.from(e.dataTransfer.files)
            if (files.length) start(files)
          }}
        >
          {t('library.files.drop')}
          <button className="mini" onClick={() => void paste()}>
            <Icon name="attach" sm />
            {t('library.files.paste')}
          </button>
        </div>
        {days.map((d) => (
          <div key={d.key}>
            <div className="fday">
              {dayLabel(t, i18n.language, d.first)}
              <span className="n">{d.items.length}</span>
            </div>
            <div className="fgrid">
              {d.items.map((f) => (
                <Tile key={f.id} f={f} onOpen={() => openFile(f)} picked={picked.has(f.id)} picking={picked.size > 0} onPick={() => togglePick(f.id)} />
              ))}
            </div>
          </div>
        ))}
        {!per.loading && !days.length && <div className="none">{all.length ? t('library.files.noneFilter') : t('library.files.none')}</div>}
        {per.loading && !days.length && <div className="none">{t('common.loading')}</div>}
        {hasMore && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 4px' }}>
            <button className="btn" onClick={() => setPages(pages + 1)}>
              {t('library.files.more')}
            </button>
          </div>
        )}
        {!selected && all.length > 0 && <div className="note-s" style={{ justifyContent: 'center', paddingTop: 8 }}>{t('library.files.recentNote')}</div>}
      </div>

      {ask && (
        <UploadModal
          projects={projects}
          files={ask === 'pick' ? null : ask}
          onClose={() => setAsk(null)}
          onGo={(pid) => {
            if (ask === 'pick') {
              target.current = pid
              input.current?.click()
            } else void upload(ask, pid)
            setAsk(null)
          }}
        />
      )}
      {open && <Viewer f={open} onClose={closeFile} />}
      {picked.size > 0 && (
        <div className="lt-bulk" role="toolbar">
          <b>{t('library.files.picked', { count: picked.size })}</b>
          {!delAsk ? (
            <button className="mini" onClick={() => setDelAsk(true)}>
              {t('library.files.delete')}
            </button>
          ) : (
            <button className="mini danger on" disabled={bulkDelete.isPending} onClick={() => bulkDelete.mutate()}>
              {t('library.files.deleteN', { count: picked.size })}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="ib" aria-label={t('lt.clear')} title={t('lt.clear')} onClick={() => (setPicked(new Set()), setDelAsk(false))}>
            <Icon name="close" />
          </button>
        </div>
      )}
    </div>
  )
}

function Tile({ f, onOpen, picked, picking, onPick }: { f: Row; onOpen: () => void; picked: boolean; picking: boolean; onPick: () => void }) {
  const { t } = useTranslation('v2')
  const token = getMediaToken()
  const [broken, setBroken] = useState(false)
  const img = f.kind === 'img' && token && !broken
  return (
    <div className={'ftile' + (picked ? ' picked' : '') + (picking ? ' picking' : '')}>
      <button className={'fsel' + (picked ? ' on' : '')} role="checkbox" aria-checked={picked} aria-label={t('library.files.pick', { name: f.name })} onClick={onPick}>
        {picked && <Icon name="check" sm />}
      </button>
      <button className={`fthumb th-${f.kind}`} aria-label={t('library.files.openAria', { name: f.name })} onClick={onOpen}>
        {img && <img className="lib-thumb" src={`${inlineImageUrl(f.id)}?t=${encodeURIComponent(token)}`} alt="" loading="lazy" onError={() => setBroken(true)} />}
        {f.kind === 'img' && !img && (
          <span className="scr">
            <b />
            <i />
            <i className="s" />
            <i />
            <i className="acc" />
          </span>
        )}
        {f.kind === 'vid' && (
          <span className="pl">
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" />
            </svg>
          </span>
        )}
        {f.kind === 'doc' && (
          <span className="paper">
            <i />
            <i />
            <i className="s" />
            <i />
            <i className="s" />
          </span>
        )}
        {f.kind === 'oth' && (
          <span style={{ color: 'var(--ink3)' }}>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z" />
              <path d="M3.5 7.5L12 12l8.5-4.5M12 12v9" />
            </svg>
          </span>
        )}
        {extOf(f.name) && <span className="fext">{extOf(f.name)}</span>}
        {f.taskNumber && <span className="ftask">{f.taskNumber}</span>}
      </button>
      <div className="fname bidi" title={f.name}>
        {f.name}
      </div>
      <div className="fmeta">
        <ProjectLogo project={f.project} size="xs" title={f.project.name} />
        <span>{fmtSize(f.size, t)}</span>
        {f.uploader && <span className="bidi">{firstName(f.uploader.name)}</span>}
      </div>
    </div>
  )
}

/** Куда грузить, когда в карусели «Все проекты». */
function UploadModal({ projects, files, onClose, onGo }: { projects: CompanyProject[]; files: File[] | null; onClose: () => void; onGo: (pid: string) => void }) {
  const { t } = useTranslation('v2')
  const [pid, setPid] = useState<string | null>(null)
  return (
    <Modal label={t('library.files.whereTitle')} onClose={onClose}>
      <div className="mh">
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3>{t('library.files.whereTitle')}</h3>
          <div className="s">{files ? t('library.files.whereFiles', { count: files.length }) : t('library.files.whereSub')}</div>
        </div>
        <button className="ib" aria-label={t('library.close')} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <ProjectCombo projects={projects} value={pid} onChange={setPid} />
      <div className="mf">
        <div className="res" />
        <button className="btn" onClick={onClose}>
          {t('library.cancel')}
        </button>
        <button className={'btn-acc' + (pid ? '' : ' dis')} onClick={() => pid && onGo(pid)}>
          {files ? t('library.files.upload') : t('library.files.choose')}
        </button>
      </div>
    </Modal>
  )
}

