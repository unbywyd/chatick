import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, API_URL } from '@/lib/api'
import type { RichMention } from '@/components/ui/rich-editor'
import { errorCode, inProject, useMe, useProjects, useTask, type CompanyProject } from '../data'
import { useUi } from '../ui'
import { Icon } from '../Icon'
import { ProjectLogo } from '../ProjectLogo'
import { Carousel } from '../tasks/TasksView'
import { personColor, letterOf, shortProject, timeAgo } from '../util'
import { htmlText, kbKeys, useAllDocs, useDoc, useKbSocket, useNotes, useVersions, type DocFull, type DocItem, type NoteRow } from './kb'
import { CollabEditor, KbView, PlainEditor, useDocRoom } from './KbEditor'
import '../i18n/docs'
import '../styles/docs.css'

/**
 * Документы и заметки — база знаний компании (макет Docs).
 *
 * Слева дерево: «Компания» (заметки без проекта) и проекты — документы
 * проекта и заметки, которые в нём выяснились. В центре открытый документ,
 * справа — вопросы ассистенту и история.
 *
 * Адрес открытого: docs/d/<проект>/<документ> и docs/n/<заметка>. Проект в
 * адресе документа не украшение: сервер отдаёт документ только с X-Project,
 * а ссылку должны уметь открыть с нуля.
 *
 * Переключателя «читает ассистент» из макета нет: на сервере такого флага
 * нет, ассистент читает всё — документы проекта и заметки компании — сам.
 * Вместо выключателя — честная строка о том, где он это видит. «Моих
 * заметок» (видны только автору) тоже нет: заметки компании видят все в ней.
 */

type Sel = { kind: 'doc'; projectId: string; id: string } | { kind: 'note'; id: string } | null
type Item = { kind: 'doc' | 'note'; id: string; projectId: string | null; title: string; text: string; updatedAt: string }
type ProjectLike = { id: string; name: string; color: string | null; logoUrl?: string | null }

function parseSel(rest: string): Sel {
  const [k, a, b] = rest.split('/')
  if (k === 'd' && a && b) return { kind: 'doc', projectId: a, id: b }
  if (k === 'n' && a) return { kind: 'note', id: a }
  return null
}

const DOC_PATH = <path d="M6 3h8l4 4v14H6z" />
const NOTE_PATH = <path d="M5 4h14v12l-4 4H5zM15 20v-4h4M9 9h6M9 13h4" />
function Svg({ d, sm = true }: { d: React.ReactNode; sm?: boolean }) {
  return (
    <svg className={'ic' + (sm ? ' sm' : '')} viewBox="0 0 24 24" aria-hidden="true">
      {d}
    </svg>
  )
}

export function DocsView() {
  const { t } = useTranslation('v2')
  const { companyId, base, project, setProject, flash } = useUi()
  const navigate = useNavigate()
  const loc = useLocation()
  const qc = useQueryClient()
  const rest = useParams()['*'] ?? ''
  const projects = useProjects(companyId)
  const plist = useMemo(() => projects.data ?? [], [projects.data])
  const docs = useAllDocs(companyId)
  const [q, setQ] = useState('')
  // Поиск по смыслу (заметки) уходит по Enter: он стоит обращения к модели.
  const [applied, setApplied] = useState('')
  const notesAll = useNotes(companyId, '')
  const notesHit = useNotes(companyId, applied)
  const [pick, setPick] = useState(false)
  useKbSocket()

  const pmap = useMemo(() => new Map<string, ProjectLike>(plist.map((p) => [p.id, p])), [plist])
  const projectOf = (id: string | null, fallbackName?: string): ProjectLike | null =>
    id ? (pmap.get(id) ?? { id, name: fallbackName ?? '—', color: null }) : null

  const noteTitle = (n: NoteRow) => n.title.trim() || htmlText(n.body).slice(0, 80) || t('docs.noTitle')
  const allNotes = notesAll.data ?? []
  const s = q.trim().toLowerCase()
  const semantic = Boolean(applied) && applied === q.trim()

  const items = useMemo<Item[]>(() => {
    const d: Item[] = docs.items.map((x) => ({ kind: 'doc', id: x.id, projectId: x.projectId, title: x.title || t('docs.noTitle'), text: `${x.title} ${x.preview}`, updatedAt: x.updatedAt }))
    const n: Item[] = (semantic ? (notesHit.data ?? []) : allNotes).map((x) => ({
      kind: 'note',
      id: x.id,
      projectId: x.projectId,
      title: noteTitle(x),
      // Найденное по смыслу уже отобрано сервером — второй раз по буквам не режем.
      text: semantic ? '' : `${x.title} ${htmlText(x.body)} ${x.tags.join(' ')}`,
      updatedAt: x.updatedAt,
    }))
    return [...d, ...n].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    // noteTitle зависит только от t
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs.items, allNotes, notesHit.data, semantic, t])

  const visible = items.filter((i) => (!project || i.projectId === project) && (!s || (semantic && i.kind === 'note') || i.text.toLowerCase().includes(s)))

  // Группы: сначала компания, потом проекты — где правили последним, тот выше.
  const groups = useMemo(() => {
    const by = new Map<string, Item[]>()
    for (const i of visible) {
      const k = i.projectId ?? ''
      by.set(k, [...(by.get(k) ?? []), i])
    }
    const out: { key: string; project: ProjectLike | null; rows: Item[] }[] = []
    if (!project && (by.get('') || !s)) out.push({ key: '', project: null, rows: by.get('') ?? [] })
    const keys = [...by.keys()].filter((k) => k)
    if (project && !keys.includes(project) && !s) keys.push(project)
    for (const k of keys) {
      const nameFromNote = allNotes.find((n) => n.projectId === k)?.project?.name
      out.push({ key: k, project: projectOf(k, nameFromNote), rows: by.get(k) ?? [] })
    }
    return out
    // projectOf читает pmap
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, project, s, pmap, allNotes])

  const loading = projects.isLoading || docs.loading || notesAll.isLoading
  const routeSel = parseSel(rest)
  // Ничего не открыто — показываем первое из дерева, как в макете; адрес не
  // трогаем. Ждём все списки: иначе «первое» менялось бы по мере загрузки.
  const first = loading ? undefined : groups.find((g) => g.rows.length)?.rows[0]
  const sel: Sel = routeSel ?? (first ? (first.kind === 'doc' ? { kind: 'doc', projectId: first.projectId!, id: first.id } : { kind: 'note', id: first.id }) : null)
  const editInit = Boolean((loc.state as { edit?: boolean } | null)?.edit)

  const go = useCallback(
    (to: Sel, edit = false) =>
      navigate({ pathname: !to ? `${base}/docs` : to.kind === 'doc' ? `${base}/docs/d/${to.projectId}/${to.id}` : `${base}/docs/n/${to.id}`, search: loc.search }, { state: edit ? { edit: true } : null }),
    [navigate, base, loc.search],
  )

  const fail = (e: unknown) => flash(errorCode(e).startsWith('Forbidden') || errorCode(e) === '403' ? t('docs.noRights') : t('err.generic'))
  const createDoc = useMutation({
    mutationFn: (pid: string) =>
      api<DocFull>('/api/v1/documents', { method: 'POST', body: JSON.stringify({ title: t('docs.untitledDoc'), content: '' }), ...inProject(pid) }),
    onSuccess: (d, pid) => {
      void qc.invalidateQueries({ queryKey: kbKeys.docs(companyId) })
      go({ kind: 'doc', projectId: pid, id: d.id }, true)
    },
    onError: fail,
  })
  const createNote = useMutation({
    mutationFn: (pid: string | null) =>
      api<NoteRow>(`/api/v1/company/${companyId}/notes` + (pid ? `?project=${encodeURIComponent(pid)}` : ''), {
        method: 'POST',
        body: JSON.stringify({ type: 'note', title: t('docs.untitledNote'), body: '' }),
      }),
    onSuccess: async (n) => {
      await qc.invalidateQueries({ queryKey: ['v2', 'kb', 'notes'] })
      go({ kind: 'note', id: n.id }, true)
    },
    onError: fail,
  })

  // Документ живёт в проекте: выбран фильтр — туда, открыт документ проекта —
  // рядом с ним, иначе спрашиваем.
  const curProject = sel?.kind === 'doc' ? sel.projectId : sel?.kind === 'note' ? (allNotes.find((n) => n.id === sel.id)?.projectId ?? null) : null
  const newDoc = () => {
    const pid = project ?? curProject
    if (pid && pmap.has(pid)) createDoc.mutate(pid)
    else setPick(true)
  }
  const busy = createDoc.isPending || createNote.isPending

  const counts = items.filter((i) => i.projectId).map((i) => ({ project: { id: i.projectId! } }))
  const selNote = sel?.kind === 'note' ? (allNotes.find((n) => n.id === sel.id) ?? notesHit.data?.find((n) => n.id === sel.id) ?? null) : null

  return (
    <div className="kb">
      <div className="ph">
        <div>
          <h1>{t('docs.title')}</h1>
          <p>{t('docs.sub')}</p>
        </div>
        <span className="sp" />
        <button className="btn" onClick={() => createNote.mutate(project)} disabled={busy}>
          {t('docs.note')}
        </button>
        <div className="kb-pk">
          <button className="btn moss" onClick={newDoc} disabled={busy} aria-expanded={pick}>
            <Icon name="plus" sm />
            {t('docs.doc')}
          </button>
          {pick && (
            <ProjectPick
              projects={plist}
              onClose={() => setPick(false)}
              onPick={(id) => {
                setPick(false)
                createDoc.mutate(id)
              }}
            />
          )}
        </div>
      </div>

      <Carousel projects={plist} counts={counts} selected={project} onPick={setProject} />

      <div className="dl">
        <nav className="card tree" aria-label={t('docs.title')}>
          <label className="srch">
            <Icon name="search" sm />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setApplied(q.trim())
                if (e.key === 'Escape') {
                  setQ('')
                  setApplied('')
                }
              }}
              placeholder={t('docs.find')}
              aria-label={t('docs.find')}
              title={t('docs.findHint')}
            />
          </label>
          {groups.map((g) => (
            <div key={g.key || 'co'}>
              <div className="tg">
                {g.project && <ProjectLogo project={g.project} size="xs" />}
                <span className="nm bidi">{g.project ? shortProject(g.project.name) : t('docs.company')}</span>
                {(!g.project || pmap.has(g.project.id)) && (
                  <button
                    onClick={() => (g.project ? createDoc.mutate(g.project.id) : createNote.mutate(null))}
                    disabled={busy}
                    aria-label={t('docs.addIn', { name: g.project ? shortProject(g.project.name) : t('docs.company') })}
                    title={t('docs.addIn', { name: g.project ? shortProject(g.project.name) : t('docs.company') })}
                  >
                    <Icon name="plus" sm />
                  </button>
                )}
              </div>
              {g.rows.map((i) => {
                const on = sel?.id === i.id
                return (
                  <button
                    key={i.kind + i.id}
                    className={'di' + (on ? ' on' : '')}
                    aria-current={on ? 'page' : undefined}
                    onClick={() => go(i.kind === 'doc' ? { kind: 'doc', projectId: i.projectId!, id: i.id } : { kind: 'note', id: i.id })}
                    title={i.kind === 'doc' ? t('docs.kindDoc') : t('docs.kindNote')}
                  >
                    <Svg d={i.kind === 'doc' ? DOC_PATH : NOTE_PATH} />
                    <span className="bidi">{i.title}</span>
                  </button>
                )
              })}
            </div>
          ))}
          {loading && <div className="kb-none">{t('docs.loading')}</div>}
          {!loading && !visible.length && <div className="kb-none">{s ? t('docs.nothing') : t('docs.emptyTree')}</div>}
        </nav>

        {sel?.kind === 'doc' ? (
          <DocArticle
            key={sel.id}
            projectId={sel.projectId}
            docId={sel.id}
            project={projectOf(sel.projectId)}
            members={membersOf(plist.find((p) => p.id === sel.projectId))}
            editInit={editInit && Boolean(routeSel)}
            onDeleted={() => go(null)}
          />
        ) : sel?.kind === 'note' ? (
          selNote ? (
            <NoteArticle key={sel.id} note={selNote} project={projectOf(selNote.projectId, selNote.project?.name)} editInit={editInit && Boolean(routeSel)} onDeleted={() => go(null)} />
          ) : (
            <article className="card doc">
              <div className="kb-none">{notesAll.isLoading ? t('docs.loading') : t('docs.gone')}</div>
            </article>
          )
        ) : (
          <article className="card doc">
            <div className="kb-none">{loading ? t('docs.loading') : t('docs.pickLeft')}</div>
          </article>
        )}
      </div>
    </div>
  )
}

/** Участники проекта для @-упоминаний: список проектов их уже несёт. */
function membersOf(p: CompanyProject | undefined): RichMention[] {
  const m = (p as (CompanyProject & { members?: { id: string; name: string; avatarUrl?: string | null }[] }) | undefined)?.members ?? []
  return m.map((u) => ({ id: u.id, label: u.name, avatarUrl: u.avatarUrl ?? null }))
}

function ProjectPick({ projects, onPick, onClose }: { projects: CompanyProject[]; onPick: (id: string) => void; onClose: () => void }) {
  const { t } = useTranslation('v2')
  const [q, setQ] = useState('')
  const s = q.trim().toLowerCase()
  const list = projects.filter((p) => !s || p.name.toLowerCase().includes(s))
  return (
    <>
      <div className="gt-scrim" onClick={onClose} />
      <div className="gt-pop kb-pop" role="listbox" aria-label={t('docs.pickHead')}>
        <div className="hd">{t('docs.pickHead')}</div>
        <label className="cbx-s" style={{ margin: '0 4px 6px' }}>
          <Icon name="search" sm />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              if (e.key === 'Enter' && list[0]) onPick(list[0].id)
            }}
            placeholder={t('docs.pickFind')}
            aria-label={t('docs.pickFind')}
            autoFocus
          />
        </label>
        {list.map((p) => (
          <button key={p.id} className="gp" role="option" aria-selected={false} onClick={() => onPick(p.id)}>
            <ProjectLogo project={p} />
            <span className="nm">{p.name}</span>
          </button>
        ))}
        {!list.length && <div className="cbx-none">{t('docs.pickNone', { q })}</div>}
      </div>
    </>
  )
}

/** Шапка открытого: где лежит, кто и когда правил, правка и меню. */
function Meta({
  project,
  who,
  at,
  status,
  editing,
  canEdit,
  onToggle,
  menu,
}: {
  project: ProjectLike | null
  who: string | null
  at: string | null
  status: string
  editing: boolean
  canEdit: boolean
  onToggle: () => void
  menu: React.ReactNode
}) {
  const { t, i18n } = useTranslation('v2')
  return (
    <div className="dm">
      {project && <ProjectLogo project={project} size="xs" />}
      {/* Имя проекта и автора часто на иврите посреди русской строки — каждое изолируем. */}
      <span className="kb-place">
        <bdi>{project ? shortProject(project.name) : t('docs.company')}</bdi>
        {who && (
          <>
            {' · '}
            <bdi>{who}</bdi>
          </>
        )}
        {at ? ` · ${t('docs.updated', { when: timeAgo(i18n.language, at) })}` : ''}
      </span>
      <span className="sp" />
      {status && <span className="kb-st">{status}</span>}
      {canEdit && (
        <button className={'btn sm' + (editing ? ' pr' : '')} onClick={onToggle}>
          {editing ? t('docs.done') : t('docs.edit')}
        </button>
      )}
      {menu}
    </div>
  )
}

/** Меню «ещё»: ссылка, публичный доступ, удаление — удаление со вторым шагом. */
function MoreMenu({ title, children, onDelete }: { title: string; children?: (close: () => void) => React.ReactNode; onDelete: (() => void) | null }) {
  const { t } = useTranslation('v2')
  const { flash } = useUi()
  const [open, setOpen] = useState(false)
  const [ask, setAsk] = useState(false)
  const close = () => {
    setOpen(false)
    setAsk(false)
  }
  return (
    <div className="kb-pk">
      <button className="kb-ib" onClick={() => setOpen(!open)} aria-label={t('docs.more')} title={t('docs.more')} aria-expanded={open}>
        <Icon name="more" />
      </button>
      {open && (
        <>
          <div className="gt-scrim" onClick={close} />
          <div className="kb-menu" role="menu">
            {ask ? (
              <div className="kb-ask">
                <p className="bidi">{t('docs.delAsk', { title })}</p>
                <div>
                  <button className="btn sm kb-danger" onClick={() => (close(), onDelete?.())}>
                    {t('docs.delYes')}
                  </button>
                  <button className="btn sm" onClick={() => setAsk(false)}>
                    {t('docs.delNo')}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button
                  role="menuitem"
                  onClick={() => {
                    void navigator.clipboard?.writeText(window.location.href).catch(() => {})
                    flash(t('docs.linkCopied'))
                    close()
                  }}
                >
                  {t('docs.copyLink')}
                </button>
                {children?.(close)}
                {onDelete && (
                  <button role="menuitem" className="kb-danger" onClick={() => setAsk(true)}>
                    {t('docs.del')}
                  </button>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Автосохранение. Текст документа синхронизируется через Yjs сразу, а
 * HTML-снимок (для версий, публичной страницы и ассистента) пишем реже —
 * иначе несколько соавторов забьют базу встречными PATCH-ами.
 */
function useAutosave(dirty: boolean, save: () => void, deps: unknown[]) {
  const ref = useRef({ dirty, save })
  ref.current = { dirty, save }
  useEffect(() => {
    if (!dirty) return
    const id = window.setTimeout(() => ref.current.save(), 8000)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, ...deps])
  // Ушли со страницы посреди правки — дописываем, чтобы снимок не отстал.
  useEffect(
    () => () => {
      if (ref.current.dirty) ref.current.save()
    },
    [],
  )
}

function DocArticle({
  projectId,
  docId,
  project,
  members,
  editInit,
  onDeleted,
}: {
  projectId: string
  docId: string
  project: ProjectLike | null
  members: RichMention[]
  editInit: boolean
  onDeleted: () => void
}) {
  const { t } = useTranslation('v2')
  const { companyId, flash } = useUi()
  const qc = useQueryClient()
  const me = useMe()
  const doc = useDoc(projectId, docId)
  const [editing, setEditing] = useState(editInit)
  const meRef = useMemo(() => (me.data ? { id: me.data.id, name: me.data.name } : null), [me.data])
  // Подключение к документу — пока он открыт: совместная правка и «кто здесь».
  const room = useDocRoom(docId, meRef, editing)
  const [title, setTitle] = useState<string | null>(null)
  const [html, setHtml] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [synced, setSynced] = useState(false)
  const d = doc.data
  const curTitle = title ?? d?.title ?? ''

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: kbKeys.doc(docId) })
    void qc.invalidateQueries({ queryKey: kbKeys.docs(companyId) })
    void qc.invalidateQueries({ queryKey: kbKeys.versions(docId) })
  }
  const save = useMutation({
    mutationFn: (b: { title: string; content?: string }) =>
      api<DocFull>(`/api/v1/documents/${docId}`, { method: 'PATCH', body: JSON.stringify(b), ...inProject(projectId) }),
    onSuccess: (r) => {
      // Новое название в дереве — сразу, не дожидаясь перечитывания списка.
      qc.setQueryData<DocItem[]>(kbKeys.docs(companyId), (old) => old?.map((x) => (x.id === docId ? { ...x, title: r.title, updatedAt: r.updatedAt } : x)))
      refresh()
    },
    onError: (e) => flash(errorCode(e).startsWith('Forbidden') ? t('docs.noRights') : t('err.generic')),
  })
  const doSave = () => {
    setDirty(false)
    save.mutate({ title: curTitle.trim() || t('docs.noTitle'), ...(html !== null ? { content: html } : {}) })
  }
  useAutosave(dirty, doSave, [curTitle, html])

  const share = useMutation({
    mutationFn: (enabled: boolean) =>
      api<{ publicSlug: string | null }>(`/api/v1/documents/${docId}/share`, { method: 'POST', body: JSON.stringify({ enabled }), ...inProject(projectId) }),
    onSuccess: (r) => {
      refresh()
      if (r.publicSlug) {
        void navigator.clipboard?.writeText(`${API_URL}/d/${r.publicSlug}`).catch(() => {})
        flash(t('docs.shared'))
      } else flash(t('docs.unshared'))
    },
    onError: () => flash(t('docs.noRights')),
  })
  const remove = useMutation({
    mutationFn: () => api(`/api/v1/documents/${docId}`, { method: 'DELETE', ...inProject(projectId) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: kbKeys.docs(companyId) })
      flash(t('docs.deleted'))
      onDeleted()
    },
    onError: () => flash(t('docs.noRights')),
  })
  const onSynced = useCallback((v: boolean) => setSynced(v), [])

  if (doc.isError)
    return (
      <>
        <article className="card doc">
          <div className="kb-none">{t('docs.gone')}</div>
        </article>
        <aside className="rp" />
      </>
    )
  if (!d)
    return (
      <>
        <article className="card doc">
          <div className="kb-none">{t('docs.loading')}</div>
        </article>
        <aside className="rp" />
      </>
    )

  const status = editing ? (!synced ? t('docs.connecting') : save.isPending ? t('docs.saving') : dirty ? '' : t('docs.saved')) : ''
  const toggle = () => {
    if (editing && dirty) doSave()
    setEditing(!editing)
  }
  const shownTitle = curTitle.trim() || t('docs.noTitle')

  return (
    <>
      <article className="card doc">
        <Meta
          project={project}
          who={d.author?.name ?? null}
          at={d.updatedAt}
          status={status}
          editing={editing}
          canEdit
          onToggle={toggle}
          menu={
            <MoreMenu title={shownTitle} onDelete={() => remove.mutate()}>
              {(close) => (
                <>
                  {d.publicSlug && (
                    <button
                      role="menuitem"
                      onClick={() => {
                        void navigator.clipboard?.writeText(`${API_URL}/d/${d.publicSlug}`).catch(() => {})
                        flash(t('docs.linkCopied'))
                        close()
                      }}
                    >
                      {t('docs.copyPublic')}
                    </button>
                  )}
                  <button
                    role="menuitem"
                    onClick={() => {
                      share.mutate(!d.publicSlug)
                      close()
                    }}
                  >
                    {d.publicSlug ? t('docs.shareOff') : t('docs.shareOn')}
                  </button>
                </>
              )}
            </MoreMenu>
          }
        />
        {room.peers.length > 0 && (
          <div className="kb-peers" aria-label={t('docs.here')}>
            <span className="kb-peers-l">{t('docs.here')}</span>
            {room.peers.map((p) => (
              <span key={p.key} className={'kb-peer' + (p.editing ? ' ed' : '')} title={`${p.name} — ${p.editing ? t('docs.peerEditing') : t('docs.peerViewing')}`} style={{ background: p.color }}>
                {(p.name.trim()[0] ?? '?').toUpperCase()}
              </span>
            ))}
          </div>
        )}
        {editing ? (
          <input
            className="kb-title bidi"
            value={curTitle}
            onChange={(e) => {
              setTitle(e.target.value)
              setDirty(true)
            }}
            placeholder={t('docs.titlePh')}
            aria-label={t('docs.titlePh')}
          />
        ) : (
          <h1 className="bidi">{shownTitle}</h1>
        )}
        <div className="aiw">
          <Icon name="spark" />
          <span>{t('docs.aiDoc', { name: project ? shortProject(project.name) : '' })}</span>
        </div>
        {editing ? (
          <CollabEditor
            documentId={docId}
            projectId={projectId}
            seed={d.content}
            onChange={(h) => {
              setHtml(h)
              setDirty(true)
            }}
            onSynced={onSynced}
            mentions={members}
            me={meRef}
            placeholder={t('docs.bodyPh')}
            provider={room.provider}
            synced={room.synced}
          />
        ) : htmlText(d.content) || /<img|<table/.test(d.content) ? (
          <KbView html={d.content} />
        ) : (
          <p className="kb-empty">{t('docs.empty')}</p>
        )}
      </article>
      <aside className="rp">
        <AskCard kind="document" id={docId} projectId={projectId} title={shownTitle} />
        <DocHistory projectId={projectId} docId={docId} />
      </aside>
    </>
  )
}

function NoteArticle({ note, project, editInit, onDeleted }: { note: NoteRow; project: ProjectLike | null; editInit: boolean; onDeleted: () => void }) {
  const { t, i18n } = useTranslation('v2')
  const { companyId, company, flash, openTask } = useUi()
  const qc = useQueryClient()
  const me = useMe()
  // Своё правит автор, чужое — админ компании (так решает сервер).
  const canEdit = company.myRole === 'admin' || (Boolean(me.data) && note.author?.id === me.data?.id)
  const [editing, setEditing] = useState(editInit && canEdit)
  const [title, setTitle] = useState(note.title)
  const [body, setBody] = useState(note.body)
  const [dirty, setDirty] = useState(false)
  const task = useTask(note.taskId)

  const save = useMutation({
    mutationFn: (b: { title: string; body: string }) => api<NoteRow>(`/api/v1/company/${companyId}/notes/${note.id}`, { method: 'PATCH', body: JSON.stringify(b) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['v2', 'kb', 'notes'] }),
    onError: (e) => flash(errorCode(e).startsWith('Forbidden') ? t('docs.readOnly') : t('err.generic')),
  })
  const doSave = () => {
    setDirty(false)
    save.mutate({ title: title.trim(), body })
  }
  useAutosave(dirty, doSave, [title, body])
  const remove = useMutation({
    mutationFn: () => api(`/api/v1/company/${companyId}/notes/${note.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['v2', 'kb', 'notes'] })
      flash(t('docs.deleted'))
      onDeleted()
    },
    onError: () => flash(t('docs.readOnly')),
  })

  const shownTitle = (editing ? title : note.title).trim() || htmlText(note.body).slice(0, 80) || t('docs.noTitle')
  const status = editing ? (save.isPending ? t('docs.saving') : dirty ? '' : t('docs.saved')) : ''
  const shownBody = editing ? body : note.body

  return (
    <>
      <article className="card doc">
        <Meta
          project={project}
          who={note.author?.name ?? null}
          at={note.updatedAt}
          status={status}
          editing={editing}
          canEdit={canEdit}
          onToggle={() => {
            if (editing && dirty) doSave()
            setEditing(!editing)
          }}
          menu={<MoreMenu title={shownTitle} onDelete={canEdit ? () => remove.mutate() : null} />}
        />
        {editing ? (
          <input
            className="kb-title bidi"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              setDirty(true)
            }}
            placeholder={t('docs.titlePh')}
            aria-label={t('docs.titlePh')}
          />
        ) : (
          <h1 className="bidi">{shownTitle}</h1>
        )}
        <div className="aiw">
          <Icon name="spark" />
          <span>{project ? t('docs.aiNoteProject', { name: shortProject(project.name) }) : t('docs.aiNote')}</span>
        </div>
        {editing ? (
          <PlainEditor
            value={body}
            onChange={(h) => {
              setBody(h)
              setDirty(true)
            }}
            placeholder={t('docs.bodyPh')}
          />
        ) : htmlText(shownBody) ? (
          <KbView html={shownBody} />
        ) : (
          <p className="kb-empty">{canEdit ? t('docs.empty') : ''}</p>
        )}
      </article>
      <aside className="rp">
        <AskCard kind="note" id={note.id} projectId={note.projectId} title={shownTitle} />
        {note.taskId && (
          <section className="card">
            <h3>{t('docs.taskHead')}</h3>
            <button className="lk" onClick={() => openTask(note.taskId!)}>
              <span className="id">{task.data?.task.number ?? '…'}</span>
              <span className="bidi">{task.data?.task.title ?? ''}</span>
            </button>
          </section>
        )}
        <section className="card">
          <h3>{t('docs.histHead')}</h3>
          <Hist name={note.author?.name ?? null} id={note.author?.id ?? null} text={t('docs.created')} at={timeAgo(i18n.language, note.createdAt)} />
          {new Date(note.updatedAt).getTime() - new Date(note.createdAt).getTime() > 60_000 && (
            <Hist name={null} id={null} text={t('docs.updated', { when: '' }).trim()} at={timeAgo(i18n.language, note.updatedAt)} />
          )}
        </section>
      </aside>
    </>
  )
}

function Hist({ name, id, text, at }: { name: string | null; id: string | null; text: string; at: string }) {
  return (
    <div className="hv">
      <span className={'av' + (name ? '' : ' sys')} style={name ? { background: personColor(id) } : undefined}>
        {name ? letterOf(name) : '✦'}
      </span>
      <span className="tx">
        {name && <b className="bidi">{name} </b>}
        {text}
        <br />
        <time>{at}</time>
      </span>
    </div>
  )
}

function DocHistory({ projectId, docId }: { projectId: string; docId: string }) {
  const { t, i18n } = useTranslation('v2')
  const v = useVersions(projectId, docId)
  const rows = (v.data ?? []).slice(0, 6)
  return (
    <section className="card">
      <h3>{t('docs.histHead')}</h3>
      {rows.map((r) => (
        <Hist
          key={r.id}
          name={r.author?.name ?? null}
          id={r.author?.id ?? null}
          text={r.version === 1 && v.data?.length === 1 ? t('docs.created') : t('docs.version', { n: r.version })}
          at={timeAgo(i18n.language, r.createdAt)}
        />
      ))}
      {v.data && !rows.length && <div className="kb-mute">{t('docs.histNone')}</div>}
    </section>
  )
}

/**
 * Вопрос ассистенту про открытый документ: уходит в общий разговор справа.
 * В контекст кладём, что открыто — по id ассистент сам прочитает текст.
 */
function AskCard({ kind, id, projectId, title }: { kind: 'document' | 'note'; id: string; projectId: string | null; title: string }) {
  const { t } = useTranslation('v2')
  const { companyId, setAiOpen, flash } = useUi()
  const qc = useQueryClient()
  const send = useMutation({
    mutationFn: (text: string) =>
      api(`/api/v1/assistant/${companyId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text, context: { screen: `docs: ${kind} ${id}`, ...(projectId ? { projectId } : {}) } }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['v2', 'assistant', companyId] })
      setAiOpen(true)
    },
    onError: (e) => flash(errorCode(e) === 'busy' ? t('ai.busy') : t('err.generic')),
  })
  const keys = (kind === 'document' ? ['sum', 'old', 'tasks'] : ['sum', 'old']) as ('sum' | 'old' | 'tasks')[]
  return (
    <section className="card">
      <h3>{t('docs.askHead')}</h3>
      <div className="ask">
        {keys.map((k) => (
          <button key={k} disabled={send.isPending} onClick={() => send.mutate(t(`docs.ask.${k}`, { title }))}>
            {t(`docs.askLabel.${k}`)}
          </button>
        ))}
      </div>
    </section>
  )
}
