import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Секция «Кто над чем работает» — планирование на обзоре компании.
 *
 * Три вещи здесь врут особенно охотно: количество задач у человека без задач,
 * часы при незаполненных оценках и «свободен» у того, кто вовсе не начинал
 * работать. Все три проверены на живых данных и все три стерегутся тестом.
 */

const api = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8').replace(/\r\n/g, '\n')
const app = (p: string) =>
  readFileSync(join(import.meta.dirname, '../../../app/src/', p), 'utf8').replace(/\r\n/g, '\n')

const companies = api('routes/companies.ts')
const workload = app('components/company/WorkloadStats.tsx')
const handler = companies.slice(
  companies.indexOf("companiesRoute.get('/:companyId/workload'"),
  companies.indexOf("companiesRoute.get('/:companyId/people'"),
)

describe('счёт задач не выдумывает работу', () => {
  it('считает count(m.id), а не count(*)', () => {
    // При left join человек без задач даёт одну ПУСТУЮ строку, и count(*)
    // насчитал бы ему единицу. Проверено на живых данных: шестеро получали
    // «1 задачу», которой нет.
    //
    // Саботаж: заменить count(m.id) на count(*) — тест падает.
    expect(handler, 'ручка /workload исчезла').toBeTruthy()
    expect(handler, 'открытые задачи считаются через count(*)').toMatch(/count\(m\.id\)::int as "openTasks"/)
    // И в остальных счётчиках тоже — они все по тому же left join.
    for (const field of ['blockedTasks', 'freeTasks', 'doingTasks']) {
      expect(handler, `${field} считается через count(*)`).toMatch(
        new RegExp(`count\\(m\\.id\\) filter[^"]*"${field}"`),
      )
    }
  })

  it('в очередь идут только незакрытые живые задачи', () => {
    // Саботаж: убрать любое условие — в «работе» окажутся закрытые.
    expect(handler, 'считаются удалённые задачи').toMatch(/t\.deleted_at is null/)
    expect(handler, 'считаются закрытые задачи').toMatch(/t\.status <> 'done'/)
  })
})

describe('часы не выдают догадку за факт', () => {
  it('суммируются только проставленные оценки', () => {
    // estimate_minutes — ТЕКСТ, и в нём бывает что угодно. Без проверки
    // регуляркой запрос падает на первой же записи вида «2ч».
    //
    // Саботаж: убрать ~ '^[0-9]+$' — тест падает.
    expect(handler, 'оценки суммируются без проверки формата').toMatch(
      /estimate_minutes ~ '\^\[0-9\]\+\$'[\s\S]{0,80}plannedMinutes/,
    )
  })

  it('рядом всегда едет число неоценённых', () => {
    // Часы без этого числа занижены у того, кто не ставит оценки, и по ним
    // начинают планировать. На живых данных у одного человека 14 задач из 52
    // без оценки — его 66 часов это меньше половины правды.
    //
    // Саботаж: убрать noEstimate из ответа — тест падает.
    expect(handler, 'сервер не отдаёт число неоценённых').toMatch(/"noEstimate"/)
    expect(workload, 'клиент не показывает, что оценены не все').toMatch(/workload\.noEstimate/)
  })
})

describe('«свободен» не приписывают тем, кто не начинал', () => {
  it('приглашённые без задач и без истории скрыты', () => {
    // Ноль задач И ни одного действия за всю историю. Показать их как
    // свободных — обещать начальству руки, которых нет: в живой компании
    // таких ровно половина состава.
    //
    // Саботаж: убрать фильтр — тест падает.
    expect(handler, 'не отсеиваются те, кто не начал работать').toMatch(
      /\.filter\(\(r\) => Number\(r\.openTasks\) > 0 \|\| r\.lastActiveAt\)/,
    )
  })

  it('человек с историей, но без задач, остаётся — он освободился', () => {
    // Это и есть главное, что секция может сказать. Условие через ИЛИ, а не И:
    // саботаж заменой || на && убирает именно освободившихся.
    const at = handler.indexOf('.filter((r) =>')
    expect(handler.slice(at, at + 80), 'условие через И — освободившиеся пропадут').not.toMatch(/&&/)
  })

  it('состояние считает сервер, а не клиент', () => {
    // Правило, выписанное дважды, однажды разойдётся: в списке «свободен», а
    // в карточке нет.
    //
    // Саботаж: вычислить state в компоненте — тест падает.
    expect(handler, 'сервер не считает состояние').toMatch(/const state =/)
    expect(workload, 'клиент пересчитывает состояние сам').not.toMatch(
      /freeTasks === 0 \?|openTasks === 0 \?/,
    )
  })

  it('«стоит» важнее «свободен» в порядке списка', () => {
    // Свободному дают работу, у стоящего она есть и не двигается — это чужая
    // вина. Оба выше занятых.
    //
    // Саботаж: поменять веса местами — тест падает.
    const at = handler.indexOf('const RANK')
    const rank = handler.slice(at, at + 120)
    expect(rank, 'порядок состояний не задан').toMatch(/idle: 0/)
    expect(rank, 'стоящие не выше готовых').toMatch(/stuck: 1/)
    expect(rank, 'готовые не выше занятых').toMatch(/ready: 2/)
    expect(rank, 'занятые не последние').toMatch(/working: 3/)
  })
})

describe('переводы секции есть во всех языках', () => {
  for (const loc of ['ru', 'en', 'he'] as const) {
    it(`${loc}: состояния и все формы множественного числа`, () => {
      const j = JSON.parse(
        readFileSync(join(import.meta.dirname, `../../../app/src/i18n/locales/${loc}.json`), 'utf8'),
      )
      const w = j.workload
      expect(w, 'нет раздела workload').toBeTruthy()
      // Все четыре состояния, которые может прислать сервер.
      for (const state of ['idle', 'stuck', 'ready', 'working']) {
        expect(w.state?.[state], `нет текста для состояния ${state}`).toBeTruthy()
        expect(handler, `сервер не присылает состояние ${state}`).toContain(`'${state}'`)
      }
      // Формы — у Intl, а не по памяти: у иврита есть двойственное число.
      const pr = new Intl.PluralRules(loc)
      const forms = [...new Set([1, 2, 3, 5, 11, 21, 100].map((n) => pr.select(n)))]
      for (const key of ['tasks', 'noEstimate', 'blocked', 'byProject']) {
        for (const form of forms) {
          expect(w[`${key}_${form}`], `нет workload.${key}_${form}`).toBeTruthy()
        }
      }
    })
  }
})

describe('секция стоит над «Людьми», а не под ними', () => {
  it('порядок на обзоре: сначала «у кого есть работа»', () => {
    // «Как человек справляется» без «есть ли у него работа» читается как
    // претензия к тому, кому просто нечего делать.
    //
    // Саботаж: поменять компоненты местами — тест падает.
    const overview = app('components/company/OverviewTab.tsx')
    const wl = overview.indexOf('<WorkloadStats')
    const ps = overview.indexOf('<PeopleStats')
    expect(wl, 'секция не подключена').toBeGreaterThan(-1)
    expect(ps, 'секция людей исчезла').toBeGreaterThan(-1)
    expect(wl, 'планирование оказалось ниже людей').toBeLessThan(ps)
  })
})
