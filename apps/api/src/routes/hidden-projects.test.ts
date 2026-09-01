import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Скрытые проекты: «убрал со стола до завтра».
 *
 * Просьба звучала иначе — «пусть остаются только проекты с открытыми
 * задачами». Так делать нельзя: у половины команды задач на себе нет вовсе, а
 * проекты нужны. У Хадиль 14 проектов и задачи в трёх, у Таля 13 и в двух —
 * одиннадцать исчезли бы, хотя там идёт переписка и ждут ревью.
 *
 * Второй отвергнутый вариант — «показывать только с уведомлениями»: список
 * скачет от разбора инбокса. У человека, разобравшего почту, сайдбар опустел
 * бы целиком, включая проект с 74 его задачами.
 *
 * Поэтому решает ЧЕЛОВЕК, а возвращает — уведомление.
 */

const projects = readFileSync(join(import.meta.dirname, 'projects.ts'), 'utf8')
const sidebar = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/ProjectSidebar.tsx'),
  'utf8',
)
const schema = readFileSync(join(import.meta.dirname, '../db/schema.ts'), 'utf8')

describe('скрытие личное, а не общее', () => {
  it('поле лежит в членстве, а не в проекте', () => {
    // В projects есть archived_at, но он про другое: ПМ убирает законченный
    // проект у ВСЕЙ компании. Положив скрытие туда же, мы бы дали одному
    // человеку прятать проект у всех.
    //
    // Саботаж: перенести hiddenAt в projects — скрытие станет общим.
    const at = schema.indexOf("export const projectMembers")
    const table = schema.slice(at, schema.indexOf('export const', at + 100))
    expect(table, 'скрытие не в членстве').toMatch(/hiddenAt: timestamp\('hidden_at'/)
  })

  it('ручка меняет только свою строку', () => {
    // Иначе один человек скрыл бы проект другому.
    const at = projects.indexOf("projectsRoute.post('/:projectId/hide'")
    expect(at, 'ручка скрытия не найдена').toBeGreaterThan(-1)
    const fn = projects.slice(at, projects.indexOf('/**', at + 100))
    expect(fn.replace(/\s+/g, ' ')).toContain('eq(projectMembers.userId, sub)')
    expect(fn, 'не член проекта может что-то скрыть').toMatch(/if \(!me\) return c\.json/)
  })
})

describe('уведомление возвращает проект', () => {
  it('правило считает сервер, а не клиент', () => {
    // Иначе его пришлось бы повторить в сайдбаре, в трее и в списке компании
    // — и однажды разойтись. Проверено на живых данных: скрыл проект, вставил
    // уведомление — признак hidden стал false.
    //
    // Саботаж: убрать проверку unread — скрытый проект перестанет
    // возвращаться, и человек пропустит то, ради чего скрытие и заводилось.
    const at = projects.indexOf('hidden: Boolean(myByProject.get(p.id)?.hiddenAt)')
    expect(at, 'признак hidden не отдаётся').toBeGreaterThan(-1)
    const line = projects.slice(at, projects.indexOf('\n', at))
    expect(line, 'непрочитанное не возвращает проект').toMatch(/&& \(unread\.get\(p\.id\) \?\? 0\) === 0/)
  })

  it('клиент правило не пересчитывает', () => {
    // Сайдбар обязан верить серверу: своя копия правила разъедется с чужой.
    expect(sidebar, 'клиент считает скрытость сам').not.toMatch(/hiddenAt/)
    expect(sidebar).toMatch(/p\.hidden/)
  })
})

describe('сайдбар', () => {
  it('две вкладки, и скрытая появляется только когда есть что показать', () => {
    // Пустой раздел обещает содержимое, которого нет.
    expect(sidebar).toMatch(/const \[tab, setTab\] = useState<'work' \| 'hidden'>\('work'\)/)
    expect(sidebar, 'вкладка скрытых видна всегда').toMatch(/\{hiddenCount > 0 && \(/)
  })

  it('поиск игнорирует вкладку', () => {
    // «Нашлось, но в другой вкладке» — худший ответ на поиск.
    expect(sidebar).toMatch(/const inTab = needle \? mine : mine\.filter/)
  })

  it('сказано, что скрытое возвращается само', () => {
    // Без этого человек не знает, вернётся ли проект, и боится скрывать.
    expect(sidebar).toMatch(/sidebar\.hiddenNote/)
  })

  it('меню лежит рядом с кнопкой строки, а не внутри неё', () => {
    // Вложенные кнопки ломают разметку и клавиатурный обход.
    const at = sidebar.indexOf('group/row relative')
    expect(at, 'строка не подготовлена под меню').toBeGreaterThan(-1)
    const row = sidebar.slice(at, at + 3000)
    expect(row.indexOf('</button>'), 'меню внутри кнопки строки').toBeLessThan(row.indexOf('<DropdownMenu>'))
  })
})

describe('слова не путаются с архивом', () => {
  it('в сайдбаре «скрытые», а не «архив»', () => {
    // «Архив» уже занят и означает противоположное: там ПМ убирает
    // законченный проект у всей компании. Два «архива» в одном приложении —
    // гарантированная путаница вида «я убрал, а коллега всё равно видит».
    expect(sidebar, 'в сайдбаре появилось слово archive').not.toMatch(/start\.showArchived|start\.archive\b/)
    expect(sidebar).toMatch(/sidebar\.hidden/)
  })

  it('переводы есть во всех трёх языках', () => {
    for (const lang of ['ru', 'en', 'he']) {
      const json = JSON.parse(
        readFileSync(join(import.meta.dirname, `../../../app/src/i18n/locales/${lang}.json`), 'utf8'),
      ) as { sidebar: Record<string, string> }
      for (const key of ['working', 'hidden', 'hide', 'unhide', 'hiddenNote']) {
        expect(json.sidebar?.[key], `${lang}.sidebar.${key} отсутствует`).toBeTruthy()
      }
    }
  })
})
