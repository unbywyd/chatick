import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
// GFM: без него markdown не знает таблиц вовсе — они схлопывались в строку.
import remarkGfm from 'remark-gfm'
import { Bot, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/hooks/useProjectSocket'
import { MessageAttachments } from './ChatPanel'

/**
 * Лента личного диалога с ИИ. Раньше это был оверлей поверх чата со своей
 * шапкой, полем ввода и кнопкой «закрыть» — четыре органа управления там, где
 * человеку нужен один переключатель. Теперь ИИ и группа — два равноправных
 * чата под общим композером, а здесь остались только сообщения.
 */
export function AiFeed({ messages, thinking }: { messages: ChatMessage[]; thinking: boolean }) {
  const { t } = useTranslation()
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, thinking])

  return (
    <div className="space-y-3">
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
              {/* «📎» без картинки — это скрепка, которую человек сам и
                  отправил: понять по ней ничего нельзя. Показываем вложение. */}
              {m.text && m.text.trim() !== '📎' && (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
              )}
              {m.attachments && m.attachments.length > 0 && (
                <MessageAttachments attachments={m.attachments} canPublish={false} />
              )}
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
  )
}
