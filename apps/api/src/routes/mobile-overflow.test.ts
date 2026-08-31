import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Обзор компании не должен распирать экран телефона вбок.
 *
 * Горизонтальная прокрутка внизу страницы — беда тихая: на мониторе её нет,
 * ловится она только на узком экране, а в RTL вдобавок ломает расчёт высоты, и
 * низ содержимого обрезается.
 *
 * Виноват всегда один и тот же приём: flex-элемент с фиксированной шириной или
 * без min-w-0. Такой элемент не сжимается уже своего содержимого и выталкивает
 * строку за край.
 */

const read = (p: string) =>
  readFileSync(join(import.meta.dirname, '../../../app/src/', p), 'utf8')
const overview = read('components/company/OverviewTab.tsx')
const people = read('components/company/PeopleStats.tsx')
const start = read('screens/StartScreen.tsx')
const lang = read('components/LanguageSelect.tsx')

describe('полоска активности сжимается', () => {
  it('у клеток и ряда есть min-w-0', () => {
    // 28 клеток с зазорами не помещались в ширину телефона: flex-1 даёт
    // базовую ширину 0%, но неявный минимум по содержимому остаётся, и полоса
    // распирала страницу.
    //
    // Саботаж: убрать min-w-0 — прокрутка вернётся.
    const at = people.indexOf('function ActivityStrip')
    const fn = people.slice(at, people.indexOf('export function PeopleStats'))
    expect(fn, 'ряд клеток не сжимается').toMatch(/className="flex min-w-0 gap-px"/)
    expect(fn, 'клетка не сжимается').toMatch(/'h-4 min-w-0 flex-1 rounded/)
  })
})

describe('поля ввода не держат ширину на телефоне', () => {
  it('поиск проектов переносится и тянется по месту', () => {
    // Было w-40 (160px) рядом с заголовком в одной нерастяжимой строке.
    const at = overview.indexOf("t('overview.projects')")
    const block = overview.slice(at - 400, at + 700)
    expect(block, 'строка заголовка не переносится').toMatch(/flex flex-wrap items-center/)
    expect(block, 'поле держит фиксированную ширину').toMatch(/w-full min-w-0 rounded-md/)
  })

  it('переключатель периода во всю ширину на телефоне', () => {
    expect(overview).toMatch(/<PeriodPicker[^/]*className="w-full sm:w-52"/)
  })

  it('поиск людей тянется по месту', () => {
    expect(people).toMatch(/className="h-8 w-full max-w-56 text-sm"/)
  })
})

describe('шапка помещается на телефоне', () => {
  it('логотип и разделитель скрыты на узком экране', () => {
    // «Chatick / <длинное название компании>» не помещалось, и шапка сама
    // становилась источником горизонтальной прокрутки. Название компании
    // важнее: в каком он приложении, человек знает и так.
    const at = start.indexOf("t('start.allCompanies')")
    const block = start.slice(at - 500, at + 900)
    expect(block, 'логотип виден на телефоне').toMatch(/hidden rounded-md transition-opacity hover:opacity-70 sm:block/)
    expect(block, 'разделитель виден на телефоне').toMatch(/hidden text-muted-foreground sm:inline/)
  })

  it('язык на телефоне — кодом, без иконки', () => {
    // «עברית» и «Русский» отнимали место у остального; «HE» и «RU» отвечают
    // на тот же вопрос. Иконка рядом со стрелкой избыточна.
    expect(lang, 'иконка языка видна на телефоне').toMatch(/<Languages className="hidden size-3\.5 sm:block" \/>/)
    expect(lang, 'на телефоне показывается полное название языка').toMatch(
      /<span className="sm:hidden">\{current\?\.code\.toUpperCase\(\)\}<\/span>/,
    )
    expect(lang).toMatch(/<span className="hidden sm:inline">\{current\?\.label\}<\/span>/)
  })
})

describe('сетки перестраиваются в одну колонку', () => {
  it('карточки проектов и людей — по одной на телефоне', () => {
    // sm:grid-cols-2 значит «две колонки от 640px», то есть на телефоне одна.
    // Саботаж: убрать префикс sm: — две колонки на 400px не помещаются.
    expect(overview, 'карточки проектов не перестраиваются').toMatch(/grid gap-2 sm:grid-cols-2/)
    expect(people, 'карточки людей не перестраиваются').toMatch(/grid gap-2 sm:grid-cols-2/)
    expect(overview, 'метрики не перестраиваются').toMatch(/grid gap-3 sm:grid-cols-3/)
  })
})

describe('создание задачи на телефоне', () => {
  const sheet = read('components/tabs/tasks/NewTaskSheet.tsx')
  const tab = read('components/tabs/TasksTab.tsx')

  it('строчная форма на телефоне скрыта', () => {
    // Пять элементов в ряд там не помещаются: полю названия оставалось два
    // сантиметра, и человек печатал вслепую.
    expect(tab).toMatch(/className="hidden gap-2 sm:flex"/)
  })

  it('вместо неё кнопка, и только на телефоне', () => {
    expect(tab).toMatch(/onClick=\{\(\) => setSheetOpen\(true\)\}/)
    expect(tab).toMatch(/className="w-full sm:hidden"/)
  })

  it('лист выезжает снизу, а не по центру', () => {
    // Клавиатура выезжает снизу и накрывает нижнюю половину экрана. Окно по
    // центру она закрыла бы вместе с полем, ради которого его открыли.
    //
    // Саботаж: заменить justify-end на place-items-center — поле уедет под
    // клавиатуру.
    expect(sheet, 'лист не прижат к низу').toMatch(/flex flex-col justify-end/)
    expect(sheet, 'лист виден на широком экране').toMatch(/sm:hidden/)
  })

  it('учитывает полосу жеста внизу', () => {
    // На телефонах без кнопки «домой» кнопка «Создать» попадала бы под неё.
    expect(sheet).toMatch(/pb-\[max\(1rem,env\(safe-area-inset-bottom\)\)\]/)
  })

  it('фокус в поле сразу, без лишнего касания', () => {
    // Иначе клавиатура выезжает только после второго касания.
    expect(sheet).toMatch(/requestAnimationFrame\(\(\) => inputRef\.current\?\.focus\(\)\)/)
  })

  it('срок передаётся аргументом, а не через состояние', () => {
    // Лист держит свою дату у себя; читая newDue, мутация увидела бы значение
    // до setState — и срок молча терялся бы.
    //
    // Саботаж: вернуть create.mutate(title) — задача создастся без срока.
    expect(tab).toMatch(/onCreate=\{\(title, due\) => create\.mutate\(\{ title, due \}\)\}/)
    expect(tab, 'мутация читает срок из состояния').toMatch(
      /mutationFn: \(\{ title, due \}: \{ title: string; due\?: string \}\)/,
    )
  })
})
