import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '@/lib/api'
import { errorCode, SOCKET_EVENT, type SocketMessage } from './data'
import { useUi } from './ui'
import { Icon } from './Icon'
import { AssistantInput, type AssistantInputHandle } from './AssistantInput'

type Msg = { id: string; role: 'user' | 'assistant'; text: string; tools: string[]; failed: boolean; createdAt: string }
type Live = { replyTo: string; text: string; tool: string | null }

/**
 * Ассистент компании — справа, один разговор на человека и компанию.
 *
 * Ответ идёт потоком по сокету: thinking → tool → delta… → message. Черновик
 * склеиваем из delta, а по message перечитываем историю — сохранённый ответ и
 * есть правда, даже если какой-то кусок по дороге потерялся.
 */
export function Assistant() {
  const { t } = useTranslation('v2')
  const { companyId, company, setAiOpen, project, openTaskId: panelTaskId } = useUi()
  // Задача — из панели (?t=) или со страницы задачи (/task/:id).
  const pageTask = useLocation().pathname.match(/\/task\/([^/]+)$/)?.[1]
  const openTaskId = panelTaskId ?? (pageTask && pageTask !== 'new' ? pageTask : null)
  const qc = useQueryClient()
  const key = ['v2', 'assistant', companyId]
  const history = useQuery({
    queryKey: key,
    queryFn: () => api<{ items: Msg[]; busy: boolean }>(`/api/v1/assistant/${companyId}/messages`),
  })
  const [text, setText] = useState('')
  const [live, setLive] = useState<Live | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const end = useRef<HTMLDivElement>(null)
  const input = useRef<AssistantInputHandle>(null)

  useEffect(() => {
    const on = (e: Event) => {
      const { event, payload } = (e as CustomEvent<SocketMessage>).detail
      if (event !== 'assistant') return
      const p = payload as { companyId: string; action: string; id?: string; replyTo?: string; text?: string; name?: string }
      if (p.companyId !== companyId) return
      if (p.action === 'thinking' && p.id) setLive({ replyTo: p.id, text: '', tool: null })
      if (p.action === 'tool') setLive((l) => (l && l.replyTo === p.replyTo ? { ...l, tool: p.name ?? null } : l))
      if (p.action === 'delta') setLive((l) => (l && l.replyTo === p.replyTo ? { ...l, text: l.text + (p.text ?? ''), tool: null } : l))
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
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [items.length, live?.text])

  const send = useMutation({
    mutationFn: (msg: string) =>
      api<Msg>(`/api/v1/assistant/${companyId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          text: msg,
          context: { screen: openTaskId ? 'task' : 'tasks', ...(project ? { projectId: project } : {}), ...(openTaskId ? { taskId: openTaskId } : {}) },
        }),
      }),
    onMutate: () => setNote(null),
    onSuccess: (m) => {
      setText('')
      input.current?.clear()
      qc.setQueryData<{ items: Msg[]; busy: boolean }>(key, (old) => ({ items: [...(old?.items ?? []), m], busy: true }))
      setLive((l) => l ?? { replyTo: m.id, text: '', tool: null })
    },
    onError: (e) => setNote(errorCode(e) === 'busy' ? t('ai.busy') : t('err.generic')),
  })
  const clear = useMutation({
    mutationFn: () => api(`/api/v1/assistant/${companyId}/messages`, { method: 'DELETE' }),
    onSuccess: () => qc.setQueryData(key, { items: [], busy: false }),
  })

  const ask = (msg: string) => {
    const s = msg.trim()
    if (s && !send.isPending) send.mutate(s)
  }
  const ctx = openTaskId ? t('ai.ctx.task', { id: '' }).trim() : t('ai.ctx.tasks')

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
              {m.failed ? <p>{t('ai.failed')}</p> : <Markdown remarkPlugins={[remarkGfm]}>{m.text}</Markdown>}
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
        <AssistantInput ref={input} placeholder={t('ai.ph')} disabled={Boolean(live)} onChange={setText} onSubmit={ask} />
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
