import { useState } from 'react'
import { Bot, Users, SendHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'

// Два режима чата (CONCEPT.md): группа (через ИИ-диспетчер) / личный диалог с ИИ
type ChatMode = 'group' | 'ai'

export function ChatPanel() {
  const [mode, setMode] = useState<ChatMode>('group')
  const [draft, setDraft] = useState('')

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <h1 className="text-sm font-semibold">Chatick</h1>
        <div className="flex rounded-md border p-0.5">
          <ModeButton active={mode === 'group'} onClick={() => setMode('group')} icon={<Users className="size-3.5" />} label="Группа" />
          <ModeButton active={mode === 'ai'} onClick={() => setMode('ai')} icon={<Bot className="size-3.5" />} label="ИИ" />
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        <p className="text-center text-sm text-muted-foreground">
          {mode === 'group'
            ? 'Сообщения группы — проходят через ИИ-диспетчер'
            : 'Личный диалог с ИИ проекта'}
        </p>
      </div>

      <footer className="border-t p-3">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            // TODO: optimistic insert + POST /api/v1/messages
            setDraft('')
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={1}
            placeholder={mode === 'group' ? 'Написать в группу…' : 'Спросить ИИ…'}
            className="max-h-40 flex-1 resize-none rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="rounded-md bg-primary p-2 text-primary-foreground disabled:opacity-40"
          >
            <SendHorizontal className="size-4" />
          </button>
        </form>
      </footer>
    </div>
  )
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
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
