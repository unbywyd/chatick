import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Свод часов по проектам на странице компании.
 *
 * Отчёт умел складывать часы только по людям. Вопрос «сколько часов занял
 * проект» задают снаружи — заказчик, счёт, оценка следующего этапа, — и
 * ответа в один клик не было: складывали строки из карточек разных людей
 * руками.
 */

const CRLF = new RegExp(String.fromCharCode(13) + String.fromCharCode(10), 'g')
const LF = String.fromCharCode(10)
const time = readFileSync(join(import.meta.dirname, 'time.ts'), 'utf8').replace(CRLF, LF)
const tab = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/company/CompanyTimeTab.tsx'),
  'utf8',
).replace(CRLF, LF)
const loc = (l: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, `../../../app/src/i18n/locales/${l}.json`), 'utf8'))

describe('часы компании сводятся по проектам', () => {
  it('разбивка по проектам приезжает вместе с людьми', () => {
    // Иначе ответ на «сколько занял проект» пришлось бы собирать на клиенте
    // из карточек людей — ровно та ручная работа, ради которой всё это.
    //
    // Саботаж: убрать projects из ответа — тест падает.
    // Именно итоговый ответ, а не ранний `return c.json({ error: 'Forbidden' })`.
    const at = time.indexOf('people,', time.indexOf('const projectList'))
    expect(at, 'итогового ответа нет').toBeGreaterThan(-1)
    expect(time.slice(at, at + 200), 'проекты не отдаются').toContain('projects: projectList')
  })

  it('второго запроса в базу не делаем', () => {
    // Строки уже сгруппированы по паре «человек × проект»: обе разбивки —
    // одни и те же числа, сложенные в разном порядке. Лишний запрос дал бы
    // расхождение при записи, попавшей между двумя выборками.
    //
    // Саботаж: добавить отдельный select для проектов — тест падает.
    const at = time.indexOf('const byProject = new Map')
    expect(at, 'свод по проектам не строится').toBeGreaterThan(-1)
    const tail = time.slice(at, time.indexOf('return c.json', at))
    expect(tail, 'свод по проектам делает свой запрос').not.toContain('db.execute')
    expect(tail, 'свод по проектам делает свой запрос').not.toContain('.select({')
    expect(tail, 'свод строится не из общих строк').toContain('for (const r of rows)')
  })

  it('обе разбивки дают один и тот же итог', () => {
    // Это главное свойство: если суммы разойдутся, в счёт уйдёт неверное
    // число. Складываем одни и те же r.minutes — значит итог совпадает по
    // построению, и никакой отдельной фильтрации у проектов быть не должно.
    const at = time.indexOf('const byProject = new Map')
    const tail = time.slice(at, time.indexOf('return c.json', at))
    expect(tail, 'проекты считают минуты не из тех же строк').toContain('entry.minutes += r.minutes')
    expect(tail, 'у проектов появился свой фильтр — итоги разойдутся').not.toContain('.filter(')
  })

  it('свод выбирается и переживает пересылку ссылки', () => {
    // Отчётом делятся ссылкой. Состояние в useState потерялось бы при
    // переходе, и получатель увидел бы не то, что отправитель.
    //
    // Саботаж: перевести groupBy на useState — тест падает.
    expect(tab, 'свод не читается из адреса').toContain("params.get('by')")
    expect(tab, 'свод не пишется в адрес').toContain('patchParams({ by:')
  })

  it('внутри проекта видно, кто списал часы', () => {
    // «Сколько всего» и «кто это сделал» — один вопрос в два шага: счёт
    // почти всегда просят обосновать.
    expect(tab, 'состав проекта не показан').toContain('pr.people.map')
  })

  it('выгрузка по проекту существует', () => {
    // Лист, который отправляют заказчику. Без него ответ снова собирают
    // руками, только теперь глядя в экран.
    expect(tab, 'нет выгрузки по проекту').toContain('const exportProject =')
    expect(tab, 'кнопка выгрузки не выведена').toContain('exportProject(pr)')
  })

  it('переключатель переведён на три языка', () => {
    // Иврит здесь не формальность: на нём работает вся команда StartPlan.
    for (const l of ['en', 'ru', 'he']) {
      const t = loc(l).time
      for (const k of ['groupBy', 'byPeople', 'byProjects', 'exportProject', 'peopleOnProject', 'entriesCount']) {
        expect(t?.[k], `${l}: нет ключа time.${k}`).toBeTruthy()
      }
    }
  })
})

describe('отбор по проекту и «за всё время»', () => {
  const picker = readFileSync(
    join(import.meta.dirname, '../../../app/src/components/ui/period-picker.tsx'),
    'utf8',
  ).replace(CRLF, LF)

  it('сервер умеет отбирать по проекту', () => {
    // Без этого «сколько занял ОДИН проект» приходится искать глазами в
    // списке из тридцати карточек.
    //
    // Саботаж: убрать projectId из схемы — тест падает.
    expect(time, 'projectId не принимается').toContain('projectId: z.string().optional()')
    expect(time, 'projectId не применяется').toContain('eq(timeEntries.projectId, f.projectId)')
  })

  it('«за всё время» доступно из меню', () => {
    // Оно существовало, но было спрятано из опасения поднять каждую запись
    // компании. Свод считает СУБД — наружу едет строка на пару «человек ×
    // проект», а не на запись. Замер на проде: 0.19 мс.
    //
    // Саботаж: убрать 'all' из PRESETS — тест падает.
    // Отсчёт от `= [`, а не от первой `[`: в строке объявления стоит
    // `PresetKey[]`, и срез по ней давал пустой `[]`.
    const at = picker.indexOf('= [', picker.indexOf('const PRESETS'))
    const list = picker.slice(at, picker.indexOf(']', at))
    expect(list, '«за всё время» спрятано из меню').toContain("'all'")
  })

  it('пустой период не превращается в Invalid Date', () => {
    // За всё время дат нет вовсе: new Date('') дало бы «Invalid Date» и в
    // чипсе фильтра, и в имени выгружаемого файла.
    expect(tab, 'чипс периода падает на пустых датах').toContain("period.from || period.to")
    expect(tab, 'имя файла не учитывает пустой период').toContain("period.from || period.to ?")
  })

  it('список проектов берётся не из отчёта', () => {
    // Отчёт уже отфильтрован: выбрав проект, человек получил бы список из
    // одного пункта и не смог бы сменить выбор.
    //
    // Саботаж: собрать options из report.data.projects — тест падает.
    expect(tab, 'проекты для отбора берутся из отчёта').toContain("queryKey: ['company-projects'")
    expect(tab, 'использована несуществующая ручка').toContain('/api/v1/projects?companyId=')
  })

  it('выбранный проект виден и снимается', () => {
    // Фильтр может приехать ссылкой — иначе список выглядит необъяснимо
    // урезанным.
    expect(tab, 'проект не попадает в запрос').toContain("p.set('projectId', projectId)")
    expect(tab, 'проект не учтён в строке фильтров').toContain('Boolean(projectId)')
  })

  it('смена проекта перезапрашивает отчёт', () => {
    // useMemo с неполным списком зависимостей вернул бы старую строку
    // запроса, и отчёт молча остался бы прежним.
    //
    // Саботаж: убрать projectId из зависимостей — тест падает.
    const at = tab.indexOf('const query = useMemo')
    const tail = tab.slice(at, tab.indexOf('const report', at))
    expect(tail, 'projectId не в зависимостях useMemo').toContain('[period, userId, projectId]')
  })
})
