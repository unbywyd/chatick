import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { Bot } from 'lucide-react'
import { cn } from '@/lib/utils'

export type MentionItem = { id: string; label: string; avatarUrl?: string | null; isAi?: boolean }
export type MentionListRef = { onKeyDown: (props: { event: KeyboardEvent }) => boolean }

type Props = {
  items: MentionItem[]
  command: (item: { id: string; label: string }) => void
}

// Саджест @-упоминаний: @AI первым (прямое обращение к диспетчеру), затем участники
export const MentionList = forwardRef<MentionListRef, Props>(function MentionList({ items, command }, ref) {
  const [index, setIndex] = useState(0)

  useEffect(() => setIndex(0), [items])

  const select = (i: number) => {
    const item = items[i]
    if (item) command({ id: item.id, label: item.label })
  }

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowUp') {
        setIndex((i) => (i + items.length - 1) % items.length)
        return true
      }
      if (event.key === 'ArrowDown') {
        setIndex((i) => (i + 1) % items.length)
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        select(index)
        return true
      }
      return false
    },
  }))

  if (items.length === 0) return null

  return (
    <div className="min-w-44 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
      {items.map((item, i) => (
        <button
          key={item.id}
          onClick={() => select(i)}
          className={cn(
            'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
            i === index ? 'bg-accent text-accent-foreground' : '',
          )}
        >
          {item.isAi ? (
            <span className="grid size-6 place-items-center rounded-full bg-brand text-brand-foreground">
              <Bot className="size-3.5" />
            </span>
          ) : item.avatarUrl ? (
            <img src={item.avatarUrl} alt="" className="size-6 rounded-full" referrerPolicy="no-referrer" />
          ) : (
            <span className="grid size-6 place-items-center rounded-full bg-secondary text-[10px] font-semibold">
              {item.label[0]?.toUpperCase()}
            </span>
          )}
          <span className={cn('truncate', item.isAi && 'font-semibold')}>{item.label}</span>
        </button>
      ))}
    </div>
  )
})
