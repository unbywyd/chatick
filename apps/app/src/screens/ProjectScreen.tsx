import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LanguageSelect } from '@/components/LanguageSelect'

// Главный экран: чат 40% | табы проекта 60% (см. CONCEPT.md §3)
const TAB_KEYS = ['about', 'tasks', 'files', 'credentials'] as const
type TabKey = (typeof TAB_KEYS)[number]

export function ProjectScreen() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<TabKey>('tasks')

  return (
    <div className="flex h-dvh">
      {/* Чат — 40% */}
      <div className="flex w-[40%] min-w-[320px] flex-col border-e">
        <ChatPanel />
      </div>

      {/* Табы проекта — 60% */}
      <div className="flex flex-1 flex-col">
        <nav className="flex items-center gap-1 border-b px-4 py-2">
          {TAB_KEYS.map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm transition-colors',
                tab === key
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              {t(`tabs.${key}`)}
            </button>
          ))}
          <div className="ms-auto flex items-center gap-2">
            <LanguageSelect />
            <ThemeToggle />
          </div>
        </nav>
        <main className="flex flex-1 items-center justify-center text-muted-foreground">
          <p className="text-sm">{t('tabs.placeholder', { tab: t(`tabs.${tab}`) })}</p>
        </main>
      </div>
    </div>
  )
}
