import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
// GFM: без него markdown не знает таблиц вовсе — они схлопывались в строку.
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import { Bot, Check, Eye, EyeOff, FileText, Image as ImageIcon, Loader2, SendHorizontal, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
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
  streamingText,
  onStreamReset,
  onSent,
  onDiscard,
}: {
  messageId: string
  aiMode: 'observer' | 'assistant' | 'moderator'
  streamingText?: string // постепенная печать ответа ИИ (ws sandbox_chunk)
  onStreamReset?: () => void
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
    // Сообщения нет — повторять бессмысленно: оно не появится. Без этого опрос
    // бился в 404 бесконечно, а оверлей висел на весь экран и не давал
    // работать.
    retry: false,
  })

  /**
   * Сообщение исчезло — закрываем оверлей сами.
   *
   * Он занимает весь экран, и единственный выход из него — крестик, который
   * удаляет сообщение. Если сообщения уже нет (удалили в другой вкладке,
   * потеряли при сбое), крестик получает 404, обработчик успеха не
   * срабатывает, и человек заперт в окне, из которого нет выхода.
   */
  useEffect(() => {
    if (sandbox.isError) onDiscard()
  }, [sandbox.isError, onDiscard])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [sandbox.data?.items.length, streamingText])

  const reply = useMutation({
    mutationFn: (text: string) =>
      api<SandboxItem[]>(`/api/v1/messages/${messageId}/sandbox`, { method: 'POST', body: JSON.stringify({ text }) }, 'project'),
    onMutate: () => onStreamReset?.(),
    onSuccess: () => {
      setDraft('')
      onStreamReset?.()
      qc.invalidateQueries({ queryKey: ['sandbox', messageId] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const finalize = useMutation({
    mutationFn: (body: { sandboxItemId?: string; force?: boolean }) =>
      api(`/api/v1/messages/${messageId}/finalize`, { method: 'POST', body: JSON.stringify(body) }, 'project'),
    onSuccess: onSent,
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const discard = useMutation({
    mutationFn: () => api(`/api/v1/messages/${messageId}`, { method: 'DELETE' }, 'project'),
    onSuccess: onDiscard,
    onError: (e) => {
      // Закрываем в любом случае. Удалять уже нечего, а держать человека в
      // окне из-за неудачного запроса — худшее, что можно сделать: выйти
      // отсюда больше нечем.
      const notFound = e instanceof ApiError && e.status === 404
      if (!notFound) toast.error(e instanceof Error ? e.message : String(e))
      onDiscard()
    },
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
        {/* Крестик, а не корзина: рядом панель ИИ, где корзина чистит историю
            переписки, и одна иконка на двух соседних экранах читалась как одно
            и то же действие. Здесь она закрывает правку. */}
        <Button
          variant="ghost"
          size="icon"
          title={t('sandbox.discard')}
          onClick={async () => {
            if (await confirm({ title: t('sandbox.discardConfirm'), destructive: true, confirmLabel: t('sandbox.discard') }))
              discard.mutate()
          }}
        >
          <X className="size-4" />
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
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{original.text}</ReactMarkdown>
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
                <div className="mt-2 flex flex-wrap gap-2">
                  {aiMode !== 'moderator' ? (
                    <Button variant="outline" size="sm" onClick={() => finalize.mutate({})} disabled={finalize.isPending}>
                      {t('sandbox.sendAsIs')}
                    </Button>
                  ) : (
                    /* даже в модераторе можно «Послать всё равно» — уйдёт с пометкой «без проверки» */
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-orange-400/40 text-orange-400 hover:bg-orange-400/10"
                      onClick={async () => {
                        if (await confirm({ title: t('sandbox.forceConfirm'), description: t('sandbox.forceNote'), confirmLabel: t('sandbox.forceSend') }))
                          finalize.mutate({ force: true })
                      }}
                      disabled={finalize.isPending}
                    >
                      {t('sandbox.forceSend')}
                    </Button>
                  )}
                </div>
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
                    <Button
                      variant="brand"
                      size="sm"
                      onClick={() => finalize.mutate({ sandboxItemId: item.id, force: !item.approved })}
                      disabled={finalize.isPending}
                    >
                      <Check className="size-3.5" />
                      {t('sandbox.choose')}
                    </Button>
                  </div>
                  <div className="msg-md text-sm">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
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
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
                  </div>
                </div>
              ),
            )}
            {/* Стриминг: постепенная печать ответа ИИ */}
            {reply.isPending && streamingText && (
              <div className="flex gap-2.5">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand text-brand-foreground">
                  <Bot className="size-4" />
                </span>
                <div className="msg-md max-w-[85%] rounded-lg border bg-card px-3 py-2 text-sm">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
                  <span className="inline-block h-3.5 w-1 animate-pulse bg-brand align-text-bottom" />
                </div>
              </div>
            )}
            {(reply.isPending && !streamingText) || sandbox.isLoading ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin text-brand" />
                {t('sandbox.aiThinking')}
              </p>
            ) : null}
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
