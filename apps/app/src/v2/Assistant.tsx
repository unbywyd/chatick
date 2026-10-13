import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '@/lib/api'
import { errorCode, SOCKET_EVENT, useProjects, type SocketMessage } from './data'
import { uploadFile } from './task/parts'
import './i18n/list'
import { useUi, type AskContext } from './ui'
import { Icon } from './Icon'
import { AssistantInput, type AssistantInputHandle } from './AssistantInput'

type Msg = { id: string; role: 'user' | 'assistant'; text: string; tools: string[]; failed: boolean; createdAt: string }
type Live = { replyTo: string; text: string; tool: string | null }
/** Ответа ещё нет id: вопрос в пути (pending) или сервер занят им после перезагрузки (busy). */
const PENDING = 'pending'
const BUSY = 'busy'

/** Раздел экрана — для подписи контекста и для сервера: о чём спрашивают. */
const SECTION = /\/c\/[^/]+\/(docs|notes|time|resources|files|versions|history|company|settings|notifications)(?:\/|$)/

/**
 * Ассистент компании — справа, один разговор на человека и компанию.
 *
 * Ответ идёт потоком по сокету: thinking → tool → delta… → message. Черновик
 * склеиваем из delta, а по message перечитываем историю — сохранённый ответ и
 * есть правда, даже если какой-то кусок по дороге потерялся.
 *
 * Сокету одному не доверяем: событие могло пройти мимо (переподключение,
 * панель открылась позже, перезагрузка во время ответа). Пока ответ в пути,
 * панель раз в 4 с сверяется с историей — и «думаю…» не зависает навсегда,
 * а ответ не теряется. «Думаю…» встаёт сразу по нажатию, а не по событию.
 */
export function Assistant() {
  const { t } = useTranslation('v2')
  const { companyId, company, base, setAiOpen, project, openTaskId: panelTaskId, pendingAsk, clearAsk, openTask } = useUi()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  // Задача — из панели (?t=) или со страницы задачи (/task/:id).
  const pageTask = pathname.match(/\/task\/([^/]+)$/)?.[1]
  const section = pathname.match(SECTION)?.[1] ?? null
  const openTaskId = panelTaskId ?? (pageTask && pageTask !== 'new' ? pageTask : null)
  const qc = useQueryClient()
  const key = ['v2', 'assistant', companyId]
  const [text, setText] = useState('')
  const [live, setLive] = useState<Live | null>(null)
  const history = useQuery({
    queryKey: key,
    queryFn: () => api<{ items: Msg[]; busy: boolean }>(`/api/v1/assistant/${companyId}/messages`),
    // Пока ответ в пути — сверяемся с сервером, не полагаясь на одно событие сокета.
    refetchInterval: (q) => (live || q.state.data?.busy ? 4000 : false),
  })
  const [note, setNote] = useState<string | null>(null)
  const end = useRef<HTMLDivElement>(null)
  const input = useRef<AssistantInputHandle>(null)
  // Готов ли ИИ — заранее: без ключа панель скажет почему и кто может починить.
  const status = useQuery({
    queryKey: ['v2', 'assistant-status', companyId],
    queryFn: () => api<{ ready: boolean; reason: 'no_key' | 'trial_over' | null; isAdmin: boolean }>(`/api/v1/assistant/${companyId}/status`),
    staleTime: 60_000,
  })
  const notReady = status.data && !status.data.ready ? status.data : null
  // Скриншоты и файлы к вопросу: временно в проект на экране (или первый свой),
  // сервер покажет их модели и сам уберёт непривязанные через сутки.
  const projects = useProjects(companyId)
  const upProject = project ?? projects.data?.[0]?.id ?? null
  const [files, setFiles] = useState<{ id: string; name: string }[]>([])
  const [uploading, setUploading] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)
  const attach = async (list: File[]) => {
    if (!upProject) return
    for (const f of list.slice(0, Math.max(0, 6 - files.length))) {
      setUploading((n) => n + 1)
      try {
        const r = await uploadFile(upProject, f)
        setFiles((x) => [...x, { id: r.id, name: r.name ?? f.name }])
      } catch {
        setNote(t('task.uploadFailed'))
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }
  // Раньше: история приходит последними 50, старое — по кнопке.
  const [older, setOlder] = useState<Msg[]>([])
  const [olderDone, setOlderDone] = useState(false)
  const [clearSure, setClearSure] = useState(false)

  useEffect(() => {
    const on = (e: Event) => {
      const { event, payload } = (e as CustomEvent<SocketMessage>).detail
      if (event !== 'assistant') return
      const p = payload as { companyId: string; action: string; id?: string; replyTo?: string; text?: string; name?: string; path?: string; taskId?: string; draft?: Record<string, unknown> }
      if (p.companyId !== companyId) return
      if (p.action === 'thinking' && p.id) setLive((l) => (l && l.text ? l : { replyTo: p.id!, text: '', tool: l?.tool ?? null }))
      // До ответа сервера на отправку id вопроса ещё нет — принимаем события и для «pending».
      const mine = (l: Live) => l.replyTo === p.replyTo || l.replyTo === PENDING || l.replyTo === BUSY
      if (p.action === 'tool') setLive((l) => (l && mine(l) ? { ...l, replyTo: p.replyTo ?? l.replyTo, tool: p.name ?? null } : l))
      if (p.action === 'delta') setLive((l) => (l && mine(l) ? { ...l, replyTo: p.replyTo ?? l.replyTo, text: l.text + (p.text ?? ''), tool: null } : l))
      // «Открой…» — ассистент переключает экран. Адрес собрал сервер из
      // проверенных записей; панель ассистента остаётся открытой.
      if (p.action === 'open') {
        if (p.taskId) openTask(p.taskId)
        // Черновик задачи: форма заполнена, создаёт человек кнопкой.
        else if (p.path === '/task/new') navigate(`${base}/task/new`, { state: { draft: p.draft ?? {} } })
        else if (typeof p.path === 'string' && (p.path === '' || p.path.startsWith('/') || p.path.startsWith('?'))) navigate(`${base}${p.path}`)
      }
      if (p.action === 'message') {
        void qc.invalidateQueries({ queryKey: key }).then(() => setLive(null))
        // Ассистент мог создать или передать задачу — списки устарели.
        void qc.invalidateQueries({ queryKey: ['v2', 'ball'] })
      }
    }
    window.addEventListener(SOCKET_EVENT, on)
    return () => window.removeEventListener(SOCKET_EVENT, on)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, qc])

  const items = [...older, ...(history.data?.items ?? [])]
  const lastAsked = [...items].reverse().find((x) => x.role === 'user')?.text ?? ''
  const busy = Boolean(history.data?.busy)

  // Перезагрузили, пока ассистент отвечал: сервер занят — показываем «думаю…».
  useEffect(() => {
    if (busy && !live) setLive({ replyTo: BUSY, text: '', tool: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy])
  // Ответ уже в истории (событие могло пройти мимо) — черновик больше не нужен.
  useEffect(() => {
    if (!live || live.replyTo === PENDING) return
    const last = items[items.length - 1]
    if (live.replyTo === BUSY ? !busy && last?.role === 'assistant' : last?.role === 'assistant' && items.some((m) => m.id === live.replyTo)) setLive(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, busy])
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [items.length, live?.text])

  const screenCtx = (): AskContext => ({
    screen: openTaskId ? 'task' : (section ?? 'tasks'),
    ...(project ? { projectId: project } : {}),
    ...(openTaskId ? { taskId: openTaskId } : {}),
  })
  const send = useMutation({
    mutationFn: (v: { text: string; context?: AskContext }) =>
      api<Msg>(`/api/v1/assistant/${companyId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text: v.text, context: { ...screenCtx(), ...(files.length ? { fileIds: files.map((f) => f.id) } : {}), ...(v.context ?? {}) } }),
      }),
    onMutate: () => {
      setNote(null)
      // «Думаю…» — сразу по нажатию, не дожидаясь сокета.
      setLive({ replyTo: PENDING, text: '', tool: null })
    },
    onSuccess: (m) => {
      setText('')
      setFiles([])
      input.current?.clear()
      qc.setQueryData<{ items: Msg[]; busy: boolean }>(key, (old) => ({ items: [...(old?.items ?? []).filter((x) => x.id !== m.id), m], busy: true }))
      setLive((l) => (l && (l.replyTo === PENDING || l.replyTo === BUSY) ? { ...l, replyTo: m.id } : l))
    },
    onError: (e) => {
      setLive(null)
      setNote(errorCode(e) === 'busy' ? t('ai.busy') : t('err.generic'))
    },
  })
  const clear = useMutation({
    mutationFn: () => api(`/api/v1/assistant/${companyId}/messages`, { method: 'DELETE' }),
    onSuccess: () => {
      setClearSure(false)
      setOlder([])
      setOlderDone(false)
      qc.setQueryData(key, { items: [], busy: false })
    },
  })
  const loadOlder = useMutation({
    mutationFn: () => {
      const first = older[0] ?? history.data?.items[0]
      return api<{ items: Msg[] }>(`/api/v1/assistant/${companyId}/messages?limit=50${first ? `&before=${encodeURIComponent(first.createdAt)}` : ''}`)
    },
    onSuccess: (r) => {
      setOlder((x) => [...r.items, ...x])
      if (r.items.length < 50) setOlderDone(true)
    },
  })

  const ask = (msg: string, context?: AskContext) => {
    const s = msg.trim()
    if (s && !send.isPending && !live) send.mutate({ text: s, context })
  }
  // Вопрос с другого экрана (кнопки «спросить ассистента») — отправляем отсюда,
  // чтобы видеть ход ответа. Пока занят прошлым — ждём.
  useEffect(() => {
    // Ждём историю и свободный сервер: иначе вопрос отобьётся «занято» (409).
    if (!pendingAsk || !history.data || busy || live || send.isPending) return
    clearAsk()
    send.mutate({ text: pendingAsk.text, context: pendingAsk.context })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAsk, live, send.isPending, history.data, busy])
  const ctx = openTaskId ? t('ai.ctx.task', { id: '' }).trim() : section ? t(`nav.${section}`, { defaultValue: t('ai.ctx.tasks') }) : t('ai.ctx.tasks')

  return (
    <aside className="aside" aria-label={t('ai.aria')}>
      <div className="ah">
        <img className="ah-mk" src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
        <div style={{ minWidth: 0 }}>
          <div className="nm">{t('ai.name')}</div>
          <div className="s bidi">{t('ai.sees', { company: company.name })}</div>
        </div>
        {items.length > 0 &&
          (clearSure ? (
            <button className="mini danger on" style={{ marginInlineStart: 'auto' }} onClick={() => clear.mutate()} onBlur={() => setClearSure(false)}>
              {t('ai2.clearSure')}
            </button>
          ) : (
            <button className="ib" style={{ marginInlineStart: 'auto' }} aria-label={t('ai.clear')} title={t('ai.clear')} onClick={() => setClearSure(true)}>
              <Icon name="reopen" />
            </button>
          ))}
        <button className="ib" style={{ marginInlineStart: items.length ? 0 : 'auto' }} aria-label={t('ai.collapse')} onClick={() => setAiOpen(false)}>
          <Icon name="sidebar" />
        </button>
      </div>
      <div className="msgs" aria-live="polite">
        {(history.data?.items.length ?? 0) >= 50 && !olderDone && (
          <button className="more2 ai-older" disabled={loadOlder.isPending} onClick={() => loadOlder.mutate()}>
            {t('ai2.earlier')}
          </button>
        )}
        {items.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="mu bidi">
              {m.text}
            </div>
          ) : (
            <div key={m.id} className="ma">
              {m.failed ? (
                <>
                  <p>{t('ai.failed')}</p>
                  {/* Сбой у модели бывает разовым — повторить тот же вопрос одной кнопкой. */}
                  {m.id === items[items.length - 1]?.id && lastAsked && !live && (
                    <button className="sug" onClick={() => ask(lastAsked)}>
                      {t('ai.retry')}
                    </button>
                  )}
                </>
              ) : (
                <Markdown remarkPlugins={[remarkGfm]}>{m.text}</Markdown>
              )}
            </div>
          ),
        )}
        {live && (
          <div className="ma">
            {live.text ? <Markdown remarkPlugins={[remarkGfm]}>{live.text}</Markdown> : <p style={{ color: 'var(--ink3)' }}>{live.tool ? t('ai.tool', { name: live.tool }) : t('ai.thinking')}</p>}
          </div>
        )}
        <div ref={end} />
      </div>
      {!items.length && !live && (
        <div className="chips" style={{ padding: '0 16px 10px' }}>
          {(t('ai.sug', { returnObjects: true }) as string[]).map((s) => (
            <button key={s} className="sug" onClick={() => ask(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      {notReady && (
        <div className="need ai-off" role="status" style={{ margin: '0 16px 8px' }}>
          <Icon name="info" />
          <span>
            {t(`ai2.off.${notReady.reason ?? 'no_key'}`)}{' '}
            {notReady.isAdmin ? (
              <button className="lt-link" onClick={() => navigate(`${base}/settings/company`)}>
                {t('ai2.fix')}
              </button>
            ) : (
              t('ai2.askAdmin')
            )}
          </span>
        </div>
      )}
      {note && (
        <div className="need" role="alert" style={{ margin: '0 16px 8px' }}>
          <Icon name="info" />
          {note}
        </div>
      )}
      <div className="ain">
        <div className="ctx">
          <Icon name="target" sm />
          <span>{ctx}</span>
        </div>
        {files.length > 0 && (
          <div className="ai-files">
            {files.map((f) => (
              <span key={f.id} className="tchip bidi">
                {f.name}
                <button aria-label={t('ai2.removeFile')} onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))}>
                  <Icon name="close" sm />
                </button>
              </span>
            ))}
          </div>
        )}
        <AssistantInput ref={input} placeholder={t('ai.ph')} disabled={Boolean(live) || Boolean(notReady)} onChange={setText} onSubmit={(md) => ask(md)} onFiles={(fs) => void attach(fs)} />
        <div className="r">
          <button className="ib" aria-label={t('ai2.attach')} title={t('ai2.attachHint')} disabled={!upProject || files.length >= 6 || Boolean(notReady)} onClick={() => fileRef.current?.click()}>
            <Icon name="attach" />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const list = Array.from(e.target.files ?? [])
              e.target.value = ''
              if (list.length) void attach(list)
            }}
          />
          <span style={{ fontSize: 12, color: 'var(--ink3)', flex: 1 }}>{uploading ? t('task.uploading') : ''}</span>
          <button className="send" aria-label={t('ai.send')} onClick={() => ask(text)} disabled={!text.trim() || Boolean(live) || send.isPending}>
            <Icon name="send" />
          </button>
        </div>
      </div>
    </aside>
  )
}
