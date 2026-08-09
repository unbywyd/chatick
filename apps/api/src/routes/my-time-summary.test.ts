import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// «Мои часы по всем проектам» — экран времени в мобильном.
//
// Ручка существует не ради новых прав: свои записи человек и так видит и
// правит в проектной ручке. Она нужна ради одного запроса вместо запроса на
// каждый проект. Но собирая записи сразу по многим проектам, легко потерять
// то, что в проектной ручке обеспечивал сам токен: там projectId приходил из
// токена и подделать его было нельзя, здесь список проектов клиент называет
// сам.
//
// Отсюда три вещи, которые обязаны стоять и которые ничего не стоит потерять
// при рефакторинге:
//   1. фильтр по человеку слушается только у того, кто вправе видеть чужое;
//   2. чужие часы отдаются только по проектам, где он руководит;
//   3. список коллег не приходит вовсе тем, кому он не положен.
//
// Ошибка в любой из трёх не видна на типичном пути: у админа всё работает, у
// участника экран тоже открывается — просто показывает лишнее.

const src = readFileSync(join(import.meta.dirname, 'time.ts'), 'utf8')

/** Тело ручки от объявления до следующего объявления маршрута. */
function handler(): string {
  const re = /timeMineRoute\.get\(\s*'\/summary'/
  const m = re.exec(src)
  expect(m, 'ручка GET /my/time/summary не найдена').not.toBeNull()
  const rest = src.slice(m!.index + 20)
  // Следующий маршрут любого из роутеров файла.
  const end = rest.search(/time(Mine|Company)?Route\.(get|post|patch|delete)\(/)
  return rest.slice(0, end === -1 ? undefined : end)
}

const body = handler()

describe('мои часы по всем проектам: доступ', () => {
  it('чужие часы показывает только тому, кто вправе их видеть', () => {
    // Ключевая строка: userId из запроса берётся ТОЛЬКО под флагом прав.
    // Без canSeeOthers участник дописал бы ?userId= и получил чужие часы.
    expect(body).toMatch(/const target = canSeeOthers && f\.userId \? f\.userId : sub/)
  })

  it('право видеть чужое считается по роли в проекте, а не в компании', () => {
    // owner/admin проекта — те же роли, что и в проектной ручке canSeeOthers.
    // Роль в компании сюда не годится: админ компании не обязательно участник
    // проекта, и часы чужого проекта его не касаются.
    expect(body).toMatch(/m\.role === 'owner' \|\| m\.role === 'admin'/)
    expect(body).toMatch(/const canSeeOthers = leadProjectIds\.length > 0/)
  })

  it('чужие часы ищет только там, где человек руководит', () => {
    // Общий проект, где оба — участники, не даёт права на чужие часы в нём.
    // Без этой строки хватило бы руководства В ОДНОМ проекте, чтобы увидеть
    // чужое время во всех общих.
    expect(body).toMatch(
      /const searchIds = target === sub \? allowedIds : allowedIds\.filter\(\(id\) => leadProjectIds\.includes\(id\)\)/,
    )
  })

  it('не выходит за пределы проектов, где человек состоит', () => {
    // projectId приходит от клиента: без пересечения с myProjectIds можно
    // было бы назвать чужой проект и получить свои часы... вместе с чужим
    // именем проекта в ответе.
    expect(body).toMatch(/const allowedIds = scopeIds\.filter\(\(id\) => myProjectIds\.includes\(id\)\)/)
    expect(body).toMatch(/if \(!allowedIds\.length\) return c\.json\(\{ error: 'Forbidden' \}, 403\)/)
  })

  it('записи всегда фильтруются по выбранному человеку', () => {
    // Даже у админа выборка ограничена одним человеком: экран показывает
    // часы кого-то одного, а не всё подряд.
    expect(body).toMatch(/eq\(timeEntries\.userId, target\)/)
  })
})

describe('мои часы по всем проектам: список коллег', () => {
  it('без прав не приходит вовсе', () => {
    // Именно не приходит, а не приходит и прячется в клиенте: скрытое в
    // интерфейсе достаётся из ответа за минуту, и состав команды утёк бы
    // тому, кого он не касается.
    expect(body).toMatch(/const people = canSeeOthers\s*\?\s*await db/)
    expect(body).toMatch(/:\s*\[\]/)
  })

  it('собирается только из проектов, где человек руководит', () => {
    expect(body).toMatch(/inArray\(projectMembers\.projectId, leadProjectIds\)/)
  })
})

describe('мои часы по всем проектам: подсчёт', () => {
  it('дата без времени берёт сутки целиком', () => {
    // Тот же приём, что в остальных сводках: 'YYYY-MM-DD' разбирается как
    // полночь, и без этого «по сегодня» теряет весь последний день.
    expect(body).toMatch(/if \(periodTo && !f\.to!\.includes\('T'\)\) periodTo\.setHours\(23, 59, 59, 999\)/)
  })

  it('режет запись по границам периода, а не считает целиком', () => {
    // Смена с 23:00 до 02:00 на границе месяца иначе попала бы в отчёт
    // полностью, и сумма месяцев не сошлась бы с годом.
    expect(body).toMatch(/least\(\$\{timeEntries\.endedAt\}, \$\{clipEnd\}\)/)
    expect(body).toMatch(/greatest\(\$\{timeEntries\.startedAt\}, \$\{clipStart\}\)/)
    expect(body).toMatch(/greatest\(\$\{clipped\}, 0\)/)
  })

  it('берёт записи, пересекающиеся с периодом', () => {
    // Условие по endedAt, а не по startedAt: ночная смена обязана найтись
    // при поиске за сегодня.
    expect(body).toMatch(/\$\{timeEntries\.endedAt\} >= \$\{periodFrom\.toISOString\(\)\}::timestamptz/)
  })

  it('не считает идущие таймеры', () => {
    // У незакрытой записи нет endedAt: без этого сумма прыгала бы от того,
    // забыл ли кто-то остановить таймер.
    expect(body).toMatch(/\$\{timeEntries\.endedAt\} is not null/)
  })

  it('итог складывается из тех же строк, что показаны по проектам', () => {
    // Иначе число в шапке разойдётся с суммой строк на экране — и доверия к
    // отчёту не будет ни у кого.
    expect(body).toMatch(/totalMinutes: byProjectRows\.reduce\(\(s, r\) => s \+ r\.minutes, 0\)/)
  })
})

describe('мои часы по всем проектам: пустые случаи', () => {
  it('человек без проектов получает пустой ответ, а не ошибку', () => {
    // inArray по пустому списку — это SQL-ошибка, а для нового человека без
    // проектов пустой экран нормален.
    expect(body).toMatch(/if \(!myProjectIds\.length\)/)
    expect(body).toMatch(/items: \[\], byProject: \[\], totalMinutes: 0/)
  })
})
