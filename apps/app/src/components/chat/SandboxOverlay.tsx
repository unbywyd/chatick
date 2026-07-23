import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { toast } from 'sonner'
import { Bot, Check, Eye, EyeOff, FileText, Image as ImageIcon, Loader2, SendHorizontal, Trash2, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm'
import type { MessageAttachment } from '@/hooks/useProjectSocket'

type SandboxItem = {
  id: string
  role: 'user' | 'ai'
  text: string
  suggestion: boolean
  approved: boolean
  createdAt: string
}
type SandboxData = {
  original: { id: string; text: string; attachments: MessageAttachment[] }
  items: SandboxItem[]
}

// Sandbox (SPEC §5.5.3): приватный оверлей автора с ИИ вокруг held-сообщения.
// «Посмотреть чат» — временно прячет оверлей; выбранный вариант уходит в чат с вложениями.
export function SandboxOverlay({
  messageId,
  aiMode,
  onSent,
  onDiscard,
}: {
  messageId: string
  aiMode: 'observer' | 'assistant' | 'moderator'
  onSent: () => void
  onDiscard: () => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [peek, setPeek] = useState(false)
  const [draft, setDraft] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  const sandbox = useQuery({
    queryKey: ['sandbox', messageId],
    queryFn: () => api<SandboxData>(`/api/v1/messages/${messageId}/sandbox`, {}, 'project'),
  })

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [sandbox.data?.items.length])

  const reply = useMutation({
    mutationFn: (text: string) =>
      api<SandboxItem[]>(`/api/v1/messages/${messageId}/sandbox`, { method: 'POST', body: JSON.stringify({ text }) }, 'project'),
    onSuccess: () => {
      setDraft('')
      qc.invalidateQueries({ queryKey: ['sandbox', messageId] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const finalize = useMutation({
    mutationFn: (sandboxItemId?: string) =>
      api(`/api/v1/messages/${messageId}/finalize`, { method: 'POST', body: JSON.stringify({ sandboxItemId }) }, 'project'),
    onSuccess: onSent,
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const discard = useMutation({
    mutationFn: () => api(`/api/v1/messages/${messageId}`, { method: 'DELETE' }, 'project'),
    onSuccess: onDiscard,
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const original = sandbox.data?.original

  return (
    <div
      className={cn(
        'absolute inset-0 z-30 flex flex-col bg-background/97 backdrop-blur-sm transition-transform duration-200',
        peek && 'translate-y-[calc(100%-3rem)]',
      )}
    >
      {/* Header */}
      <header className="flex items-center gap-2 border-b bg-card px-4 py-2.5">
        <span className="grid size-7 place-items-center rounded-full bg-brand text-brand-foreground">
          <Bot className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{t('sandbox.title')}</p>
          {!peek && <p className="truncate text-xs text-muted-foreground">{t('sandbox.subtitle')}</p>}
        </div>
        <Button variant="outline" size="sm" onClick={() => setPeek((v) => !v)}>
          {peek ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          {peek ? t('sandbox.back') : t('sandbox.peek')}
        </Button>
        <Button
          variant="destructive"
          size="icon"
          title={t('sandbox.discard')}
          onClick={async () => {
            if (await confirm({ title: t('sandbox.discardConfirm'), destructive: true, confirmLabel: t('sandbox.discard') }))
              discard.mutate()
          }}
        >
          <Trash2 className="size-4" />
        </Button>
      </header>

      {!peek && (
        <>
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {/* Исходное сообщение + вложения */}
            {original && (
              <div className="rounded-lg border border-dashed bg-card p-3">
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t('sandbox.original')}
                </p>
                <div className="msg-md text-sm">
                  <ReactMarkdown>{original.text}</ReactMarkdown>
                </div>
                {original.attachments.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {original.attachments.map((a) => (
                      <span key={a.id} className="inline-flex items-center gap-1 rounded-full border bg-secondary px-2 py-0.5 text-xs">
                        {a.mime.startsWith('image/') ? <ImageIcon className="size-3" /> : <FileText className="size-3" />}
                        <span className="max-w-32 truncate">{a.name}</span>
                      </span>
                    ))}
                  </div>
                )}
                {aiMode !== 'moderator' && (
                  <Button variant="outline" size="sm" className="mt-2" onClick={() => finalize.mutate(undefined)} disabled={finalize.isPending}>
                    {t('sandbox.sendAsIs')}
                  </Button>
                )}
              </div>
            )}

            {/* Диалог */}
            {sandbox.data?.items.map((item) =>
              item.suggestion ? (
                <div key={item.id} className={cn('rounded-lg border p-3', item.approved ? 'border-brand bg-accent/60' : 'bg-card')}>
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <p className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {item.approved && <Check className="size-3 text-brand" />}
                      {item.approved ? t('sandbox.approvedSuggestion') : t('sandbox.suggestion')}
                    </p>
                    {(item.approved || aiMode !== 'moderator') && (
                      <Button variant="brand" size="sm" onClick={() => finalize.mutate(item.id)} disabled={finalize.isPending}>
                        <Check className="size-3.5" />
                        {t('sandbox.choose')}
                      </Button>
                    )}
                  </div>
                  <div className="msg-md text-sm">
                    <ReactMarkdown>{item.text}</ReactMarkdown>
                  </div>
                </div>
              ) : (
                <div key={item.id} className={cn('flex gap-2.5', item.role === 'user' && 'flex-row-reverse')}>
                  {item.role === 'ai' && (
                    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand text-brand-foreground">
                      <Bot className="size-4" />
                    </span>
                  )}
                  <div
                    className={cn(
                      'msg-md max-w-[85%] rounded-lg px-3 py-2 text-sm',
                      item.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-card border',
                    )}
                  >
                    <ReactMarkdown>{item.text}</ReactMarkdown>
                  </div>
                </div>
              ),
            )}
            {(reply.isPending || sandbox.isLoading) && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin text-brand" />
                {t('sandbox.aiThinking')}
              </p>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Ввод в sandbox */}
          <footer className="border-t p-3">
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (draft.trim() && !reply.isPending) reply.mutate(draft.trim())
              }}
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t('sandbox.placeholder')}
                className="h-9 flex-1 rounded-md border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
              />
              <button
                type="submit"
                disabled={!draft.trim() || reply.isPending}
                className="rounded-md bg-brand p-2 text-brand-foreground disabled:opacity-40"
              >
                <SendHorizontal className="size-4 rtl:-scale-x-100" />
              </button>
            </form>
          </footer>
        </>
      )}
    </div>
  )
}
