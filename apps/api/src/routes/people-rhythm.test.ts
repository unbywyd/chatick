import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Ритм команды: метрика, которая не наказывает за очередь.
 *
 * Разбор на живых данных (StartPlan, 617 задач). Две очевидные метрики
 * оказались враньём, и обе назвали худшим САМОГО БЫСТРОГО человека компании:
 *
 *   • «средний возраст открытых задач» — у него 82 задачи по 23.6 дня, худший
 *     результат в компании. При этом он же первый по активности: 802 действия,
 *     13 проектов, 24 активных дня из 30. Возраст мерил размер очереди.
 *
 *   • «доля закрытых от заведённых» — 36% против 81% у коллеги. При этом
 *     медиана жизни его закрытой задачи 0.1 дня против 0.9 у того же коллеги.
 *     Доля мерила приток задач, а не работу.
 *
 * Поэтому здесь стоят сторожа на ОТСУТСТВИЕ этих двух метрик: они выглядят
 * настолько естественно, что вернутся при первой же правке «добавь процент».
 */

const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8').replace(/\r\n/g, '\n')
const companies = read('./companies.ts')
const ui = read('../../../app/src/components/company/PeopleStats.tsx')

/** Тело запроса ритма. */
function rhythmQuery(): string {
  const at = companies.indexOf('const rhythm = await db.execute')
  expect(at, 'запрос ритма не найден').toBeGreaterThan(-1)
  return companies.slice(at, companies.indexOf('const rhythmRows', at))
}

describe('очередь не штрафуется', () => {
  it('возраст открытой задачи в показатели не попал', () => {
    // Саботаж: добавить avg(now() - created_at) по ОТКРЫТЫМ задачам — и
    // человек с самой длинной очередью снова станет худшим.
    const q = rhythmQuery()
    // Возраст считается только у НЕТРОНУТЫХ — это про молчание, а не про
    // очередь. Строка без "first_touch is null" была бы возрастом очереди.
    const ages = q.split('\n').filter((l) => l.includes('now() - t.created_at'))
    expect(ages.length, 'возраст задач нигде не считается').toBeGreaterThan(0)
    for (const line of ages) {
      const at = q.indexOf(line)
      const around = q.slice(at, at + 260)
      expect(around, 'возраст считается не только по нетронутым').toContain('first_touch is null')
    }
  })

  it('процента доведения нет ни на сервере, ни в интерфейсе', () => {
    // Саботаж: вернуть done/total — цифра снова назовёт самого быстрого
    // худшим. Проверяем оба конца: сервер мог бы отдать долю, клиент —
    // посчитать её сам из closed и openNow.
    // Ищем именно ДЕЛЕНИЕ на общее число задач, а не слово «percent»:
    // percentile_cont — это медиана, она здесь законно и нужна.
    expect(rhythmQuery(), 'сервер снова считает долю доведения').not.toMatch(/100(\.0)?\s*\*\s*count/)
    expect(ui, 'клиент считает процент доведения сам').not.toMatch(/closed\s*\/\s*\(?\s*r\.(openNow|closed)/)
  })
})

describe('молчание считается честно', () => {
  it('касанием считается действие САМОГО исполнителя', () => {
    // Иначе чужая правка засчиталась бы человеку как ответ, и «ждут ответа»
    // показывало бы ноль там, где человек не отзывался ни разу.
    //
    // Саботаж: убрать сравнение автора — метрика станет всегда нулевой.
    const q = rhythmQuery()
    expect(q, 'комментарий не сверяется с исполнителем').toContain('c.author_id = m.uid')
    expect(q, 'действие не сверяется с исполнителем').toContain('l.actor_id = m.uid')
  })

  it('нетронутые считаются среди ОТКРЫТЫХ, а не среди всех', () => {
    // Закрытая задача, которую человек не комментировал, — не «молчание»:
    // она сделана. Считая её, мы бы наказывали за молчаливую работу.
    const q = rhythmQuery()
    const at = q.indexOf('as untouched')
    const line = q.slice(q.lastIndexOf('count(*)', at), at)
    expect(line, 'в нетронутые попадают закрытые задачи').toContain("status not in ('done','verified')")
  })

  it('порог молчания считается ДОЛЕЙ, а не числом', () => {
    // Два нетронутых хвоста при 81 задаче — это 2%, а четыре при четырёх —
    // все сто. По абсолютному числу ярлык достался бы первому, а не второму.
    //
    // Саботаж: сравнить untouched с константой — ярлык уедет к самому
    // загруженному человеку вместо самого молчаливого.
    const at = companies.indexOf("flags.push('ignoring')")
    expect(at, 'признак молчания не найден').toBeGreaterThan(-1)
    const cond = companies.slice(companies.lastIndexOf('if (', at), at)
    expect(cond, 'молчание оценивается абсолютным числом').toMatch(/untouched \/ openNow/)
  })
})

describe('тормозит — только про ЧУЖИЕ задачи', () => {
  it('свои задачи, заблокированные своими же, не считаются', () => {
    // Это не «мешает команде», а порядок собственной работы. Без этого
    // условия человек, разбивший работу на связанные шаги, выглядел бы
    // главным тормозом компании.
    //
    // Саботаж: убрать сравнение исполнителей — счётчик вырастет у всех, кто
    // просто пользуется блокерами.
    const at = companies.indexOf('const blocks = await db.execute')
    expect(at, 'запрос блокеров не найден').toBeGreaterThan(-1)
    const q = companies.slice(at, companies.indexOf('const blockRows', at))
    expect(q, 'свои блокеры засчитываются как чужие').toContain(
      'blocked.assignee_id is distinct from blocker.assignee_id',
    )
  })
})

describe('правило живёт на сервере', () => {
  it('пороги ярлыков считает сервер, а не интерфейс', () => {
    // Правило, выписанное дважды, однажды разойдётся: в списке компании
    // человек «тормозит», а в своей карточке нет. Клиент только выбирает
    // текст по присланному признаку.
    expect(companies, 'сервер не отдаёт признаки').toMatch(/flags\.push\('stalled'\)/)
    expect(ui, 'клиент пересчитывает порог двух недель сам').not.toMatch(/over2w\s*>=\s*3/)
    expect(ui, 'клиент решает про блокеры сам').not.toMatch(/blocking\s*>=\s*3/)
  })

  it('период ограничен списком, а не любым числом', () => {
    // Период уходит прямо в make_interval: «сколько угодно дней» стало бы
    // способом заказать тяжёлый запрос по всей истории компании.
    const at = companies.indexOf('const daysRaw')
    expect(at, 'разбор периода не найден').toBeGreaterThan(-1)
    expect(companies.slice(at, at + 200)).toMatch(/\[7, 30, 90\]\.includes\(daysRaw\)/)
  })
})

describe('переводы на месте', () => {
  it('все три языка знают новые ключи', () => {
    for (const lang of ['ru', 'en', 'he']) {
      const json = JSON.parse(
        readFileSync(join(import.meta.dirname, `../../../app/src/i18n/locales/${lang}.json`), 'utf8'),
      ) as { people: Record<string, unknown> }
      for (const key of ['waiting', 'react', 'closed', 'blocking', 'actions', 'flagBlocking', 'unit']) {
        expect(json.people?.[key], `${lang}.people.${key} отсутствует`).toBeTruthy()
      }
      // Единицы времени — через переводы: зашитые «мин» и «дн» на иврите
      // читались бы как латиница посреди строки справа налево.
      const unit = json.people.unit as Record<string, string>
      for (const u of ['min', 'hour', 'day']) {
        expect(unit?.[u], `${lang}.people.unit.${u} отсутствует`).toBeTruthy()
      }
    }
  })
})
