import { useState } from 'react'
import { cn } from '@/lib/utils'
import { ChatPanel } from '@/components/chat/ChatPanel'

// Главный экран: чат 40% | табы проекта 60% (см. CONCEPT.md §3)
const TABS = ['О проекте', 'Задачи', 'Файлы', 'Кредишены'] as const
type Tab = (typeof TABS)[number]

export function ProjectScreen() {
  const [tab, setTab] = useState<Tab>('Задачи')

  return (
    <div className="flex h-dvh">
      {/* Чат — 40% */}
      <div className="flex w-[40%] min-w-[320px] flex-col border-r">
        <ChatPanel />
      </div>

      {/* Табы проекта — 60% */}
      <div className="flex flex-1 flex-col">
        <nav className="flex gap-1 border-b px-4 py-2">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm transition-colors',
                tab === t
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              {t}
            </button>
          ))}
        </nav>
        <main className="flex flex-1 items-center justify-center text-muted-foreground">
          <p className="text-sm">Таб «{tab}» — контент появится по мере разработки</p>
        </main>
      </div>
    </div>
  )
}
