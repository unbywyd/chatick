import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Обвязка страниц проекта: ширина контейнера и кнопка «назад».
 *
 * Страницы вне полосы вкладок — горячие клавиши, ИИ, уведомления, команда —
 * попадаются из меню профиля. Ни одна вкладка при этом не подсвечена, а
 * стрелка «назад» пряталась на широком экране как ненужная рядом с чатом:
 * выхода со страницы не оставалось вовсе.
 *
 * И вторая беда: стрелка всегда вела в чат, куда бы человек ни шёл. Пришёл из
 * команды проекта — возвращали в чат.
 */

const app = (f: string) => readFileSync(join(import.meta.dirname, '../../../app/src', f), 'utf8')
const screen = app('screens/ProjectScreen.tsx')

const PAGES = ['ShortcutsTab', 'AiUsageTab', 'NotificationsTab', 'ProjectTeamTab'] as const

describe('страницы проекта: одна ширина', () => {
  it('все используют общий контейнер, а не свой max-w', () => {
    // page-w — это 1400px в одном месте (index.css). Свой max-w на странице
    // означает, что она одна поедет, когда общую ширину поменяют.
    for (const name of PAGES) {
      const src = app(`components/tabs/${name}.tsx`)
      const root = src.match(/return \(\s*\n\s*<div className="([^"]+)"/)?.[1] ?? ''
      expect(root, `${name}: корневой контейнер не найден`).not.toBe('')
      expect(root, `${name}: свой max-w вместо общего page-w`).not.toMatch(/max-w-/)
      expect(root, `${name}: не использует page-w`).toContain('page-w')
    }
  })
})

describe('кнопка «назад» на странице проекта', () => {
  it('идёт по настоящей истории, когда она есть', () => {
    expect(screen, 'кнопка снова ведёт в одно жёстко заданное место').toMatch(
      /locationKey === 'default' \? navigate\(`\$\{base\}\/tasks`\) : navigate\(-1\)/,
    )
  })

  it('при прямом заходе уводит в работу, а не из приложения', () => {
    /**
     * Прямая ссылка или обновление страницы — истории нет, и navigate(-1)
     * вышвырнул бы на предыдущий сайт. React Router помечает первую запись
     * ключом 'default'; читаем именно его.
     */
    expect(screen).toMatch(/key: locationKey \} = useLocation\(\)/)
  })

  it('на страницах вне вкладок кнопка видна на любой ширине', () => {
    // Иначе на широком экране уйти с них нечем: подсветки нет, кнопки нет.
    expect(screen).toMatch(/const OFF_TAB_PAGES = \[[\s\S]*?'shortcuts'[\s\S]*?\] as const/)
    expect(screen).toMatch(/offTab \? '' : 'xl:hidden'/)
  })

  it('подпись не обещает чат', () => {
    // Кнопка ведёт назад по истории — подпись «Чат» была бы враньём.
    const btn = screen.match(/onClick=\{\(\) => \(locationKey[\s\S]{0,600}?title=\{t\('([^']+)'\)\}/)
    expect(btn?.[1], 'подпись кнопки не найдена').toBeDefined()
    expect(btn![1]).not.toBe('tabs.chat')
  })
})
