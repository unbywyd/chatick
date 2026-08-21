import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Обвязка страниц проекта: ширина контейнера и кнопка «назад».
 *
 * Страницы вне полосы вкладок — горячие клавиши, ИИ, уведомления, команда —
 * открываются из меню профиля. Ни одна вкладка при этом не подсвечена, и уйти
 * с них было нечем: единственная стрелка жила в панели вкладок, вела всегда в
 * чат и на широком экране пряталась вовсе.
 *
 * Стрелка теперь в самой странице, в одном ряду с заголовком — как на
 * странице профиля, откуда и взят образец.
 */

const app = (f: string) => readFileSync(join(import.meta.dirname, '../../../app/src', f), 'utf8')
const header = app('components/ui/page-header.tsx')
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

describe('заголовок страницы со стрелкой «назад»', () => {
  it('стрелка стоит на всех четырёх страницах', () => {
    // Копипастой их было бы четыре разных: у горячих клавиш заголовок был
    // даже другого размера, чем у соседей.
    for (const name of PAGES) {
      expect(app(`components/tabs/${name}.tsx`), `${name}: нет общего заголовка`).toMatch(/<PageHeader/)
    }
  })

  it('стрелка внутри страницы, а не в полосе вкладок', () => {
    // В навбаре кнопка осталась своя — «назад в чат», когда чат не помещается
    // рядом. Она про другое и живёт отдельно.
    expect(header).toMatch(/<ArrowLeft/)
    expect(screen, 'кнопка навбара снова притворяется общей').toMatch(/title=\{t\('tabs\.chat'\)\}/)
  })

  it('идёт по настоящей истории, когда она есть', () => {
    expect(header, 'кнопка снова ведёт в одно жёстко заданное место').toMatch(
      /locationKey === 'default' && companyId && id \? navigate\(`\/c\/\$\{companyId\}\/p\/\$\{id\}\/tasks`\) : navigate\(-1\)/,
    )
  })

  it('при прямом заходе уводит в работу, а не из приложения', () => {
    /**
     * Прямая ссылка или обновление страницы — истории нет, и navigate(-1)
     * вышвырнул бы на предыдущий сайт. React Router помечает первую запись
     * ключом 'default'; читаем именно его.
     */
    expect(header).toMatch(/const \{ key: locationKey \} = useLocation\(\)/)
  })

  it('подпись не обещает чат', () => {
    // Кнопка ведёт назад по истории — подпись «Чат» была бы враньём.
    expect(header).toMatch(/title=\{t\('connect\.back'\)\}/)
    expect(header).not.toMatch(/tabs\.chat/)
  })
})
