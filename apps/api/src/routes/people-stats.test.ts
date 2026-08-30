import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Статистика по людям компании.
 *
 * Два места, где легко соврать правдоподобно:
 *
 * 1. СЧЁТ ЧЕРЕЗ JOIN. Первая версия соединяла задачи и записи времени в одном
 *    запросе — строки перемножились, и у Артёма вышло 1561 задача вместо 82 и
 *    4369 часов вместо 179. Числа выглядят настоящими, просто больше.
 *
 * 2. ПОСЛЕДНЯЯ АКТИВНОСТЬ ИЗ ОДНОГО ИСТОЧНИКА. Журнал не знает про чат: у
 *    Даниэля он показывал 13:52, тогда как комментарий тот оставил в 14:38, а
 *    Марселя в журнале нет вовсе — он только пишет.
 */

const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8')
const companies = read('companies.ts')
const ui = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/company/PeopleStats.tsx'),
  'utf8',
)

const at = companies.indexOf("companiesRoute.get('/:companyId/people'")
const fn = companies.slice(at, companies.indexOf("companiesRoute.get('/:companyId/overdue'"))

describe('цифры считаются раздельно, а не через join', () => {
  it('ручка есть', () => {
    expect(at, 'ручка статистики по людям не найдена').toBeGreaterThan(-1)
  })

  it('задачи и часы — подзапросами', () => {
    // Саботаж: свести их в один запрос с двумя join — числа раздуются в разы,
    // и заметить это можно только сверив с базой вручную.
    const norm = fn.replace(/\s+/g, ' ')
    expect(norm, 'открытые задачи считаются не подзапросом').toMatch(
      /\(select count\(\*\) from tasks t join projects p on p\.id = t\.project_id[^)]*t\.status <> 'done'/,
    )
    expect(norm, 'часы считаются не подзапросом').toMatch(
      /\(select sum\(extract\(epoch from \(te\.ended_at - te\.started_at\)\)\)\/60/,
    )
  })

  it('удалённые задачи в счёт не идут', () => {
    expect(fn.replace(/\s+/g, ' ')).toContain("t.status <> 'done' and t.deleted_at is null")
    expect(fn.replace(/\s+/g, ' ')).toContain("t.status = 'done' and t.deleted_at is null")
  })

  it('часы — только закрытые отрезки и только за этот месяц', () => {
    // Идущий таймер (ended_at is null) дал бы отрицательное или пустое время.
    const norm = fn.replace(/\s+/g, ' ')
    expect(norm).toContain('te.ended_at is not null')
    expect(norm).toContain("te.started_at >= date_trunc('month', now())")
  })

  it('минуты, а не часы: округление живёт на клиенте', () => {
    // Округлив до часа на сервере, мы потеряли бы 40 минут работы.
    expect(fn).toMatch(/minutesThisMonth/)
  })
})

describe('последняя активность — из трёх источников', () => {
  it('журнал, сообщения и комментарии вместе', () => {
    // Саботаж: убрать любой union — и человек, работающий только в чате,
    // станет «неактивным».
    const norm = fn.replace(/\s+/g, ' ')
    expect(norm, 'нет журнала').toContain('from activity_log a join projects p on p.id = a.project_id')
    expect(norm, 'нет сообщений чата').toContain('from messages m join projects p on p.id = m.project_id')
    expect(norm, 'нет комментариев к задачам').toContain('from task_comments tc')
    expect((norm.match(/union all/g) ?? []).length, 'источников меньше трёх').toBe(2)
  })

  it('всё ограничено ЭТОЙ компанией', () => {
    // Иначе действие в чужой компании подсветило бы человека как активного.
    const norm = fn.replace(/\s+/g, ' ')
    expect((norm.match(/p\.company_id = \$\{companyId\}/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('чтение активностью не считается', () => {
    // «Открытый таб не считать»: ни одного источника про просмотры.
    expect(fn, 'в активность попали отметки о прочтении').not.toMatch(/last_seen|lastSeen|read_at/)
  })
})

describe('список id не ломает запрос', () => {
  it('через sql.join, а не = any(массив)', () => {
    // drizzle разворачивает массив в отдельные параметры: any(($1,$2)) — это
    // кортеж вместо массива, и запрос падает целиком. Проверено запуском:
    // «Failed query: ... where id = any(($1, $2))».
    expect(fn, 'вернулся any() с массивом — запрос упадёт').not.toMatch(/any\(\$\{ids\}\)/)
    expect(fn.replace(/\s+/g, ' ')).toContain('const idList = sql.join(ids.map((x) => sql`${x}`), sql`, `)')
  })

  it('пустой список людей не доходит до запроса', () => {
    // in () — синтаксическая ошибка. Компания без участников должна отдавать
    // пустоту, а не пятисотую.
    expect(fn).toMatch(/if \(!members\.length\) return c\.json\(\{ items: \[\], seesEveryone \}\)/)
  })
})

describe('кто кого видит', () => {
  it('участник видит только себя — фильтр в ЗАПРОСЕ', () => {
    // Саботаж: отдать всех и отфильтровать в интерфейсе — данные всё равно
    // уедут в браузер, и увидеть их можно будет в консоли.
    expect(fn.replace(/\s+/g, ' ')).toContain(
      'seesEveryone ? undefined : eq(companyMembers.userId, sub)',
    )
  })

  it('всех видит начальство компании, а не любой участник', () => {
    expect(fn).toMatch(/const seesEveryone = role === 'admin' \|\| role === 'manager'/)
  })

  it('чужак не пройдёт вовсе', () => {
    expect(fn).toMatch(/if \(!role\) return c\.json\(\{ error: 'Forbidden' \}, 403\)/)
  })
})

describe('полоска растёт вместе с историей компании', () => {
  it('сервер отдаёт первый день, и не глубже 90 суток', () => {
    // Жёсткие 90 дней у молодой компании давали две трети пустых клеток: вся
    // история 26 дней, а нарисовано 90. Пустая клетка читается как «человек
    // не работал», хотя означает «нас тогда здесь не было».
    //
    // Саботаж: убрать greatest(...) — и полоса снова уедет на 90 дней назад.
    const norm = fn.replace(/\s+/g, ' ')
    // Проверяем ВЫРАЖЕНИЕ ЦЕЛИКОМ, а не наличие подстроки: первая версия
    // теста искала «90 days» отдельно и пропустила саботаж, заменивший
    // границу на 'epoch' — подстрока-то в другом месте осталась.
    expect(norm, 'глубина полосы не ограничена 90 сутками через greatest').toMatch(
      /greatest\( least\( \(select min\(a\.created_at\)[\s\S]*?\), now\(\) - interval '90 days' \) as first_at/,
    )
    expect(fn, 'activitySince не отдаётся клиенту').toMatch(/activitySince: sinceRows\[0\]\?\.first_at \?\? null/)
  })

  it('считает сервер, а не клиент', () => {
    // Клиент видит только своих людей: участник — себя одного, и первый день
    // по такой выборке вышел бы неверным.
    expect(ui, 'клиент сам ищет первый день').not.toMatch(/Math\.min\(\.\.\.days/)
    expect(ui).toMatch(/const activitySince = peopleQ\.data\?\.activitySince \?\? null/)
  })

  it('у клетки есть подсказка с датой и что в этот день было', () => {
    // Просто дата на пустой клетке оставляет вопрос «и что?».
    expect(ui).toMatch(/title=\{`\$\{fmt\(c\.key\)\} — \$\{c\.active \? t\('people\.dayActive'\) : t\('people\.dayIdle'\)\}`\}/)
  })
})

describe('интерфейс', () => {
  it('«сколько времени назад» — через Intl, а не своей таблицей', () => {
    // Своя таблица на три языка разъехалась бы на первом же «5 часов» против
    // «5 часа», а на иврите — на порядке слов.
    expect(ui).toMatch(/new Intl\.RelativeTimeFormat\(i18n\.language, \{ numeric: 'auto' \}\)/)
  })

  it('часы → вчера → дата, как просили', () => {
    expect(ui).toMatch(/if \(hours < 24\) return rtf\.format\(-hours, 'hour'\)/)
    expect(ui).toMatch(/if \(days <= 2\) return rtf\.format\(-days, 'day'\)/)
    expect(ui).toMatch(/return then\.toLocaleDateString\(i18n\.language/)
  })

  it('поиск показывает найденное целиком, не обрезая до четырёх', () => {
    expect(ui).toMatch(/q\.trim\(\) \|\| expanded \? filtered : filtered\.slice\(0, PREVIEW\)/)
  })

  it('поиск по людям — только тому, кто видит всех', () => {
    expect(ui).toMatch(/seesEveryone && all\.length > PREVIEW/)
  })
})

describe('перевод на три языка', () => {
  for (const lang of ['ru', 'en', 'he']) {
    it(`${lang}: строки статистики переведены`, () => {
      const json = JSON.parse(
        readFileSync(join(import.meta.dirname, `../../../app/src/i18n/locales/${lang}.json`), 'utf8'),
      ) as { people: Record<string, string> }
      for (const key of ['title', 'lastActive', 'open', 'done', 'hoursThisMonth', 'showAll']) {
        expect(json.people?.[key], `${lang}.people.${key} отсутствует`).toBeTruthy()
      }
    })
  }
})
