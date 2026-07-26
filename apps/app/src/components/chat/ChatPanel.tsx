import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, Bot, CheckSquare, Users, BrainCircuit, Loader2, Menu, NotebookPen, PanelsTopLeft, Search, Settings, Trash2, UserPlus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ProjectSwitcher } from './ProjectSwitcher'
import { Button } from '@/components/ui/button'
import { useProjectSocket, type ChatMessage } from '@/hooks/useProjectSocket'
import { Composer, AI_MENTION_ID } from './Composer'
import { SandboxOverlay } from './SandboxOverlay'
import { AiOverlay } from './AiOverlay'
import { FileViewer, type ViewerFile } from '@/components/files/FileViewer'
import { NOTE_META, NOTE_TYPES, type NoteType } from '@/components/tabs/NotesTab'
import { DatePicker } from '@/components/ui/date-picker'

type ChatMode = 'group' | 'ai'
type Member = { id: string; role: string; user: { id: string; name: string; email: string; avatarUrl: string | null } }

// mention-разметка @[Label](id) → рендерим как @Label
const mentionRe = /@\[([^\]]+)\]\(([^)]+)\)/g
const renderMentions = (text: string) => text.replace(mentionRe, '**@$1**')

export function ChatPanel({
  projectName,
  aiMode = 'assistant',
  myRole,
  meId,
  onOpenSidebar,
  onOpenWork,
}: {
  projectName?: string
  aiMode?: 'observer' | 'assistant' | 'moderator'
  myRole?: 'owner' | 'admin' | 'member' | null
  meId?: string
  /** мобильный: открыть список проектов и уйти в рабочую зону — на десктопе не нужны */
  onOpenSidebar?: () => void
  onOpenWork?: () => void
}) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { id: projectId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const qc = useQueryClient()
  // «ИИ» — не отдельный таб, а оверлей поверх группового чата (единый паттерн с sandbox)
  const [aiOpen, setAiOpen] = useState(false)
  const mode: ChatMode = 'group'
  const [checkingUsers, setCheckingUsers] = useState<Map<string, string>>(new Map()) // userId -> name («пишет…»)
  const [myPending, setMyPending] = useState(false) // «проверяется…» у автора
  const [sandboxId, setSandboxId] = useState<string | null>(null)
  const [sandboxStream, setSandboxStream] = useState('') // постепенная печать ответа ИИ
  const [aiThinking, setAiThinking] = useState(false) // ai-режим: ждём ответ
  const [searchOpen, setSearchOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [newBelow, setNewBelow] = useState(false)
  // режим «перехода к сообщению»: окно контекста + подсветка
  const [contextView, setContextView] = useState<{ messages: ChatMessage[] } | null>(null)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  // выделение сообщений для сохранения в заметку (SPEC §8.31). Множественное,
  // потому что противоречие — это цепочка реплик, одна ничего не доказывает.
  const [picked, setPicked] = useState<string[]>([])
  const [noteDraft, setNoteDraft] = useState<string[] | null>(null)

  const llm = useQuery({
    queryKey: ['llm-status', projectId],
    queryFn: () => api<{ configured: boolean; companyId: string }>(`/api/v1/projects/${projectId}/llm-status`, {}, 'project'),
    enabled: Boolean(projectId),
  })
  const llmMissing = llm.data ? !llm.data.configured : false

  const members = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => api<Member[]>(`/api/v1/projects/${projectId}/members`),
    enabled: Boolean(projectId),
  })

  // Ленивая подгрузка вверх: страницы по 50, курсор before=<createdAt самого старого>
  const history = useInfiniteQuery({
    queryKey: ['messages', projectId],
    enabled: Boolean(projectId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<ChatMessage[]>(`/api/v1/messages${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ''}`, {}, 'project'),
    // страница отсортирована по возрастанию; следующий курсор — самое старое сообщение
    getNextPageParam: (lastPage) => (lastPage.length >= 50 ? lastPage[0]?.createdAt : undefined),
  })
  const historyMessages = useMemo(() => (history.data?.pages ?? []).flat(), [history.data])

  const [live, setLive] = useState<ChatMessage[]>([])
  useEffect(() => setLive([]), [projectId])

  const onWsMessage = useCallback((m: ChatMessage) => {
    if (m.mode === 'ai' && !m.author) setAiThinking(false)
    setLive((prev) => {
      // finalize мог обновить текст held-сообщения — заменяем по id
      const idx = prev.findIndex((x) => x.id === m.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = m
        return next
      }
      return [...prev, m]
    })
    setMyPending(false)
  }, [])

  const { online, connected } = useProjectSocket(projectId, {
    onMessage: onWsMessage,
    onChecking: ({ userId, name }) => setCheckingUsers((prev) => new Map(prev).set(userId, name)),
    onCheckingDone: ({ userId }) =>
      setCheckingUsers((prev) => {
        const next = new Map(prev)
        next.delete(userId)
        return next
      }),
    onHeld: ({ messageId }) => {
      setMyPending(false)
      setSandboxId(messageId)
    },
    onSandboxChunk: ({ delta }) => setSandboxStream((prev) => prev + delta),
    onMessageDeleted: ({ messageId }) => {
      setLive((prev) => prev.filter((m) => m.id !== messageId))
      qc.invalidateQueries({ queryKey: ['messages', projectId] })
    },
  })

  // история + live, дедуп по id; в ленте только delivered (SPEC §5.5.1 — до вердикта не показываем)
  const merged = useMemo(() => {
    const byId = new Map<string, ChatMessage>()
    for (const m of [...historyMessages, ...live]) byId.set(m.id, m)
    return [...byId.values()]
      .filter((m) => m.status === 'delivered')
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }, [historyMessages, live])
  const allMessages = useMemo(() => merged.filter((m) => m.mode === 'group'), [merged])
  const aiMessages = useMemo(() => merged.filter((m) => m.mode === 'ai'), [merged])
  // лента: окно контекста (режим истории) либо обычная лента
  const feed = contextView?.messages ?? allMessages

  // held-сообщение из истории (после перезагрузки) — снова открыть sandbox
  useEffect(() => {
    const held = historyMessages.find((m) => m.status === 'held')
    if (held && !sandboxId) setSandboxId(held.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyMessages])

  // автоскролл вниз только если пользователь у низа; иначе — бейдж «новые»
  const prevCount = useRef(0)
  useEffect(() => {
    const grew = allMessages.length > prevCount.current
    prevCount.current = allMessages.length
    if (!grew || contextView) return // в режиме истории не дёргаем вниз
    if (atBottom) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    else setNewBelow(true)
  }, [allMessages.length, atBottom, contextView])

  // при первом заходе — сразу вниз
  const didInitialScroll = useRef(false)
  useEffect(() => {
    if (!didInitialScroll.current && allMessages.length > 0) {
      didInitialScroll.current = true
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView())
    }
  }, [allMessages.length])

  // скролл: отслеживаем низ + ленивая подгрузка при приближении к верху
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    setAtBottom(nearBottom)
    if (nearBottom) setNewBelow(false)
    if (el.scrollTop < 200 && history.hasNextPage && !history.isFetchingNextPage) {
      const prevHeight = el.scrollHeight
      history.fetchNextPage().then(() => {
        // сохранить позицию: старые добавились сверху
        requestAnimationFrame(() => {
          const el2 = scrollRef.current
          if (el2) el2.scrollTop += el2.scrollHeight - prevHeight
        })
      })
    }
  }

  const scrollToBottom = () => {
    setNewBelow(false)
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  // Перейти к сообщению: загрузить окно контекста, показать его, подсветить и доскроллить
  const jumpTo = useCallback(
    async (messageId: string) => {
      setSearchOpen(false)
      try {
        const ctx = await api<{ messages: ChatMessage[] }>(`/api/v1/messages/context?around=${messageId}`, {}, 'project')
        setContextView({ messages: ctx.messages })
        setHighlightId(messageId)
        requestAnimationFrame(() => {
          const el = document.getElementById(`msg-${messageId}`)
          el?.scrollIntoView({ behavior: 'auto', block: 'center' })
        })
        // подсветка гаснет через 2.5с
        setTimeout(() => setHighlightId(null), 2500)
      } catch {
        toast.error(t('chat.jumpFailed'))
      }
    },
    [t],
  )

  // дип-линк ?msg=<id> (из файл-менеджера) → прыжок к сообщению
  useEffect(() => {
    const msg = searchParams.get('msg')
    if (msg) {
      jumpTo(msg)
      searchParams.delete('msg')
      setSearchParams(searchParams, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get('msg')])

  const exitContext = () => {
    setContextView(null)
    setHighlightId(null)
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView())
  }

  const send = async (
    { markdown, mentionIds, attachmentIds, taskRefs, raw }: { markdown: string; mentionIds: string[]; attachmentIds: string[]; taskRefs?: string[]; raw?: boolean },
    sendMode: ChatMode = 'group',
  ) => {
    try {
      if (sendMode === 'group' && !raw) setMyPending(true) // «проверяется…» до вердикта
      const created = await api<ChatMessage & { redirectedToAi?: boolean }>(
        '/api/v1/messages',
        { method: 'POST', body: JSON.stringify({ text: markdown, mode: sendMode, attachmentIds, taskRefs: taskRefs ?? [], raw: Boolean(raw) }) },
        'project',
      )
      if (created.status === 'delivered') {
        setLive((prev) => (prev.some((x) => x.id === created.id) ? prev : [...prev, created]))
        setMyPending(false)
      }
      // @AI в группе → тот же оверлей, что и перехват: беседа с ИИ поверх чата
      if (created.redirectedToAi) setAiOpen(true)
      if (sendMode === 'ai' || created.redirectedToAi) setAiThinking(true)
      void mentionIds.includes(AI_MENTION_ID)
    } catch (e) {
      setMyPending(false)
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  const deleteMessage = useMutation({
    mutationFn: (id: string) => api(`/api/v1/messages/${id}/remove`, { method: 'POST' }, 'project'),
    onSuccess: (_r, id) => setLive((prev) => prev.filter((m) => m.id !== id)),
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const mentionItems = useMemo(
    () =>
      (members.data ?? []).map((m) => ({
        id: m.user.id,
        label: m.user.name || m.user.email,
        avatarUrl: m.user.avatarUrl,
      })),
    [members.data],
  )

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-1">
          {/* На мобильном — выход к списку проектов; на десктопе список виден
              всегда, поэтому кнопки нет. Логотип живёт в сайдбаре, здесь он
              был третьим по счёту. */}
          {onOpenSidebar && (
            <button
              onClick={onOpenSidebar}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
              title={t('sidebar.projects')}
            >
              <Menu className="size-4" />
            </button>
          )}
          <ProjectSwitcher projectName={projectName} />
        </div>
        <div className="flex items-center gap-3">
          {/* ниже xl чат занимает весь экран — нужен явный выход в рабочую зону */}
          {onOpenWork && (
            <button
              onClick={onOpenWork}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground xl:hidden"
              title={t('project.mobile.work')}
            >
              <PanelsTopLeft className="size-4" />
            </button>
          )}
          {/* Presence: кто онлайн — аватарки с тултипом */}
          <div className="flex items-center -space-x-1.5" title={online.map((u) => u.name).join(', ')}>
            {online.slice(0, 5).map((u) => (
              <span key={u.id} title={u.name} className="relative inline-block">
                {u.avatarUrl ? (
                  <img src={u.avatarUrl} alt={u.name} className="size-6 rounded-full ring-2 ring-background" referrerPolicy="no-referrer" />
                ) : (
                  <span className="grid size-6 place-items-center rounded-full bg-secondary text-[10px] font-semibold ring-2 ring-background">
                    {u.name[0]?.toUpperCase()}
                  </span>
                )}
                <span className="absolute -bottom-px -end-px size-2 rounded-full bg-brand ring-2 ring-background" />
              </span>
            ))}
            {online.length > 5 && (
              <span className="grid size-6 place-items-center rounded-full bg-secondary text-[10px] ring-2 ring-background">
                +{online.length - 5}
              </span>
            )}
            {!connected && online.length === 0 && (
              <span className="text-[10px] text-muted-foreground">{t('chat.connecting')}</span>
            )}
          </div>

          <Button variant="ghost" size="icon" title={t('chatSearch.title')} onClick={() => setSearchOpen(true)}>
            <Search className="size-4" />
          </Button>

          <div className="flex rounded-md border p-0.5">
            <ModeButton active={!aiOpen} onClick={() => setAiOpen(false)} icon={<Users className="size-3.5" />} label={t('chat.modeGroup')} />
            <ModeButton active={aiOpen} onClick={() => setAiOpen(true)} icon={<Bot className="size-3.5" />} label={t('chat.modeAi')} />
          </div>
        </div>
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="relative flex-1 overflow-y-auto p-4">
        {llmMissing ? (
          <div className="mx-auto mt-8 max-w-xs rounded-xl border bg-card p-5 text-center">
            <span className="mx-auto grid size-12 place-items-center rounded-full bg-secondary">
              <BrainCircuit className="size-6 text-muted-foreground" />
            </span>
            <h3 className="mt-3 text-sm font-semibold">{t('chat.noLlmTitle')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t('chat.noLlmText')}</p>
            <Button variant="brand" size="sm" className="mt-4" onClick={() => navigate(`/start/${llm.data!.companyId}/settings`)}>
              <Settings className="size-3.5" />
              {t('chat.noLlmCta')}
            </Button>
          </div>
        ) : (
          <div>
            {/* Баннер режима истории */}
            {contextView && (
              <div className="sticky top-0 z-10 mb-2 flex items-center justify-between rounded-md border bg-card/95 px-3 py-1.5 text-xs backdrop-blur">
                <span className="text-muted-foreground">{t('chat.inHistory')}</span>
                <Button variant="ghost" size="sm" onClick={exitContext}>
                  <ArrowDown className="size-3.5" />
                  {t('chat.backToLatest')}
                </Button>
              </div>
            )}
            {!contextView && history.isFetchingNextPage && (
              <p className="flex justify-center py-2">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </p>
            )}
            {feed.length === 0 && !history.isLoading && (
              <p className="pt-6 text-center text-sm text-muted-foreground">{t('chat.groupHint')}</p>
            )}
            {feed.map((m, i) => {
              const prev = feed[i - 1]
              const sameDay = prev && isSameDay(new Date(prev.createdAt), new Date(m.createdAt))
              // компактим только того же автора в пределах 5 минут и одного дня
              const compact =
                Boolean(prev) &&
                Boolean(sameDay) &&
                prev!.author?.id === m.author?.id &&
                Boolean(m.author) &&
                new Date(m.createdAt).getTime() - new Date(prev!.createdAt).getTime() < 5 * 60 * 1000
              return (
                <div key={m.id} id={`msg-${m.id}`} className={cn('rounded-md transition-colors', highlightId === m.id && 'bg-brand/15')}>
                  {!sameDay && <DayDivider date={new Date(m.createdAt)} lang={i18n.language} />}
                  <MessageRow
                    message={m}
                    compact={compact}
                    lang={i18n.language}
                    canDelete={myRole === 'owner' || myRole === 'admin' || (Boolean(m.author) && m.author?.id === meId)}
                    onDelete={() => deleteMessage.mutate(m.id)}
                    picked={picked.includes(m.id)}
                    picking={picked.length > 0}
                    onPick={() =>
                      setPicked((cur) => (cur.includes(m.id) ? cur.filter((x) => x !== m.id) : [...cur, m.id]))
                    }
                  />
                </div>
              )
            })}
            {/* Индикаторы пайплайна */}
            {myPending && (
              <p className="mt-2 flex items-center gap-2 px-2 text-xs text-muted-foreground">
                <span className="size-2 animate-pulse rounded-full bg-brand" />
                {t('chat.verifying')}
              </p>
            )}
            {checkingUsers.size > 0 && (
              <p className="mt-2 px-2 text-xs italic text-muted-foreground">
                {t('chat.typing', { names: [...checkingUsers.values()].join(', '), count: checkingUsers.size })}
              </p>
            )}
            <div ref={bottomRef} />
          </div>
        )}

        {/* Кнопка «вниз» при новых сообщениях / когда не у низа */}
        {!llmMissing && !atBottom && (
          <button
            onClick={scrollToBottom}
            className="sticky bottom-2 float-end me-1 flex items-center gap-1 rounded-full border bg-card px-2.5 py-1.5 text-xs shadow-md hover:bg-accent"
          >
            <ArrowDown className="size-3.5" />
            {newBelow && <span className="size-2 rounded-full bg-brand" />}
          </button>
        )}
      </div>

      {/* Поиск по чату */}
      {searchOpen && projectId && <ChatSearch projectId={projectId} lang={i18n.language} onJump={jumpTo} onClose={() => setSearchOpen(false)} />}

      {/* Личный ИИ-канал — оверлей поверх чата (тот же паттерн, что sandbox) */}
      {aiOpen && !sandboxId && (
        <AiOverlay
          messages={aiMessages}
          thinking={aiThinking}
          onSend={(text) => send({ markdown: text, mentionIds: [], attachmentIds: [] }, 'ai')}
          onCleared={() => {
            setLive((prev) => prev.filter((m) => m.mode !== 'ai'))
            qc.invalidateQueries({ queryKey: ['messages', projectId] })
          }}
          onClose={() => setAiOpen(false)}
        />
      )}

      {/* Sandbox поверх чата (SPEC §5.5.3) */}
      {sandboxId && (
        <SandboxOverlay
          messageId={sandboxId}
          aiMode={aiMode}
          streamingText={sandboxStream}
          onStreamReset={() => setSandboxStream('')}
          onSent={() => {
            setSandboxId(null)
            setSandboxStream('')
            qc.invalidateQueries({ queryKey: ['messages', projectId] })
          }}
          onDiscard={() => {
            setSandboxId(null)
            setSandboxStream('')
            qc.invalidateQueries({ queryKey: ['messages', projectId] })
          }}
        />
      )}

      {picked.length > 0 && (
        <div className="flex items-center justify-between gap-2 border-t bg-brand/5 px-3 py-2">
          <span className="text-xs text-muted-foreground">{t('journal.picked', { count: picked.length })}</span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setPicked([])}
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={() => setNoteDraft(picked)}
              className="inline-flex items-center gap-1.5 rounded bg-brand px-2.5 py-1 text-xs text-white"
            >
              <NotebookPen className="size-3.5" />
              {t('journal.saveFromChat')}
            </button>
          </div>
        </div>
      )}

      {noteDraft && (
        <SaveToNoteDialog
          projectId={projectId!}
          messageIds={noteDraft}
          onClose={() => setNoteDraft(null)}
          onSaved={() => {
            setNoteDraft(null)
            setPicked([])
            toast.success(t('journal.savedFromChat'))
            qc.invalidateQueries({ queryKey: ['notes', projectId] })
          }}
        />
      )}

      <footer className="border-t p-3">
        <Composer
          disabled={llmMissing}
          placeholder={llmMissing ? t('chat.noLlmPlaceholder') : t('chat.placeholderGroup')}
          mentions={mentionItems}
          onSend={(p) => send(p, 'group')}
        />
      </footer>
    </div>
  )
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function DayDivider({ date, lang }: { date: Date; lang: string }) {
  const { t } = useTranslation()
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const label = isSameDay(date, now)
    ? t('chat.today')
    : isSameDay(date, yesterday)
      ? t('chat.yesterday')
      : date.toLocaleDateString(lang, { day: 'numeric', month: 'long', ...(date.getFullYear() !== now.getFullYear() && { year: 'numeric' }) })

  return (
    <div className="my-4 flex items-center gap-3">
      <span className="h-px flex-1 bg-border" />
      <span className="rounded-full border px-2.5 py-0.5 text-[11px] text-muted-foreground">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

function MessageRow({
  message,
  compact,
  lang,
  canDelete,
  onDelete,
  picked,
  picking,
  onPick,
}: {
  message: ChatMessage
  compact: boolean
  lang: string
  canDelete: boolean
  onDelete: () => void
  picked: boolean
  picking: boolean
  onPick: () => void
}) {
  const { t } = useTranslation()
  const isAi = !message.author
  const time = new Date(message.createdAt).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })

  return (
    <div
      className={cn(
        'group relative flex gap-2.5 rounded-md px-2 py-1 transition-colors hover:bg-accent/40',
        compact ? 'mt-px' : 'mt-2.5',
        picked && 'bg-brand/10 ring-1 ring-brand/40',
        picking && !picked && 'opacity-60',
      )}
    >
      <div className="absolute end-1 top-1 flex items-center gap-0.5">
        {/* opacity, а не hidden: показ/скрытие не должно двигать разметку */}
        <button
          onClick={onPick}
          title={t('journal.saveFromChat')}
          className={cn(
            'rounded p-1 transition-opacity focus-visible:opacity-100',
            picked
              ? 'text-brand opacity-100'
              : 'text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100',
          )}
        >
          <NotebookPen className="size-3.5" />
        </button>
        {canDelete && (
          <button
            onClick={onDelete}
            title={t('chat.deleteMessage')}
            className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
      <span className="w-7 shrink-0 select-none">
        {compact ? (
          <span className="block text-[10px] leading-6 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">{time}</span>
        ) : isAi ? (
          <span className="grid size-7 place-items-center rounded-full bg-brand text-brand-foreground">
            <Bot className="size-4" />
          </span>
        ) : message.author!.avatarUrl ? (
          <img src={message.author!.avatarUrl} alt="" className="size-7 rounded-full" referrerPolicy="no-referrer" />
        ) : (
          <span className="grid size-7 place-items-center rounded-full bg-secondary text-xs font-semibold">
            {message.author!.name[0]?.toUpperCase()}
          </span>
        )}
      </span>
      <div className="min-w-0 flex-1">
        {!compact && (
          <p className="mb-0.5 flex items-baseline gap-2">
            <span className={cn('text-xs font-semibold', isAi && 'text-brand')}>{isAi ? 'AI' : message.author!.name}</span>
            <span className="text-[10px] text-muted-foreground">{time}</span>
            {message.rawSend && (
              <span className="rounded-full bg-orange-400/15 px-1.5 py-0.5 text-[10px] text-orange-400">
                ⚠ {t('chat.rawBadge')}
              </span>
            )}
            {/* системное автосообщение о задаче (SPEC §8.23) */}
            {message.systemEvent && (
              <span
                className={cn(
                  // на лаймовой подложке текст тёмный: светлый лайм на светлом фоне нечитаем
                  'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                  message.systemEvent === 'task_done'
                    ? 'bg-brand text-brand-foreground'
                    : 'bg-sky-500 text-white',
                )}
              >
                {message.systemEvent === 'task_done' ? <CheckSquare className="size-3" /> : <UserPlus className="size-3" />}
                {t(`chat.systemEvent.${message.systemEvent}`)}
              </span>
            )}
          </p>
        )}
        {!(message.text === '📎' && (message.attachments?.length ?? 0) > 0) && (
          <div className="msg-md break-words text-sm">
            <ReactMarkdown>{renderMentions(message.text)}</ReactMarkdown>
          </div>
        )}
        {(message.attachments?.length ?? 0) > 0 && <MessageAttachments attachments={message.attachments!} />}
        {(message.taskPins?.length ?? 0) > 0 && <MessageTaskPins pins={message.taskPins!} />}
      </div>
    </div>
  )
}

// Прикреплённые задачи-пины — карточки-ссылки на задачу
function MessageTaskPins({ pins }: { pins: NonNullable<ChatMessage['taskPins']> }) {
  const navigate = useNavigate()
  const { id: projectId } = useParams()
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {pins.map((p) => (
        <button
          key={p.id}
          onClick={() => navigate(`/p/${projectId}/tasks/${p.id}`)}
          className="inline-flex max-w-64 items-center gap-1.5 rounded-md border border-brand/40 bg-accent px-2 py-1 text-xs transition-colors hover:bg-accent/70"
          title={p.title}
        >
          <CheckSquare className="size-3.5 shrink-0 text-brand" />
          <span className="truncate">
            <span className="font-medium">{p.number}</span> {p.title}
          </span>
        </button>
      ))}
    </div>
  )
}

function MessageAttachments({ attachments }: { attachments: NonNullable<ChatMessage['attachments']> }) {
  const { t } = useTranslation()
  const live = attachments.filter((a) => !a.deleted)
  const deleted = attachments.filter((a) => a.deleted)
  const images = live.filter((a) => a.mime.startsWith('image/'))
  const others = live.filter((a) => !a.mime.startsWith('image/'))
  const [viewing, setViewing] = useState<ViewerFile | null>(null)

  // inline-превью картинок (через прокси-URL)
  const previews = useQuery({
    queryKey: ['msg-previews', images.map((a) => a.id).join(',')],
    enabled: images.length > 0,
    staleTime: 50 * 60 * 1000,
    queryFn: async () => {
      const entries = await Promise.all(
        images.map(async (a) => {
          const { url } = await api<{ url: string }>(`/api/v1/files/${a.id}/view-url`, {}, 'project')
          return [a.id, url] as const
        }),
      )
      return Object.fromEntries(entries) as Record<string, string>
    },
  })

  return (
    <div className="mt-1.5 space-y-1.5">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {images.map((a) => (
            <button
              key={a.id}
              onClick={() => setViewing(a)}
              title={a.name}
              className="block max-h-52 max-w-64 overflow-hidden rounded-lg border transition-opacity hover:opacity-90"
            >
              {previews.data?.[a.id] ? (
                <img src={previews.data[a.id]} alt={a.name} className="max-h-52 max-w-64 object-cover" loading="lazy" />
              ) : (
                <span className="grid h-24 w-32 place-items-center bg-secondary text-xs text-muted-foreground">…</span>
              )}
            </button>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {others.map((a) => (
            <button
              key={a.id}
              onClick={() => setViewing(a)}
              className="inline-flex max-w-56 items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs transition-colors hover:bg-accent"
              title={a.name}
            >
              📎 <span className="truncate">{a.name}</span>
            </button>
          ))}
        </div>
      )}
      {deleted.map((a) => (
        <span key={a.id} className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground">
          🚫 {t('chat.fileDeleted')}
        </span>
      ))}
      {viewing && <FileViewer file={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

type Summary = { id: string; name: string; content: string; fromAt: string; toAt: string; messageCount: number }

// Поиск по чату — текст сообщений + История (дневные саммари между датами) — SPEC §8.4/§8.5
function ChatSearch({ projectId, lang, onJump, onClose }: { projectId: string; lang: string; onJump: (id: string) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'messages' | 'history'>('messages')
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q), 300)
    return () => clearTimeout(id)
  }, [q])

  const dateQs = [from ? `from=${from}` : '', to ? `to=${to}` : ''].filter(Boolean).join('&')

  const hasCriteria = debounced.trim().length > 0 || Boolean(from) || Boolean(to)
  const results = useQuery({
    queryKey: ['chat-search', projectId, debounced, from, to],
    enabled: tab === 'messages' && hasCriteria,
    queryFn: () =>
      api<ChatMessage[]>(`/api/v1/messages/search?q=${encodeURIComponent(debounced)}${dateQs ? '&' + dateQs : ''}`, {}, 'project'),
  })

  // История загружается всегда (по датам/тексту), т.к. это самостоятельный режим просмотра
  const history = useQuery({
    queryKey: ['chat-history', projectId, debounced, from, to],
    enabled: tab === 'history',
    queryFn: () =>
      api<Summary[]>(`/api/v1/messages/history?q=${encodeURIComponent(debounced)}${dateQs ? '&' + dateQs : ''}`, {}, 'project'),
  })

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-background/98 backdrop-blur-sm">
      <header className="space-y-2 border-b p-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={tab === 'messages' ? t('chatSearch.placeholder') : t('chatSearch.historyPlaceholder')}
              className="h-9 w-full rounded-md border bg-transparent ps-9 pe-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md border text-xs">
            <button
              onClick={() => setTab('messages')}
              className={cn('px-3 py-1.5 transition-colors', tab === 'messages' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary')}
            >
              {t('chatSearch.tabMessages')}
            </button>
            <button
              onClick={() => setTab('history')}
              className={cn('px-3 py-1.5 transition-colors', tab === 'history' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary')}
            >
              {t('chatSearch.tabHistory')}
            </button>
          </div>
          <DatePicker value={from} onChange={setFrom} className="w-36" />
          <span className="text-xs text-muted-foreground">–</span>
          <DatePicker value={to} onChange={setTo} className="w-36" />
        </div>
      </header>

      {tab === 'messages' ? (
        <div className="flex-1 space-y-1 overflow-y-auto p-3">
          {results.isFetching && <p className="py-4 text-center text-sm text-muted-foreground">…</p>}
          {results.data?.map((m) => (
            <button
              key={m.id}
              onClick={() => onJump(m.id)}
              className="block w-full rounded-lg border bg-card px-3 py-2 text-start transition-colors hover:bg-accent"
            >
              <p className="mb-0.5 flex items-baseline gap-2 text-xs">
                <span className="font-semibold">{m.author?.name ?? 'AI'}</span>
                <span className="text-muted-foreground">{new Date(m.createdAt).toLocaleString(lang)}</span>
              </p>
              <div className="msg-md line-clamp-3 break-words text-sm">
                <ReactMarkdown>{renderMentions(m.text)}</ReactMarkdown>
              </div>
              {(m.attachments?.length ?? 0) > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">📎 {m.attachments!.map((a) => a.name).join(', ')}</p>
              )}
            </button>
          ))}
          {results.data && results.data.length === 0 && hasCriteria && (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('start.nothingFound')}</p>
          )}
          {!hasCriteria && <p className="py-6 text-center text-sm text-muted-foreground">{t('chatSearch.hint')}</p>}
        </div>
      ) : (
        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {history.isFetching && <p className="py-4 text-center text-sm text-muted-foreground">…</p>}
          {history.data?.map((s) => (
            <div key={s.id} className="rounded-lg border bg-card px-3 py-2.5">
              <p className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold">{s.name}</span>
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  {new Date(s.fromAt).toLocaleDateString(lang)}
                  {new Date(s.fromAt).toDateString() !== new Date(s.toAt).toDateString() && ` – ${new Date(s.toAt).toLocaleDateString(lang)}`}
                </span>
              </p>
              <div className="msg-md whitespace-pre-wrap break-words text-sm text-muted-foreground">{s.content}</div>
              <p className="mt-1.5 text-xs text-muted-foreground">{t('chatSearch.msgCount', { count: s.messageCount })}</p>
            </div>
          ))}
          {history.data && history.data.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('chatSearch.historyEmpty')}</p>
          )}
        </div>
      )}
    </div>
  )
}

function ModeButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors',
        active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

/**
 * Сохранение выбранных сообщений в заметку (SPEC §8.31). Сервер сам копирует
 * текст и автора каждой реплики — доказательство должно пережить удаление.
 */
function SaveToNoteDialog({
  projectId,
  messageIds,
  onClose,
  onSaved,
}: {
  projectId: string
  messageIds: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const [type, setType] = useState<NoteType>('contradiction')
  const [title, setTitle] = useState('')
  const [tags, setTags] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api(
        '/api/v1/notes',
        {
          method: 'POST',
          body: JSON.stringify({
            type,
            title,
            tags: tags.split(',').map((x) => x.trim()).filter(Boolean),
            sourceMessageIds: messageIds,
          }),
        },
        'project',
      ),
    onSuccess: onSaved,
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  return (
    <div className="absolute inset-0 z-30 flex items-end justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md space-y-3 rounded-lg border bg-card p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm font-semibold">{t('journal.saveFromChat')}</p>
        <p className="text-xs text-muted-foreground">{t('journal.picked', { count: messageIds.length })}</p>

        <div className="flex flex-wrap gap-1.5">
          {NOTE_TYPES.map((tp) => {
            const { icon: Icon, className } = NOTE_META[tp]
            return (
              <button
                key={tp}
                onClick={() => setType(tp)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                  type === tp ? 'border-brand bg-brand/10 text-foreground' : 'text-muted-foreground hover:bg-accent',
                )}
              >
                <Icon className={cn('size-3.5', type === tp ? className : '')} />
                {t(`journal.type.${tp}`)}
              </button>
            )
          })}
        </div>

        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('journal.titlePlaceholder')}
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          autoFocus
        />
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder={t('journal.tags')}
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
        />

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent">
            {t('common.cancel')}
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="rounded bg-brand px-3 py-1.5 text-sm text-white disabled:opacity-60"
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
