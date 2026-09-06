import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Карточка «Держат работу» и порядок людей на обзоре компании.
 *
 * Две вещи, которые легко разъезжаются молча: число на карточке против
 * содержимого модалки, и вес флага против его подсветки.
 */

const api = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8').replace(/\r\n/g, '\n')
const app = (p: string) =>
  readFileSync(join(import.meta.dirname, '../../../app/src/', p), 'utf8').replace(/\r\n/g, '\n')

const companies = api('routes/companies.ts')
const overview = app('components/company/OverviewTab.tsx')

describe('число на карточке сходится со списком в модалке', () => {
  it('тотал считает УНИКАЛЬНЫЕ задачи, а не сумму по проектам', () => {
    // Связка живёт в проекте ЖДУЩЕЙ задачи. Блокер, держащий работу в двух
    // проектах, в сумме по проектам посчитался бы дважды — и «Держат: 5»
    // открыло бы модалку с четырьмя строками.
    //
    // Саботаж: заменить на list.reduce((s, p) => s + p.blockers, 0) — падает.
    const at = companies.indexOf('blockers: new Set(')
    expect(at, 'тотал blockers исчез').toBeGreaterThan(-1)
    expect(companies.slice(at, at + 160), 'тотал складывается по проектам').toMatch(
      /blockerPairs \?\? \[\]\)\.map\(\(r\) => r\.blockerTaskId\)/,
    )
  })

  it('и карточка, и модалка считают только живые связки', () => {
    // Связь переживает закрытие задачи намеренно. Без фильтра по статусу
    // карточка показывала бы давно расшитые блокировки.
    //
    // Саботаж: убрать любое из двух условий — падает.
    const at = companies.indexOf("companiesRoute.get('/:companyId/blocking'")
    expect(at, 'ручка /blocking исчезла').toBeGreaterThan(-1)
    const handler = companies.slice(at, at + 2600)
    expect(handler, 'блокер может быть закрыт').toMatch(/bt\.status <> 'done'/)
    expect(handler, 'ждущая может быть закрыта').toMatch(/dt\.status <> 'done'/)

    // Тот же фильтр в запросе для тотала — иначе числа разойдутся.
    const totalAt = companies.indexOf('select distinct b.blocker_task_id')
    expect(totalAt, 'запрос тотала исчез').toBeGreaterThan(-1)
    const totalQ = companies.slice(totalAt, totalAt + 420)
    expect(totalQ, 'тотал считает закрытые блокеры').toMatch(/bt\.status <> 'done'/)
    expect(totalQ, 'тотал считает дождавшиеся задачи').toMatch(/t\.status <> 'done'/)
  })

  it('модалка открывается только когда есть что показать', () => {
    // Пустая модалка на нуле — обещание, за которым ничего нет. Тот же приём,
    // что у просрочки рядом.
    //
    // Саботаж: сделать onClick безусловным — падает.
    const at = overview.indexOf("label={t('overview.blocking')}")
    expect(at, 'карточка блокеров исчезла').toBeGreaterThan(-1)
    expect(overview.slice(at, at + 320), 'модалка открывается и на нуле').toMatch(
      /onClick=\{totals\?\.blockers \? \(\) => setBlockingOpen\(true\) : undefined\}/,
    )
  })

  it('чужой проект помечен, а не открывается отказом', () => {
    // Как в модалке просрочки: человек не в команде — говорим сразу.
    // Саботаж: убрать disabled — падает.
    const at = overview.indexOf('function BlockingDialog')
    const fn = overview.slice(at, overview.indexOf('function OverdueDialog'))
    expect(fn, 'нет признака членства').toMatch(/isMember/)
    expect(fn, 'задача открывается в чужом проекте').toMatch(/disabled=\{!task\.isMember\}/)
  })
})

describe('люди отсортированы по тяжести, а не по загрузке', () => {
  it('вес берётся от флагов, а не от отдельного правила', () => {
    // Второе правило «кто плохой» разошлось бы с первым «что подсветить», и
    // человек с красной плашкой оказался бы в середине списка.
    //
    // Саботаж: считать badness от openTasks — падает.
    const at = companies.indexOf('const badness =')
    expect(at, 'badness исчез').toBeGreaterThan(-1)
    const fn = companies.slice(at, at + 700)
    expect(fn, 'вес считается не по флагам').toMatch(/flags\.reduce\(\(sum, f\) => sum \+ \(WEIGHT\[f\] \?\? 0\)/)

    // Все веса — из флагов, которые реально ставит сервер: вес несуществующего
    // флага молча ничего не делает.
    const weights = companies.slice(companies.indexOf('const WEIGHT'), companies.indexOf('const badness'))
    for (const flag of ['stalled', 'blocking', 'ignoring', 'scattered']) {
      expect(weights, `нет веса для ${flag}`).toContain(`${flag}:`)
      expect(companies, `флаг ${flag} нигде не ставится`).toContain(`flags.push('${flag}')`)
    }
  })

  it('застой считается долей очереди, а не числом задач', () => {
    // Три застрявших из трёх — вся очередь; три из пятидесяти одной — шесть
    // процентов. По голому числу оба получали поровну и стояли рядом.
    //
    // Саботаж: вернуть Math.min(30, over2w * 3) — падает.
    const at = companies.indexOf('const badness =')
    const fn = companies.slice(at, at + 700)
    expect(fn, 'застой считается абсолютным числом').toMatch(
      /\(x\.rhythm\.over2w \/ x\.rhythm\.openNow\) \* 30/,
    )
    // Деление под защитой: openNow == 0 дало бы NaN, и весь sort развалился бы
    // молча — NaN в компараторе не бросает, а путает порядок.
    expect(fn, 'деление на ноль не защищено').toMatch(/x\.rhythm\.openNow > 0/)
  })

  it('перегрузка наверх не двигает', () => {
    // overloadedOne/Many ставятся тем, кто отвечает почти на всё. Это не вина,
    // и веса у них быть не должно.
    //
    // Саботаж: добавить overloadedOne в WEIGHT — падает.
    const weights = companies.slice(companies.indexOf('const WEIGHT'), companies.indexOf('const badness'))
    expect(weights, 'перегрузка получила вес').not.toMatch(/overloaded/)
  })
})

describe('переводы карточки есть во всех языках', () => {
  for (const loc of ['ru', 'en', 'he'] as const) {
    it(`${loc}: заголовок, подпись и пустой случай`, () => {
      const j = JSON.parse(
        readFileSync(join(import.meta.dirname, `../../../app/src/i18n/locales/${loc}.json`), 'utf8'),
      )
      expect(j.overview?.blocking, 'нет подписи карточки').toBeTruthy()
      expect(j.overview?.noBlocking, 'нет текста для пустого списка').toBeTruthy()
      // Формы — у Intl, а не по памяти: у иврита есть двойственное число.
      const pr = new Intl.PluralRules(loc)
      for (const form of [...new Set([1, 2, 3, 5, 11, 21, 100].map((n) => pr.select(n)))]) {
        expect(j.overview?.[`blockingTitle_${form}`], `нет blockingTitle_${form}`).toBeTruthy()
      }
    })
  }
})
