import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Цифры на обзоре ведут туда, где раскрываются.
 *
 * «Просрочено: 7» отвечает «сколько», не отвечая «где» — человек шёл смотреть
 * проект за проектом. То же с часами и людьми: цифра есть, а пойти за ней
 * некуда.
 *
 * Отдельная забота — чтобы кликабельность была ВИДНА. Курсор и подсветка на
 * наведении работают лишь для того, кто уже навёл, а навести можно только
 * туда, где ждёшь ответа.
 */

const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8')
const overview = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/company/OverviewTab.tsx'),
  'utf8',
)
const start = readFileSync(join(import.meta.dirname, '../../../app/src/screens/StartScreen.tsx'), 'utf8')
const timeTab = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/tabs/TimeTab.tsx'),
  'utf8',
)

describe('карточка выглядит кликабельной до наведения', () => {
  it('подпись действия видна постоянно, а не по hover', () => {
    // Саботаж: убрать actionLabel — карточка станет кликабельной молча, и
    // человек этого не узнает.
    const at = overview.indexOf('function Metric({')
    const fn = overview.slice(at)
    expect(fn).toMatch(/actionLabel &&/)
    expect(fn, 'подпись спрятана за hover').not.toMatch(/opacity-0[^"]*group-hover:opacity-100[\s\S]{0,80}actionLabel/)
  })

  it('это кнопка, а не div с onClick', () => {
    // Иначе клавиатура и скринридер проходят мимо.
    const at = overview.indexOf('function Metric({')
    expect(overview.slice(at, at + 1800)).toMatch(/const Tag = onClick \? 'button' : 'div'/)
  })

  it('стрелка разворачивается в RTL', () => {
    const at = overview.indexOf('function Metric({')
    expect(overview.slice(at)).toMatch(/ChevronRight className="size-3 rtl:rotate-180"/)
  })
})

describe('каждая цифра ведёт по адресу', () => {
  it('часы — на вкладку часов, люди — в команду', () => {
    expect(start).toMatch(/onOpenHours=\{canManage \? \(\) => navigate\(`\/start\/\$\{company\.id\}\/time`\)/)
    expect(start).toMatch(/onOpenTeam=\{\(\) => navigate\(`\/start\/\$\{company\.id\}\/team`\)\}/)
  })

  it('задача из списка просроченных открывается в своём проекте', () => {
    expect(start).toMatch(/onOpenTask=\{\(projectId, taskId\) => navigate\(`\/c\/\$\{company\.id\}\/p\/\$\{projectId\}\/tasks\/\$\{taskId\}`\)\}/)
  })

  it('часы кликабельны только у тех, кто их видит', () => {
    // Вкладка «Часы» доступна руководству: вести туда остальных значит
    // обещать экран, который встретит отказом.
    expect(start).toMatch(/onOpenHours=\{canManage \?/)
  })
})

describe('пустая просрочка не обещает модалку', () => {
  it('клик только когда есть что показать', () => {
    // Пустая модалка на нуле — обещание, за которым ничего нет.
    expect(overview).toMatch(/onClick=\{totals\?\.overdue \? \(\) => setOverdueOpen\(true\) : undefined\}/)
    expect(overview).toMatch(/actionLabel=\{totals\?\.overdue \? t\('overview\.details'\) : undefined\}/)
  })
})

describe('список просроченных', () => {
  const companies = read('companies.ts')

  it('ручка отдаёт задачи, а не только число', () => {
    expect(companies).toMatch(/companiesRoute\.get\('\/:companyId\/overdue'/)
  })

  it('условие просрочки СОВПАДАЕТ со счётчиком, а не просто похоже', () => {
    // Разойдутся — «Просрочено: 7» откроет шесть задач, и никто не поймёт,
    // какое из чисел врёт.
    //
    // Первая версия этой проверки искала «dueDate < now()» и пропустила
    // саботаж, добавивший «- interval '7 days'»: подстрока-то осталась.
    // Сравниваем нормализованные условия целиком.
    const norm = (x: string) => x.replace(/\s+/g, ' ').trim()

    const counterAt = companies.indexOf("overdue: sql<number>")
    expect(counterAt, 'счётчик просрочки не найден').toBeGreaterThan(-1)
    const counter = companies.slice(counterAt, companies.indexOf('\n', counterAt))
    // Из счётчика: count(*) filter (where <status> <> 'done' and <due> < now())
    const counterCond = norm(counter.slice(counter.indexOf('where') + 5, counter.lastIndexOf(')::int')))

    const listAt = companies.indexOf("'/:companyId/overdue'")
    const list = companies.slice(listAt, listAt + 2500)
    const listCond = norm(
      list.slice(list.indexOf("sql`${tasks.status} <> 'done'`"), list.indexOf('.orderBy')),
    )

    // Оба должны говорить одно: не done и срок в прошлом. Сверяем по частям,
    // потому что записаны они разным синтаксисом.
    for (const piece of ["<> 'done'", '< now()']) {
      expect(counterCond, `счётчик потерял «${piece}»`).toContain(piece)
      expect(listCond, `список потерял «${piece}»`).toContain(piece)
    }
    // И ничего сверх: интервал, статус, проект — любое лишнее условие
    // разводит два числа.
    expect(listCond, 'в списке появилось условие, которого нет в счётчике').not.toMatch(/interval|status\} = |assignee/)
  })

  it('чужие проекты помечены, а не скрыты', () => {
    // Знать, что в соседнем проекте горит, полезно и без доступа туда. А вот
    // открыть не выйдет — и сказать об этом лучше заранее, чем отказом.
    const at = companies.indexOf("'/:companyId/overdue'")
    expect(companies.slice(at, at + 2500)).toMatch(/isMember: mine\.has\(r\.p\.id\)/)
  })

  it('в модалке задача чужого проекта не кликается', () => {
    expect(overview).toMatch(/disabled=\{!group\.isMember\}/)
  })
})

describe('часы проекта ведут к общим часам', () => {
  it('кнопка есть', () => {
    // Здесь только часы ЭТОГО проекта, а человек работает в нескольких.
    expect(timeTab).toMatch(/time\.allHours/)
    expect(timeTab).toMatch(/navigate\(`\/start\/\$\{companyId\}\/time`\)/)
  })

  it('без компании в адресе кнопки нет', () => {
    // Компания берётся из URL; вне него вести некуда.
    expect(timeTab).toMatch(/\{companyId && \(/)
  })
})
