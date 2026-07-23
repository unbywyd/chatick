import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, Users, BrainCircuit, Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Logo } from '@/components/Logo'
import { Button } from '@/components/ui/button'
import { useProjectSocket, type ChatMessage } from '@/hooks/useProjectSocket'
import { Composer, AI_MENTION_ID } from './Composer'

type ChatMode = 'group' | 'ai'
type Member = { id: string; role: string; user: { id: string; name: string; email: string; avatarUrl: string | null } }

// mention-разметка @[Label](id) → рендерим как @Label
const mentionRe = /@\[([^\]]+)\]\(([^)]+)\)/g
const renderMentions = (text: string) => text.replace(mentionRe, '**@$1**')

export function ChatPanel({ projectName }: { projectName?: string }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { id: projectId } = useParams()
  const qc = useQueryClient()
  const [mode, setMode] = useState<ChatMode>('group')
  const bottomRef = useRef<HTMLDivElement>(null)

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

  const history = useQuery({
    queryKey: ['messages', projectId],
    queryFn: () => api<ChatMessage[]>('/api/v1/messages', {}, 'project'),
    enabled: Boolean(projectId),
  })

  const [live, setLive] = useState<ChatMessage[]>([])
  useEffect(() => setLive([]), [projectId])

  const onWsMessage = useCallback((m: ChatMessage) => {
    setLive((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]))
  }, [])

  const { online, connected } = useProjectSocket(projectId, onWsMessage)

  // история + live, дедуп по id (свои приходят и по ws после POST)
  const allMessages = useMemo(() => {
    const seen = new Set<string>()
    const list: ChatMessage[] = []
    for (const m of [...(history.data ?? []), ...live]) {
      if (!seen.has(m.id)) {
        seen.add(m.id)
        list.push(m)
      }
    }
    return list.filter((m) => (mode === 'ai' ? m.mode === 'ai' : m.mode === 'group'))
  }, [history.data, live, mode])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [allMessages.length])

  const send = async ({ markdown, mentionIds }: { markdown: string; mentionIds: string[] }) => {
    try {
      const created = await api<ChatMessage>(
        '/api/v1/messages',
        { method: 'POST', body: JSON.stringify({ text: markdown, mode }) },
        'project',
      )
      setLive((prev) => (prev.some((x) => x.id === created.id) ? prev : [...prev, created]))
      // упоминание @AI — прямое обращение к диспетчеру (подключится в следующем слое)
      void mentionIds.includes(AI_MENTION_ID)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

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
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Logo />
          {projectName && <span className="truncate text-xs text-muted-foreground">/ {projectName}</span>}
        </div>
        <div className="flex items-center gap-3">
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

          <div className="flex rounded-md border p-0.5">
            <ModeButton active={mode === 'group'} onClick={() => setMode('group')} icon={<Users className="size-3.5" />} label={t('chat.modeGroup')} />
            <ModeButton active={mode === 'ai'} onClick={() => setMode('ai')} icon={<Bot className="size-3.5" />} label={t('chat.modeAi')} />
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
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
            {allMessages.length === 0 && !history.isLoading && (
              <p className="pt-6 text-center text-sm text-muted-foreground">
                {mode === 'group' ? t('chat.groupHint') : t('chat.aiHint')}
              </p>
            )}
            {allMessages.map((m, i) => {
              const prev = allMessages[i - 1]
              const sameDay = prev && isSameDay(new Date(prev.createdAt), new Date(m.createdAt))
              // компактим только того же автора в пределах 5 минут и одного дня
              const compact =
                Boolean(prev) &&
                Boolean(sameDay) &&
                prev!.author?.id === m.author?.id &&
                Boolean(m.author) &&
                new Date(m.createdAt).getTime() - new Date(prev!.createdAt).getTime() < 5 * 60 * 1000
              return (
                <div key={m.id}>
                  {!sameDay && <DayDivider date={new Date(m.createdAt)} lang={i18n.language} />}
                  <MessageRow message={m} compact={compact} lang={i18n.language} />
                </div>
              )
            })}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <footer className="border-t p-3">
        <Composer
          disabled={llmMissing}
          placeholder={llmMissing ? t('chat.noLlmPlaceholder') : mode === 'group' ? t('chat.placeholderGroup') : t('chat.placeholderAi')}
          mentions={mentionItems}
          onSend={send}
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

function MessageRow({ message, compact, lang }: { message: ChatMessage; compact: boolean; lang: string }) {
  const isAi = !message.author
  const time = new Date(message.createdAt).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })

  return (
    <div
      className={cn(
        'group flex gap-2.5 rounded-md px-2 py-1 transition-colors hover:bg-accent/40',
        compact ? 'mt-px' : 'mt-2.5',
      )}
    >
      <span className="w-7 shrink-0 select-none">
        {compact ? (
          <span className="hidden text-[10px] leading-6 text-muted-foreground group-hover:block">{time}</span>
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
          </p>
        )}
        <div className="msg-md break-words text-sm">
          <ReactMarkdown>{renderMentions(message.text)}</ReactMarkdown>
        </div>
      </div>
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
