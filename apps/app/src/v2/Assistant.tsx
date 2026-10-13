import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '@/lib/api'
import { errorCode, SOCKET_EVENT, type SocketMessage } from './data'
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

  const items = history.data?.items ?? []
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
        body: JSON.stringify({ text: v.text, context: { ...screenCtx(), ...(v.context ?? {}) } }),
      }),
    onMutate: () => {
      setNote(null)
      // «Думаю…» — сразу по нажатию, не дожидаясь сокета.
      setLive({ replyTo: PENDING, text: '', tool: null })
    },
    onSuccess: (m) => {
      setText('')
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
    onSuccess: () => qc.setQueryData(key, { items: [], busy: false }),
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
        <span className="spark">
          <Icon name="spark" />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="nm">{t('ai.name')}</div>
          <div className="s bidi">{t('ai.sees', { company: company.name })}</div>
        </div>
        {items.length > 0 && (
          <button className="ib" style={{ marginInlineStart: 'auto' }} aria-label={t('ai.clear')} title={t('ai.clear')} onClick={() => clear.mutate()}>
            <Icon name="reopen" />
          </button>
        )}
        <button className="ib" style={{ marginInlineStart: items.length ? 0 : 'auto' }} aria-label={t('ai.collapse')} onClick={() => setAiOpen(false)}>
          <Icon name="sidebar" />
        </button>
      </div>
      <div className="msgs" aria-live="polite">
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
        <AssistantInput ref={input} placeholder={t('ai.ph')} disabled={Boolean(live)} onChange={setText} onSubmit={(md) => ask(md)} />
        <div className="r">
          <span style={{ fontSize: 12, color: 'var(--ink3)', flex: 1 }} />
          <button className="send" aria-label={t('ai.send')} onClick={() => ask(text)} disabled={!text.trim() || Boolean(live) || send.isPending}>
            <Icon name="send" />
          </button>
        </div>
      </div>
    </aside>
  )
}
