import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Пока грузится — скелетон, а не пустой экран.
 *
 * При смене проекта рабочая зона показывала многоточие по центру пустоты, а
 * колонка чата — вовсе ничего. На тёмной теме это читается как погасшее
 * приложение, а не как ожидание.
 *
 * Заметнее всего при медленной базе: локальная разработка ходит в прод-базу
 * за 73 мс, и каждый заход стоит 146 мс туда-обратно.
 */

const app = (f: string) => readFileSync(join(import.meta.dirname, '../../../app/src', f), 'utf8')

describe('заглушки на время загрузки', () => {
  it('рабочая зона показывает скелетон, а не многоточие', () => {
    const screen = app('screens/ProjectScreen.tsx')
    expect(screen).toMatch(/<TaskListSkeleton \/>/)
    expect(screen, 'вернулось многоточие по центру пустоты').not.toMatch(
      /token\.status === 'loading' \?[\s\S]{0,200}?place-items-center/,
    )
  })

  it('чат показывает скелетон, пока едет история', () => {
    const chat = app('components/chat/ChatPanel.tsx')
    expect(chat).toMatch(/history\.isLoading && <ChatSkeleton \/>/)
  })

  it('пустой чат не мигает поверх загрузки', () => {
    // Приглашение «с чего начать» должно ждать ответа: иначе оно вспыхивает
    // и тут же сменяется сообщениями.
    const chat = app('components/chat/ChatPanel.tsx')
    expect(chat).toMatch(/feed\.length === 0 && !history\.isLoading/)
  })

  it('панель моих задач тоже', () => {
    const panel = app('components/chat/MyTasksPanel.tsx')
    expect(panel).toMatch(/q\.isLoading/)
    expect(panel).toMatch(/<Skeleton/)
  })

  it('заглушки скрыты от чтения с экрана', () => {
    // Полосы-пустышки читать вслух нечего: для незрячего это шум.
    const sk = app('components/ui/skeleton.tsx')
    expect((sk.match(/aria-hidden/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})
