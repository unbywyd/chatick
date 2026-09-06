import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * «Реакция» меряет отклик на ЧУЖУЮ просьбу.
 *
 * Ошибка, ради которой написан этот тест, была тихой и правдоподобной:
 * медиана считалась по всем задачам подряд, включая заведённые человеком
 * себе. Такую задачу трогают через полминуты после создания — не потому, что
 * быстро отреагировали, а потому что дозаполняют.
 *
 * На живых данных это давало «реакция 1 минута» человеку, который не
 * притронулся ни к одной из 32 открытых задач: все её 31 касание были по
 * собственным. И занижало метрику у ВСЕХ — у одного 1.9 часа вместо 51.7,
 * потому что из 218 касаний по чужим задачам было 34.
 */

const companies = readFileSync(join(import.meta.dirname, 'companies.ts'), 'utf8').replace(/\r\n/g, '\n')
const people = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/company/PeopleStats.tsx'),
  'utf8',
).replace(/\r\n/g, '\n')

describe('реакция не считает самозаведённые задачи', () => {
  it('в выборку идут только чужие задачи', () => {
    // Саботаж: убрать `and not t.self_made` — тест падает.
    const at = companies.indexOf('as react_h')
    expect(at, 'метрика реакции исчезла').toBeGreaterThan(-1)
    const block = companies.slice(at - 400, at + 40)
    expect(block, 'в медиану идут самозаведённые задачи').toMatch(
      /first_touch is not null and not t\.self_made\)::numeric, 1\) as react_h/,
    )
  })

  it('признак самозаведённой задачи вычисляется из автора', () => {
    // is not distinct from, а не =: created_by_id бывает null (задача из
    // интеграции), и `null = assignee_id` дало бы null вместо false — такая
    // задача не попала бы ни в одну ветку фильтра.
    //
    // Саботаж: заменить на `=` — тест падает.
    expect(companies, 'self_made не вычисляется').toMatch(
      /\(t\.created_by_id is not distinct from t\.assignee_id\) as self_made/,
    )
  })
})

describe('медиана по двум числам не показывается', () => {
  it('меньше трёх откликов — null', () => {
    // Медиана одного-двух чисел это само число. Рядом с «32 из 32 не тронуто»
    // она читалась как прямое опровержение.
    //
    // Саботаж: убрать порог — тест падает.
    const at = companies.indexOf('reactMedianHours:')
    expect(at, 'поле reactMedianHours исчезло').toBeGreaterThan(-1)
    expect(companies.slice(at, at + 260), 'нет порога по размеру выборки').toMatch(
      /Number\(r\?\.react_n \?\? 0\) < 3/,
    )
  })

  it('размер выборки доезжает до клиента', () => {
    // Прочерк без объяснения выглядит поломкой.
    // Саботаж: убрать reactSample — тест падает.
    expect(companies, 'сервер не отдаёт размер выборки').toMatch(/reactSample: Number\(r\?\.react_n \?\? 0\)/)
    expect(people, 'клиент не объясняет прочерк').toMatch(/people\.reactFew/)
  })

  it('клиент не пересчитывает порог сам', () => {
    // Правило живёт на сервере: клиент показывает прочерк на null, а не
    // сравнивает выборку с тройкой во второй раз.
    //
    // Саботаж: добавить в клиент `reactSample < 3` — тест падает.
    expect(people, 'порог продублирован на клиенте').not.toMatch(/reactSample\s*<\s*\d/)
  })
})

describe('переводы объяснения есть во всех языках', () => {
  for (const loc of ['ru', 'en', 'he'] as const) {
    it(`${loc}: reactFew во всех формах, включая ноль`, () => {
      const j = JSON.parse(
        readFileSync(join(import.meta.dirname, `../../../app/src/i18n/locales/${loc}.json`), 'utf8'),
      )
      // Ноль откликов — самый частый случай прочерка, и у него свой текст:
      // «мало данных: 0 откликов» звучит как поломка счётчика.
      expect(j.people?.reactFew_zero, 'нет текста для нуля откликов').toBeTruthy()
      const pr = new Intl.PluralRules(loc)
      for (const form of [...new Set([1, 2, 3, 5, 11, 21].map((n) => pr.select(n)))]) {
        expect(j.people?.[`reactFew_${form}`], `нет people.reactFew_${form}`).toBeTruthy()
      }
    })
  }
})
