import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * «Сколько уже тормозит проект» считается от даты СВЯЗКИ, а не задачи.
 *
 * Разница не теоретическая. На живых данных TASK-49 («CardCom — משתמש ה-API
 * חסום») заведена за пять дней до того, как стала блокером: по возрасту задачи
 * полоса писала «5 дней тормозит проект», хотя проект она держала два.
 *
 * Врёт это ровно на тех блокерах, которые выявили по ходу работы, — а они и
 * есть самое интересное. Заведённые сразу зависимыми (TASK-9, TASK-10) дают
 * одинаковое число обоими способами, поэтому подмена незаметна на глаз и
 * держится только тестом.
 */

const api = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8').replace(/\r\n/g, '\n')
const app = (p: string) =>
  readFileSync(join(import.meta.dirname, '../../../app/src/', p), 'utf8').replace(/\r\n/g, '\n')

const tasks = api('routes/tasks.ts')
const strip = app('components/tabs/tasks/BlockersStrip.tsx')

describe('сервер отдаёт дату начала блокировки', () => {
  it('blockingSince берётся из task_blockers, а не из tasks.created_at', () => {
    // Саботаж: заменить min(b.created_at) на t.created_at — тест падает.
    const at = tasks.indexOf('blockingSince:')
    expect(at, 'поле blockingSince исчезло из списка задач').toBeGreaterThan(-1)
    const q = tasks.slice(at, at + 400)
    expect(q, 'дата берётся не из связки').toMatch(/min\(b\.created_at\)/)
    expect(q, 'запрос не по таблице связок').toMatch(/task_blockers|\$\{taskBlockers\}/)
  })

  it('связки к закрытым задачам не считаются', () => {
    // Связь переживает закрытие намеренно (см. схему task_blockers). Без
    // фильтра по статусу снятая месяц назад блокировка вечно показывала бы
    // «тормозит 30 дней», хотя не держит никого.
    //
    // Саботаж: убрать dt.status <> 'done' — тест падает.
    const at = tasks.indexOf('blockingSince:')
    const q = tasks.slice(at, at + 400)
    expect(q, 'учитываются связки к уже закрытым задачам').toMatch(/dt\.status <> 'done'/)
  })

  it('внешняя строка квалифицирована явно', () => {
    // Голое «id» в подзапросе разрешается во внутреннюю таблицу: Postgres
    // отвечает «column reference is ambiguous», и весь список задач падает с
    // 500. Соседние подзапросы об этом предупреждают в комментарии.
    //
    // Саботаж: заменить "tasks"."id" на просто id — тест падает.
    const at = tasks.indexOf('blockingSince:')
    const q = tasks.slice(at, at + 400)
    expect(q, 'ссылка на внешнюю строку не квалифицирована').toMatch(/b\.blocker_task_id = "tasks"\."id"/)
  })
})

describe('полоса блокеров считает возраст от связки', () => {
  it('срок блокировки считается от blockingSince', () => {
    // Возраст задачи (createdAt) тоже показываем — но ОТДЕЛЬНЫМ числом, под
    // своим ключом. Подмена, от которой стережём: срок блокировки начинает
    // считаться от создания задачи, и «тормозит проект» завышается.
    //
    // Саботаж: заменить ageOf(b.blockingSince) на ageOf(b.createdAt) в
    // расчёте worst — тест падает.
    const at = strip.indexOf('const worst =')
    const fn = strip.slice(at, at + 320)
    expect(fn, 'срок блокировки считается не от связки').toMatch(/const link = ageOf\(b\.blockingSince\)/)

    // Число «тормозит проект» приходит именно из link, а не из task.
    const worstAge = strip.slice(strip.indexOf('const worstAge'), strip.indexOf('const worstAge') + 120)
    expect(worstAge, 'worstAge берётся не из срока блокировки').toMatch(/worst\?\.link/)
  })

  it('без даты возраст не выдумывается', () => {
    // «0 дн» там, где мы не знаем, хуже пустоты: это утверждение, а не
    // умолчание. Саботаж: вернуть 0 вместо null — тест падает.
    const at = strip.indexOf('function ageOf')
    const fn = strip.slice(at, strip.indexOf('export function BlockersStrip'))
    expect(fn, 'пустая дата не даёт null').toMatch(/if \(!since\) return null/)
    expect(fn, 'нечисловая дата не даёт null').toMatch(/Number\.isNaN\(ms\)\) return null/)
  })

  it('в счётчике показан худший блокер, а не первый попавшийся', () => {
    // Проект стоит столько, сколько стоит худшая связка. Среднее спрятало бы
    // месячную блокировку за парой свежих.
    //
    // Саботаж: заменить link > max.link на link < max.link — тест падает.
    const at = strip.indexOf('const worst =')
    expect(at, 'worst исчез').toBeGreaterThan(-1)
    expect(strip.slice(at, at + 320), 'берётся не максимум').toMatch(/link > max\.link/)
  })
})

describe('переводы возраста есть во всех языках', () => {
  // Ключ без перевода показывается человеку как «blockers.stripWorst» —
  // молча, без ошибки в консоли.
  //
  // Формы спрашиваем у Intl, а не перечисляем руками: у иврита есть
  // двойственное число (2 → «two»), и написанный по памяти список _one/_other
  // это как раз и пропустил — «2 ימים» вместо «יומיים». Список из головы
  // повторил бы ту же ошибку молча.
  const locales = ['ru', 'en', 'he'] as const

  for (const loc of locales) {
    it(`${loc}: stripWorst и stripAge во всех формах языка`, () => {
      const j = JSON.parse(
        readFileSync(join(import.meta.dirname, `../../../app/src/i18n/locales/${loc}.json`), 'utf8'),
      )
      // Какие формы вообще бывают у этого языка на реальных числах.
      const pr = new Intl.PluralRules(loc)
      const forms = [...new Set([1, 2, 3, 5, 11, 21, 29, 100].map((n) => pr.select(n)))]
      expect(forms.length, `у ${loc} не нашлось форм`).toBeGreaterThan(0)

      for (const key of ['stripWorst', 'stripAge', 'stripTaskAge']) {
        for (const form of forms) {
          expect(j.blockers?.[`${key}_${form}`], `нет blockers.${key}_${form}`).toBeTruthy()
        }
      }
      // Хотя бы одна форма подставляет число: иначе «тормозит проект» без
      // срока — ровно то, чего не хватало до этой правки. Не все формы: в
      // иврите «יומיים» уже значит «два дня», и {{count}} там лишний.
      const worst = forms.map((f) => j.blockers[`stripWorst_${f}`] as string)
      expect(worst.some((s) => s.includes('{{count}}')), 'нигде не подставляется число').toBe(true)
    })
  }
})

describe('рядом со сроком блокировки виден возраст задачи', () => {
  it('показан только при заметном расхождении', () => {
    // Два числа отвечают на разные вопросы: связка — «сколько стоит проект»,
    // задача — «сколько её не берут». Связи здесь ставят задним числом (из 38
    // только 7 заведены сразу), поэтому «2 дня» скрывает, что задача лежит
    // неделю.
    //
    // Но при разнице в день это шум: «завели вечером, связали утром».
    //
    // Саботаж: убрать порог (>= 0) — тест падает.
    const at = strip.indexOf('const taskAge')
    expect(at, 'taskAge исчез').toBeGreaterThan(-1)
    expect(strip.slice(at, at + 200), 'нет порога расхождения').toMatch(
      /worst\.task - worst\.link >= 2/,
    )
  })

  it('берётся возраст ИМЕННО худшего блокера, а не чужой задачи', () => {
    // worst держит обе даты вместе. Если считать возраст задачи отдельным
    // проходом, легко взять максимум по другой задаче — и рядом окажутся два
    // числа про разные строки.
    //
    // Саботаж: заменить task: ageOf(b.createdAt) на null — тест падает.
    const at = strip.indexOf('const worst =')
    expect(at, 'worst исчез').toBeGreaterThan(-1)
    expect(strip.slice(at, at + 320), 'даты не связаны одной задачей').toMatch(
      /\{ link, task: ageOf\(b\.createdAt\) \}/,
    )
  })
})

describe('возраст не дублирует заголовок', () => {
  it('у задачи он скрыт, когда равен худшему', () => {
    // «29 дней тормозит проект · TASK-9 29д · TASK-10 29д · TASK-19 29д» —
    // одно число четырежды в одной строке. Так выходит, когда блокеры завели
    // разом при разборе проекта, а это самый частый случай.
    //
    // Саботаж: вернуть `const age = own` — тест падает.
    const at = strip.indexOf('const own = ageOf')
    expect(at, 'расчёт возраста задачи исчез').toBeGreaterThan(-1)
    expect(strip.slice(at, at + 220), 'возраст задачи не сравнивается с худшим').toMatch(
      /own === worstAge \? null : own/,
    )
  })
})
