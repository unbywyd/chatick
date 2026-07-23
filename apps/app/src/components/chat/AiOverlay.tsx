import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { toast } from 'sonner'
import { Bot, Eye, EyeOff, Loader2, SendHorizontal, Trash2, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm'
import type { ChatMessage } from '@/hooks/useProjectSocket'

// Личный диалог с ИИ — тот же паттерн, что sandbox: оверлей поверх чата,
// «Посмотреть чат» (peek) и «Закрыть» (беседа сохраняется в ai-канале).
export function AiOverlay({
  messages,
  thinking,
  onSend,
  onCleared,
  onClose,
}: {
  messages: ChatMessage[]
  thinking: boolean
  onSend: (text: string) => void
  onCleared: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [peek, setPeek] = useState(false)
  const [draft, setDraft] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, thinking])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className={cn(
        'absolute inset-0 z-30 flex flex-col bg-background/97 backdrop-blur-sm transition-transform duration-200',
        peek && 'translate-y-[calc(100%-3rem)]',
      )}
    >
      <header className="flex items-center gap-2 border-b bg-card px-4 py-2.5">
        <span className="grid size-7 place-items-center rounded-full bg-brand text-brand-foreground">
          <Bot className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{t('aiChannel.title')}</p>
          {!peek && <p className="truncate text-xs text-muted-foreground">{t('aiChannel.subtitle')}</p>}
        </div>
        <Button variant="outline" size="sm" onClick={() => setPeek((v) => !v)}>
          {peek ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          {peek ? t('sandbox.back') : t('sandbox.peek')}
        </Button>
        <Button
          variant="destructive"
          size="icon"
          title={t('aiChannel.clear')}
          onClick={async () => {
            if (await confirm({ title: t('aiChannel.clearConfirm'), description: t('aiChannel.clearNote'), destructive: true, confirmLabel: t('aiChannel.clear') })) {
              try {
                await api('/api/v1/messages/ai', { method: 'DELETE' }, 'project')
                onCleared()
              } catch (e) {
                toast.error(e instanceof Error ? e.message : String(e))
              }
            }
          }}
        >
          <Trash2 className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" title={t('aiChannel.close')} onClick={onClose}>
          <X className="size-4" />
        </Button>
      </header>

      {!peek && (
        <>
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {messages.length === 0 && !thinking && (
              <p className="pt-6 text-center text-sm text-muted-foreground">{t('chat.aiHint')}</p>
            )}
            {messages.map((m) => {
              const isAi = !m.author
              return (
                <div key={m.id} className={cn('flex gap-2.5', !isAi && 'flex-row-reverse')}>
                  {isAi && (
                    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand text-brand-foreground">
                      <Bot className="size-4" />
                    </span>
                  )}
                  <div
                    className={cn(
                      'msg-md max-w-[85%] rounded-lg px-3 py-2 text-sm',
                      isAi ? 'border bg-card' : 'bg-primary text-primary-foreground',
                    )}
                  >
                    <ReactMarkdown>{m.text}</ReactMarkdown>
                  </div>
                </div>
              )
            })}
            {thinking && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin text-brand" />
                {t('sandbox.aiThinking')}
              </p>
            )}
            <div ref={bottomRef} />
          </div>

          <footer className="border-t p-3">
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (draft.trim() && !thinking) {
                  onSend(draft.trim())
                  setDraft('')
                }
              }}
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t('chat.placeholderAi')}
                className="h-9 flex-1 rounded-md border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
              />
              <button
                type="submit"
                disabled={!draft.trim() || thinking}
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
