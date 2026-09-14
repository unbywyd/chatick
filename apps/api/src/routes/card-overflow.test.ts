import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Длинные имена не должны распирать страницу вбок.
 *
 * Механизм всегда один: колонка грида и флекс-элемент НЕ сжимаются ниже
 * своего содержимого. Одно длинное слово — и вся сетка уезжает за край,
 * внизу появляется горизонтальная прокрутка.
 *
 * Замер на 390px: сетка карточек без min-w-0 распирается до 577px, с ним —
 * 366px. truncate у самого заголовка от этого не спасает: он обрезает текст
 * только когда родителю уже задана ширина.
 */

const app = (p: string) =>
  readFileSync(join(import.meta.dirname, '../../../app/src/', p), 'utf8').replace(/\r\n/g, '\n')

describe('сетки карточек сжимаются', () => {
  const cases = [
    ['документы', 'components/tabs/DocumentsTab.tsx', /<li key=\{d\.id\} className="group relative min-w-0">/],
    ['проекты', 'screens/StartScreen.tsx', /<li key=\{p\.id\} className="min-w-0">/],
    ['команда', 'components/tabs/ProjectTeamTab.tsx', /grid gap-2 sm:grid-cols-2 \[&>\*\]:min-w-0/],
    ['заметки', 'components/tabs/NotesTab.tsx', /grid gap-3 sm:grid-cols-3 \[&>\*\]:min-w-0/],
  ] as const

  for (const [name, file, rule] of cases) {
    it(`${name}: у элемента сетки есть min-w-0`, () => {
      // Саботаж: убрать min-w-0 — тест падает, и на 390px возвращается
      // горизонтальная прокрутка.
      expect(app(file), `${name}: сетка распирается длинным именем`).toMatch(rule)
    })
  }
})

describe('строка спринта не выдавливает себя за край', () => {
  const table = app('components/tabs/tasks/TasksTable.tsx')

  it('имя спринта обрезается, а не растягивает строку', () => {
    // Рядом счётчик, цвет, карандаш и корзина — им нужнее место, чем хвосту
    // названия. Полное имя остаётся в title.
    //
    // Саботаж: убрать truncate — тест падает.
    expect(table, 'имя спринта не обрезается').toMatch(
      /<span className="min-w-0 truncate" title=\{group\.name\}>/,
    )
  })

  it('строка переносится на телефоне', () => {
    // Без переноса прогресс справа выдавливает имя за край экрана.
    // Саботаж: вернуть flex items-center без flex-wrap — тест падает.
    expect(table, 'строка спринта не переносится').toMatch(
      /mb-1\.5 flex min-w-0 flex-wrap items-center/,
    )
  })

  it('прогресс уходит на свою строку только на узком экране', () => {
    // На широком он должен остаться у правого края — там место свободно.
    // Саботаж: убрать sm:w-auto — прогресс займёт строку и на мониторе.
    expect(table, 'прогресс всегда занимает всю строку').toMatch(/w-full shrink-0 items-center gap-2 sm:ms-auto sm:w-auto/)
  })
})

describe('запись времени помещается на телефоне', () => {
  const time = app('components/tabs/TimeTab.tsx')

  it('строка переносится на узком экране', () => {
    // В одну строку втиснуто семеро: аватар, описание с проектом, время
    // начала и его дата, тире, время конца и его дата, итог и меню.
    //
    // Замер на 390px: имя проекта сжималось до 15px — от
    // «Simply Touch (רון דגן & עמית נוה)» оставалась пара пикселей, а итог
    // справа обрезался. После переноса имя занимает всю ширину, время с
    // итогом уходит на второй ряд.
    //
    // Саботаж: вернуть flex items-center без flex-wrap — тест падает.
    expect(time, 'строка времени не переносится').toContain(
      'group flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 sm:flex-nowrap',
    )
  })

  it('на широком экране раскладка прежняя', () => {
    // sm:flex-nowrap и sm:basis-auto возвращают одну строку там, где место
    // есть: ломать привычный вид на мониторе ради телефона незачем.
    //
    // Саботаж: убрать sm:basis-auto — описание займёт свою строку и на
    // мониторе, а справа останется пустота.
    expect(time, 'описание всегда занимает отдельную строку').toContain('min-w-0 flex-1 basis-full sm:basis-auto')
  })
})
describe('в шапке видно, какой проект открыт', () => {
  const screen = app('screens/ProjectScreen.tsx')

  it('имя проекта показано и обрезается', () => {
    // Единственным указателем был сайдбар: в свёрнутом виде там одни иконки,
    // и активную среди них не разглядеть.
    //
    // Саботаж: убрать truncate — длинное имя отожмёт вкладки.
    expect(screen, 'имени проекта в шапке нет').toMatch(
      /<h1 className="min-w-0 truncate text-sm font-semibold" title=\{project\.data\.name\}>/,
    )
  })

  it('цвет проекта помечает шапку', () => {
    // Имя отвечает на «где я», но читать его каждый раз — работа. Цвет
    // узнаётся боковым зрением.
    //
    // Саботаж: убрать полосу — тест падает.
    expect(screen, 'цвет проекта не показан').toMatch(/background: project\.data\.color/)
    // Полоса, а не заливка: у проектов насыщенные цвета, фон под всем экраном
    // спорил бы с содержимым.
    expect(screen, 'цветом залит фон, а не полоса').toMatch(/absolute inset-x-0 bottom-0 h-0\.5/)
  })
})
