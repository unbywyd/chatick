import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Смена компании из сайдбара и липкие фильтры над задачами.
//
// Обе правки про одно: убрать шаги там, где человек ходит чаще всего.

const app = (p: string) => readFileSync(join(import.meta.dirname, '../../../app/src', p), 'utf8')
const sidebar = app('components/ProjectSidebar.tsx')
const switcher = app('components/CompanySwitcher.tsx')
const tasks = app('components/tabs/TasksTab.tsx')

describe('компания меняется, не выходя из проекта', () => {
  it('переключатель есть в обоих видах сайдбара', () => {
    // Свёрнутый — тоже: иначе за сменой пришлось бы сперва разворачивать
    // сайдбар, то есть добавить шаг к тому, что мы сокращаем.
    expect((sidebar.match(/<CompanySwitcher/g) ?? []).length).toBe(2)
  })

  it('переиспользуем готовый переключатель, а не пишем второй', () => {
    // Два меню выбора компании разъехались бы при первой же правке.
    expect(sidebar).toMatch(/import \{ CompanySwitcher \}/)
  })

  it('кнопка компании по-прежнему ведёт в настройки', () => {
    // Это разные намерения: зайти в компанию и сменить её. Объединить в один
    // клик значило бы отнять одно ради другого.
    expect(sidebar).toMatch(/navigate\(`\/start\/\$\{company\?\.id \?\? ''\}`\)/)
  })

  it('стрелки нет, когда выбирать не из чего', () => {
    // С одной компанией меню открывало бы список из одной строки — уже
    // выбранной.
    expect((sidebar.match(/myCompanies\.length > 1 && company &&/g) ?? []).length).toBe(2)
  })

  it('выбор своей же компании ничего не делает', () => {
    // Иначе клик по текущей уводил бы из проекта на главную — «ничего не
    // выбрал, а меня куда-то дели».
    expect((sidebar.match(/if \(id === company\.id\) return/g) ?? []).length).toBe(2)
  })

  it('стрелка стоит перед кнопкой компании', () => {
    // В конце ряда она отрывалась от названия и вставала между колокольчиком
    // и профилем — читалась как третий значок настроек, а не как «сменить вот
    // эту компанию».
    const row = sidebar.slice(sidebar.indexOf('{/* Низ: возврат в компанию'))
    expect(row.indexOf('<CompanySwitcher')).toBeLessThan(row.indexOf('<CompanyBrand'))
    expect(row.indexOf('<CompanySwitcher')).toBeLessThan(row.indexOf('<NotificationBell'))
  })

  it('компактный вид не повторяет название', () => {
    // Рядом уже стоит кнопка с именем компании.
    expect(switcher).toMatch(/compact\?: boolean/)
    expect(switcher).toMatch(/\{!compact && <span/)
  })
})

describe('фильтры остаются на виду', () => {
  it('липнет ряд фильтров, а не вся шапка', () => {
    // Форма создания, прогресс и сводка — больше двухсот пикселей: четверть
    // экрана, которую пришлось бы отдать навсегда. Их смотрят один раз.
    expect(tasks).toMatch(/sticky top-0/)
    const at = tasks.indexOf('sticky top-0')
    const before = tasks.slice(0, at)
    // Прогресс и сводка остаются ВЫШЕ липкого блока, то есть уезжают.
    expect(before).toMatch(/ProjectSummary/)
  })

  it('полоса перекрывает список целиком', () => {
    // Контейнер страницы имеет свой отступ: без обратных полей по краям
    // остаются щели, сквозь которые видно уезжающие строки.
    const at = tasks.indexOf('sticky top-0')
    const line = tasks.slice(at, at + 120)
    expect(line).toMatch(/-mx-6/)
    expect(line).toMatch(/px-6/)
  })

  it('фон непрозрачный', () => {
    // Сквозь полупрозрачный видно проезжающие под фильтрами строки.
    const at = tasks.indexOf('sticky top-0')
    expect(tasks.slice(at, at + 120)).toMatch(/bg-background(?!\/)/)
  })

  it('поиск и вид едут вместе с фильтрами', () => {
    // Их меняют посреди списка так же часто, как фильтры.
    const at = tasks.indexOf('sticky top-0')
    const block = tasks.slice(at, tasks.indexOf('{/* Табличный вид', at))
    expect(block).toMatch(/tasks\.search/)
    expect(block).toMatch(/tasks\.viewTable/)
  })
})
