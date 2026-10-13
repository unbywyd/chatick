import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, API_URL, ApiError, getSessionToken } from '@/lib/api'
import { inProject, type CompanyProject } from '../data'
import { useUi } from '../ui'
import { Carousel } from '../tasks/TasksView'
import { ProjectLogo } from '../ProjectLogo'
import { Icon } from '../Icon'
import { ShareItem } from '../ShareTask'
import { shortProject } from '../util'
import { errText, Modal, ProjectCombo, uploadTo, useCopy, useLibProjects, usePerProject } from './shared'

type Res = {
  id: string
  name: string
  url: string | null
  icon: string | null
  description: string
  source: 'manual' | 'chat'
  secretCount: number
  canSeeSecrets: boolean
  createdAt: string
  creator: { id: string; name: string } | null
}
type Row = Res & { project: CompanyProject; kind: Kind; text: string }
type Detail = { id: string; canSeeSecrets: boolean; secretCount: number; secrets: { id: string; label: string }[]; authorId: string | null }
type LockedFile = { id: string; name: string; mime: string; size: number }

type Kind = 'code' | 'design' | 'server' | 'admin' | 'db' | 'link'
type Filter = 'all' | Exclude<Kind, 'link'> | 'sec' | 'chat'
const FILTERS: Filter[] = ['all', 'code', 'design', 'server', 'admin', 'db', 'sec', 'chat']

/**
 * Вид ресурса по ссылке. Сервер вида не хранит — а для фильтра и значка
 * адреса хватает: github — код, figma — дизайн, и так далее.
 */
function kindOf(url: string | null, name: string): Kind {
  const s = `${url ?? ''} ${name}`.toLowerCase()
  if (/github|gitlab|bitbucket/.test(s)) return 'code'
  if (/figma|sketch|zeplin|miro/.test(s)) return 'design'
  if (/postgres|mysql|mongo|supabase|neon\.tech|redis|database|phpmyadmin|pgadmin/.test(s)) return 'db'
  if (/\/admin|wp-admin|dashboard|panel|console\.|cms|backoffice|אדמין/.test(s)) return 'admin'
  if (/heroku|vercel|netlify|firebase|aws|render\.com|railway|digitalocean|cloudflare|ssh:|sftp:|hetzner|server|שרת/.test(s)) return 'server'
  return 'link'
}

const KIND_ICON: Record<Kind, React.ReactNode> = {
  code: <path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" />,
  design: (
    <>
      <path d="M12 20l7-7 2.5 2.5-7 7z" />
      <path d="M18 13l-1.5-7.5L3 2l3.5 13.5L14 17z" />
      <path d="M3 2l7.6 7.6" />
      <circle cx="11.5" cy="11" r="1.8" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  admin: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 9v11" />
    </>
  ),
  db: (
    <>
      <ellipse cx="12" cy="5.5" rx="7.5" ry="2.5" />
      <path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5" />
    </>
  ),
  link: <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />,
}
const Svg = ({ children, sm }: { children: React.ReactNode; sm?: boolean }) => (
  <svg className={'ic' + (sm ? ' sm' : '')} viewBox="0 0 24 24" aria-hidden="true">
    {children}
  </svg>
)
const LOCK = (
  <>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 018 0v3" />
  </>
)
const COPY = (
  <>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" />
  </>
)
const EDIT = <path d="M4 20h4l10.5-10.5a2.8 2.8 0 00-4-4L4 16z" />
const LOG = <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
const EYE = (
  <>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </>
)
const TRASH = <path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13" />
const DOWN = <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14" />

/** Описание приходит HTML-ем (редактор) или текстом — в строке нужен текст. */
function plain(html: string): string {
  let s = html
  if (/[<&]/.test(s)) s = new DOMParser().parseFromString(s, 'text/html').body.textContent ?? ''
  // Мост и ассистент пишут markdown — в двух строках превью звёздочки и `код` только мешают.
  return s
    .replace(/\*\*|__|`/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+\n/g, '\n')
    .trim()
}
const withScheme = (u: string) => (/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`)

/**
 * «Ресурсы» — ссылки, доступы и секреты всех проектов одним списком.
 *
 * Секреты в списке не раскрываются никогда: замок показывает только число.
 * Значение — отдельным нажатием в окне ресурса, и каждое раскрытие сервер
 * пишет в журнал доступа.
 */
export function ResourcesView() {
  const { t } = useTranslation('v2')
  const { companyId, project, setProject } = useUi()
  const copy = useCopy()
  const { list: projects } = useLibProjects(companyId)
  const per = usePerProject<Res[]>('res', projects, '/api/v1/resources')
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<Filter>('all')
  const [modal, setModal] = useState<{ mode: 'new' } | { mode: 'edit'; row: Row } | null>(null)
  const [share, setShare] = useState<Row | null>(null)
  const [log, setLog] = useState(false)

  const all: Row[] = useMemo(
    () =>
      per.parts.flatMap(({ project: p, data }) =>
        (data ?? []).map((r) => {
          const desc = plain(r.description ?? '')
          return { ...r, description: desc, project: p, kind: kindOf(r.url, r.name), text: `${r.name} ${r.url ?? ''} ${desc}`.toLowerCase() }
        }),
      ),
    [per.parts],
  )
  const s = q.trim().toLowerCase()
  const inView = all.filter((r) => (!project || r.project.id === project) && (!s || r.text.includes(s)))
  const F: Record<Filter, (r: Row) => boolean> = {
    all: () => true,
    code: (r) => r.kind === 'code',
    design: (r) => r.kind === 'design',
    server: (r) => r.kind === 'server',
    admin: (r) => r.kind === 'admin',
    db: (r) => r.kind === 'db',
    sec: (r) => r.secretCount > 0,
    chat: (r) => r.source === 'chat',
  }
  const shown = inView.filter(F[kind])
  // Группы — по проектам, крупные сверху: как и карусель над ними.
  const groups = [...new Set(shown.map((r) => r.project.id))]
    .map((id) => ({ p: shown.find((r) => r.project.id === id)!.project, rows: shown.filter((r) => r.project.id === id) }))
    .sort((a, b) => b.rows.length - a.rows.length)

  return (
    <div className="wrap">
      <div className="rh">
        <div>
          <h1 className="head">{t('library.res.title')}</h1>
          <p className="sub">{t('library.res.sub')}</p>
        </div>
        <div className="rh-a">
          <button className="btn" onClick={() => setLog(true)}>
            <Svg>{LOG}</Svg>
            {t('library.res.log')}
          </button>
          <button className="btn-acc" onClick={() => setModal({ mode: 'new' })}>
            <Icon name="plus" />
            {t('library.res.add')}
          </button>
        </div>
      </div>

      <Carousel projects={projects} counts={all} selected={project} onPick={setProject} />

      <div className="rbar">
        <label className="rsearch">
          <Icon name="search" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('library.res.search')} aria-label={t('library.res.searchAria')} />
        </label>
        {FILTERS.map((k) => {
          const c = inView.filter(F[k]).length
          const on = kind === k
          return (
            <button key={k} className={'fx' + (on ? ' on' : '') + (!c && !on ? ' dim' : '')} aria-pressed={on} onClick={() => setKind(k)}>
              {t(`library.res.k.${k}`)}
              <span className="n">{c}</span>
            </button>
          )
        })}
      </div>

      <div className="sheet">
        {groups.map((g) => (
          <div key={g.p.id}>
            <div className="rgh">
              <ProjectLogo project={g.p} />
              <span className="pn">{g.p.name}</span>
              <span className="n">{g.rows.length}</span>
            </div>
            {g.rows.map((r, i) => (
              <div key={r.id} className={'res-row' + (i === 0 ? ' first' : '')}>
                <span className="rk">
                  <Svg>{KIND_ICON[r.kind]}</Svg>
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="rt">
                    <b>{r.name || r.url}</b>
                    {r.source === 'chat' && <span className="tg">{t('library.res.fromChat')}</span>}
                    {r.secretCount > 0 && (
                      <button
                        className="lk"
                        title={r.canSeeSecrets ? t('library.res.secretsOpen') : t('library.res.secretsClosed')}
                        onClick={() => setModal({ mode: 'edit', row: r })}
                      >
                        <Svg sm>{LOCK}</Svg>
                        {r.secretCount}
                      </button>
                    )}
                  </div>
                  {r.url && (
                    <a className="ru" href={withScheme(r.url)} target="_blank" rel="noopener noreferrer">
                      {r.url}
                    </a>
                  )}
                  {r.description && <p className="rd bidi">{r.description}</p>}
                </div>
                <div className="ra">
                  {r.url && (
                    <button className="ib" aria-label={t('library.res.copyLink')} title={t('library.res.copyLink')} onClick={() => copy(withScheme(r.url!), t('library.res.linkCopied'))}>
                      <Svg>{COPY}</Svg>
                    </button>
                  )}
                  {r.url && (
                    <button className="ib" aria-label={t('library.res.share')} title={t('library.res.share')} onClick={() => setShare(r)}>
                      <Icon name="share" />
                    </button>
                  )}
                  <button className="ib" aria-label={t('library.res.edit')} title={t('library.res.edit')} onClick={() => setModal({ mode: 'edit', row: r })}>
                    <Svg>{EDIT}</Svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
        {!per.loading && !groups.length && <div className="none">{all.length ? t('library.res.noneFilter') : t('library.res.none')}</div>}
        {per.loading && !groups.length && <div className="none">{t('common.loading')}</div>}
      </div>

      {modal && (
        <ResourceModal
          key={modal.mode === 'edit' ? modal.row.id : 'new'}
          projects={projects}
          row={modal.mode === 'edit' ? modal.row : null}
          defaultProject={project}
          onClose={() => setModal(null)}
          onSaved={(pid) => {
            setKind('all')
            if (project && project !== pid) setProject(pid)
          }}
        />
      )}
      {share && <ShareModal row={share} onClose={() => setShare(null)} />}
      {log && <LogModal projects={projects} defaultProject={project} onClose={() => setLog(false)} />}
    </div>
  )
}

type NewSecret = { label: string; value: string }

/** Новый ресурс и правка — одно окно: ссылка, имя, описание, секреты, закрытые файлы. */
function ResourceModal({
  projects,
  row,
  defaultProject,
  onClose,
  onSaved,
}: {
  projects: CompanyProject[]
  row: Row | null
  defaultProject: string | null
  onClose: () => void
  onSaved: (projectId: string) => void
}) {
  const { t } = useTranslation('v2')
  const { flash } = useUi()
  const qc = useQueryClient()
  const copy = useCopy()
  const [picked, setPid] = useState<string | null>(row?.project.id ?? null)
  // Пока список проектов не пришёл, выбора ещё нет — подставляем, как только придёт.
  const pid = picked ?? defaultProject ?? projects[0]?.id ?? null
  const [url, setUrl] = useState(row?.url ?? '')
  const [title, setTitle] = useState(row?.name ?? '')
  const [desc, setDesc] = useState(row?.description ?? '')
  const [descTouched, setDescTouched] = useState(false)
  const [secrets, setSecrets] = useState<NewSecret[]>(row ? [] : [{ label: '', value: '' }])
  const [files, setFiles] = useState<File[]>([])
  const [shown, setShown] = useState<Record<string, string>>({})
  const [confirmDel, setConfirmDel] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const perm = useQuery({
    queryKey: ['v2', 'lib', 'res-perm', pid],
    queryFn: () => api<{ canManage: boolean }>('/api/v1/resources/permissions', inProject(pid!)).catch(() => ({ canManage: false })),
    enabled: Boolean(pid),
    staleTime: 60_000,
  })
  const detail = useQuery({
    queryKey: ['v2', 'lib', 'res-detail', row?.id],
    queryFn: () => api<Detail>(`/api/v1/resources/${row!.id}`, inProject(row!.project.id)),
    enabled: Boolean(row),
  })
  const canSee = Boolean(row && detail.data?.canSeeSecrets)
  const locked = useQuery({
    queryKey: ['v2', 'lib', 'res-files', row?.id],
    queryFn: () => api<{ items: LockedFile[] }>(`/api/v1/resources/${row!.id}/files`, inProject(row!.project.id)).then((r) => r.items),
    enabled: canSee,
  })

  const canManage = perm.data?.canManage ?? true
  const filled = secrets.filter((x) => x.value.trim())
  const ready = Boolean(pid) && canManage && Boolean(url.trim() || title.trim() || filled.length || (row && (files.length || descTouched)))

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['v2', 'lib', 'res', pid] })
    void qc.invalidateQueries({ queryKey: ['v2', 'lib', 'trash', pid] })
    if (row) {
      void qc.invalidateQueries({ queryKey: ['v2', 'lib', 'res-detail', row.id] })
      void qc.invalidateQueries({ queryKey: ['v2', 'lib', 'res-files', row.id] })
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      const link = url.trim() || null
      let id = row?.id
      if (row) {
        await api(`/api/v1/resources/${row.id}`, {
          method: 'PATCH',
          // Описание — только если его правили: в базе оно бывает HTML-ем из
          // старого редактора, и сохранять его текстом без нужды — терять разметку.
          body: JSON.stringify({ name: title.trim(), url: link, ...(descTouched ? { description: desc } : {}) }),
          ...inProject(pid!),
        })
        for (const s of filled) await api(`/api/v1/resources/${row.id}/secrets`, { method: 'POST', body: JSON.stringify(s), ...inProject(pid!) })
      } else {
        // Кто видит секреты — решает сервер: по умолчанию вся команда проекта.
        const made = await api<{ id: string }>('/api/v1/resources', {
          method: 'POST',
          body: JSON.stringify({ name: title.trim(), url: link, description: desc, secrets: filled }),
          ...inProject(pid!),
        })
        id = made.id
      }
      for (const f of files) {
        const form = new FormData()
        form.set('file', f)
        const res = await uploadTo(pid!, `/api/v1/resources/${id}/files`, form)
        if (!res.ok) throw new Error(`${f.name}: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status}`)
      }
    },
    onSuccess: () => {
      refresh()
      flash(row ? t('library.res.saved') : t('library.res.created', { project: shortProject(projects.find((p) => p.id === pid)?.name ?? '') }))
      onSaved(pid!)
      onClose()
    },
    onError: (e) => setError(errText(t, e)),
  })

  const remove = useMutation({
    mutationFn: () => api(`/api/v1/resources/${row!.id}`, { method: 'DELETE', ...inProject(row!.project.id) }),
    onSuccess: () => {
      refresh()
      flash(t('library.res.deleted'))
      onClose()
    },
    onError: (e) => setError(errText(t, e)),
  })

  // Значение секрета — только по нажатию: каждое раскрытие в журнале доступа.
  const reveal = async (secretId: string) => {
    const r = await api<{ value: string }>(`/api/v1/resources/${row!.id}/secrets/${secretId}/reveal`, { method: 'POST', ...inProject(row!.project.id) })
    return r.value
  }
  const toggle = async (secretId: string) => {
    if (shown[secretId] !== undefined) {
      const next = { ...shown }
      delete next[secretId]
      setShown(next)
      return
    }
    try {
      const v = await reveal(secretId)
      setShown((m) => ({ ...m, [secretId]: v }))
    } catch (e) {
      setError(errText(t, e))
    }
  }
  const delSecret = useMutation({
    mutationFn: (secretId: string) => api(`/api/v1/resources/${row!.id}/secrets/${secretId}`, { method: 'DELETE', ...inProject(row!.project.id) }),
    onSuccess: refresh,
  })
  const delFile = useMutation({
    mutationFn: (fileId: string) => api(`/api/v1/resources/${row!.id}/files/${fileId}`, { method: 'DELETE', ...inProject(row!.project.id) }),
    onSuccess: refresh,
  })
  // Закрытый файл отдаётся только с заголовками — через fetch, не ссылкой.
  const download = async (f: LockedFile) => {
    const token = getSessionToken()
    const res = await fetch(`${API_URL}/api/v1/resources/${row!.id}/files/${f.id}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'X-Project': row!.project.id },
    })
    if (!res.ok) return setError(t('err.generic'))
    const href = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = href
    a.download = f.name
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(href), 1000)
  }

  const heading = row ? t('library.res.editTitle') : t('library.res.newTitle')
  const hidden = row && !canSee && (row.secretCount ?? 0) > 0
  return (
    <Modal label={heading} onClose={onClose} wide top>
      <div className="mh">
        <span className="rk" style={{ background: 'var(--soft)' }}>
          <Svg>{KIND_ICON[row?.kind ?? 'link']}</Svg>
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 style={{ marginTop: 8 }}>{heading}</h3>
        </div>
        <button className="ib" aria-label={t('library.close')} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div>
        <div className="lbl">{t('library.project')}</div>
        <ProjectCombo projects={projects} value={pid} onChange={setPid} disabled={Boolean(row)} />
      </div>
      <input className="nin big" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('library.res.urlPh')} aria-label={t('library.res.urlAria')} inputMode="url" spellCheck={false} autoFocus={!row} />
      <input className="nin bidi" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('library.res.titlePh')} aria-label={t('library.res.titleAria')} />
      <textarea
        className="ta bidi"
        value={desc}
        onChange={(e) => {
          setDesc(e.target.value)
          setDescTouched(true)
        }}
        placeholder={t('library.res.descPh')}
        aria-label={t('library.res.descAria')}
      />
      <div className="secbox">
        <h4>
          <Svg sm>{LOCK}</Svg>
          {t('library.res.secrets')}
        </h4>
        {hidden && <div className="note-s">{t('library.res.notShared', { count: row!.secretCount })}</div>}
        {canSee &&
          detail.data!.secrets.map((x) => (
            <div key={x.id} className="lib-sec">
              <span className="lib-sec-l bidi">{x.label || t('library.res.secretNoName')}</span>
              <span className={'lib-sec-v' + (shown[x.id] !== undefined ? ' open' : '')}>{shown[x.id] ?? '••••••••'}</span>
              <button className="ib" aria-label={shown[x.id] !== undefined ? t('library.res.hide') : t('library.res.reveal')} title={shown[x.id] !== undefined ? t('library.res.hide') : t('library.res.reveal')} onClick={() => void toggle(x.id)}>
                <Svg sm>{EYE}</Svg>
              </button>
              <button
                className="ib"
                aria-label={t('library.res.copySecret')}
                title={t('library.res.copySecret')}
                onClick={() => void (shown[x.id] !== undefined ? Promise.resolve(shown[x.id]!) : reveal(x.id)).then((v) => copy(v, t('library.res.secretCopied')))}
              >
                <Svg sm>{COPY}</Svg>
              </button>
              {canManage && (
                <button className="ib" aria-label={t('library.res.delSecret')} title={t('library.res.delSecret')} onClick={() => delSecret.mutate(x.id)}>
                  <Svg sm>{TRASH}</Svg>
                </button>
              )}
            </div>
          ))}
        {secrets.map((x, i) => (
          <div key={i} className="secrow">
            <input
              className="bidi"
              value={x.label}
              onChange={(e) => setSecrets(secrets.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))}
              placeholder={t('library.res.secretName')}
              aria-label={t('library.res.secretName')}
            />
            <input
              type="password"
              value={x.value}
              autoComplete="new-password"
              onChange={(e) => setSecrets(secrets.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)))}
              placeholder={t('library.res.secretValue')}
              aria-label={t('library.res.secretValue')}
            />
          </div>
        ))}
        {(!row || canSee || !hidden) && (
          <button className="addl" onClick={() => setSecrets([...secrets, { label: '', value: '' }])}>
            <Icon name="plus" sm />
            {t('library.res.addSecret')}
          </button>
        )}
        <div style={{ height: 1, background: 'var(--line)' }} />
        <h4>
          <Icon name="attach" sm />
          {t('library.res.lockedFiles')}
        </h4>
        {(locked.data ?? []).map((f) => (
          <div key={f.id} className="lib-sec">
            <span className="lib-sec-l bidi">{f.name}</span>
            <span />
            <button className="ib" aria-label={t('library.res.download')} title={t('library.res.download')} onClick={() => void download(f)}>
              <Svg sm>{DOWN}</Svg>
            </button>
            <span />
            <button className="ib" aria-label={t('library.res.delFile')} title={t('library.res.delFile')} onClick={() => delFile.mutate(f.id)}>
              <Svg sm>{TRASH}</Svg>
            </button>
          </div>
        ))}
        {files.map((f, i) => (
          <div key={i} className="lib-sec">
            <span className="lib-sec-l bidi">{f.name}</span>
            <span className="lib-sec-v">{t('library.res.willUpload')}</span>
            <span />
            <span />
            <button className="ib" aria-label={t('library.res.delFile')} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
              <Icon name="close" sm />
            </button>
          </div>
        ))}
        {(!row || canSee) && (
          <button className="addl" style={{ marginTop: -4 }} onClick={() => fileInput.current?.click()}>
            <Icon name="plus" sm />
            {t('library.res.attach')}
          </button>
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            setFiles([...files, ...Array.from(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
        <div className="note-s">{t('library.res.lockedNote')}</div>
      </div>
      <div className="mf">
        <div className="res" role={error ? 'alert' : undefined} style={error ? { color: 'var(--signal)' } : undefined}>
          {error ?? (!canManage ? t('library.res.noManage') : '')}
        </div>
        {row && canManage && (
          <button
            className={'btn' + (confirmDel ? ' lib-danger' : '')}
            onClick={() => (confirmDel ? remove.mutate() : setConfirmDel(true))}
            onBlur={() => setConfirmDel(false)}
          >
            {confirmDel ? t('library.res.confirmDelete') : t('library.res.delete')}
          </button>
        )}
        <button className="btn" onClick={onClose}>
          {t('library.cancel')}
        </button>
        <button className={'btn-acc' + (ready && !save.isPending ? '' : ' dis')} onClick={() => ready && save.mutate()}>
          {save.isPending ? t('library.saving') : t('library.save')}
        </button>
      </div>
    </Modal>
  )
}

/**
 * «Поделиться ресурсом» — ссылка и мессенджеры.
 *
 * Отправить человеку внутри Chatick сервер пока не умеет (такой ручки нет),
 * поэтому в окне только ссылка: её копируют или отдают в мессенджер.
 */
function ShareModal({ row, onClose }: { row: Row; onClose: () => void }) {
  const { t } = useTranslation('v2')
  const { company } = useUi()
  const copy = useCopy()
  // Ссылка на сам ресурс в Chatick и публичный доступ — общий диалог, как в старом клиенте.
  const [inApp, setInApp] = useState(false)
  const [msg, setMsg] = useState('')
  const link = withScheme(row.url ?? '')
  const text = msg.trim() ? `${msg.trim()}\n${link}` : link
  const open = (href: string) => window.open(href, '_blank', 'noopener')
  return (
    <Modal label={t('library.res.shareTitle')} onClose={onClose}>
      <div className="mh">
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3>{t('library.res.shareTitle')}</h3>
          <div className="s">{row.name || row.url}</div>
        </div>
        <button className="ib" aria-label={t('library.close')} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="linkbox">
        <span>{link}</span>
        <button className="mini" onClick={() => copy(text, t('library.res.linkCopied'))}>
          <Svg sm>{COPY}</Svg>
          {t('library.copy')}
        </button>
      </div>
      <input className="nin bidi" value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={t('library.res.msgPh')} aria-label={t('library.res.msgAria')} />
      <div>
        <div className="lbl">{t('library.res.viaMessenger')}</div>
        <div className="ext">
          <button onClick={() => open(`https://wa.me/?text=${encodeURIComponent(text)}`)}>WhatsApp</button>
          <button onClick={() => open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(msg.trim() || row.name)}`)}>Telegram</button>
          <button onClick={() => (window.location.href = `mailto:?subject=${encodeURIComponent(row.name || link)}&body=${encodeURIComponent(text)}`)}>Email</button>
        </div>
      </div>
      <button className="mini" onClick={() => setInApp(true)}>
        {t('library.res.shareInApp')}
      </button>
      {inApp && (
        <ShareItem
          type="resource"
          id={row.id}
          title={row.name || row.url || ''}
          path={`/p/${row.project.id}/resources/${row.id}`}
          canPublish={company.myRole === 'admin' || company.myRole === 'manager'}
          onClose={() => setInApp(false)}
        />
      )}
      {row.secretCount > 0 && (
        <div className="note-s">
          <Svg sm>{LOCK}</Svg>
          {t('library.res.shareNote')}
        </div>
      )}
      <div className="mf">
        <div className="res" />
        <button className="btn" onClick={onClose}>
          {t('library.done')}
        </button>
      </div>
    </Modal>
  )
}

type Audit = { id: string; action: string; resourceName: string; createdAt: string; user: { name: string; email: string } | null }

/** Журнал доступа к ресурсам проекта: кто что раскрыл, создал, удалил. */
function LogModal({ projects, defaultProject, onClose }: { projects: CompanyProject[]; defaultProject: string | null; onClose: () => void }) {
  const { t, i18n } = useTranslation('v2')
  const [picked, setPid] = useState<string | null>(null)
  const pid = picked ?? defaultProject ?? projects[0]?.id ?? null
  const log = useQuery({
    queryKey: ['v2', 'lib', 'res-log', pid],
    queryFn: () => api<Audit[]>('/api/v1/resources/audit/log', inProject(pid!)),
    enabled: Boolean(pid),
    retry: false,
  })
  return (
    <Modal label={t('library.res.logTitle')} onClose={onClose} wide top>
      <div className="mh">
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3>{t('library.res.logTitle')}</h3>
          <div className="s">{t('library.res.logSub')}</div>
        </div>
        <button className="ib" aria-label={t('library.close')} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <ProjectCombo projects={projects} value={pid} onChange={setPid} />
      <div className="lib-log">
        {log.isLoading && <div className="none">{t('common.loading')}</div>}
        {log.isError && <div className="none">{log.error instanceof ApiError && log.error.status === 403 ? t('library.res.logForbidden') : t('common.error')}</div>}
        {log.data?.map((r) => (
          <div key={r.id} className="lib-log-r">
            <time>{new Date(r.createdAt).toLocaleString(i18n.language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time>
            <b className="bidi">{r.user?.name ?? r.user?.email ?? '—'}</b>
            <span className={'tchip' + (r.action === 'reveal' ? ' lib-rev' : '')}>{t(`library.res.audit.${r.action}`, { defaultValue: r.action })}</span>
            <span className="bidi lib-log-n">{r.resourceName}</span>
          </div>
        ))}
        {log.data && !log.data.length && <div className="none">{t('library.res.logEmpty')}</div>}
      </div>
    </Modal>
  )
}
