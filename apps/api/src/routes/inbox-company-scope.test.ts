import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Лента уведомлений компании.
 *
 * Две беды, обе тихие.
 *
 * Первая: на главной StartPlan висели уведомления «Личных проектов». Запрос
 * фильтровался только по человеку, а компанию не спрашивал вовсе. Отличить
 * своё от чужого было нельзя — проект в подписи есть, а чья он компания, не
 * сказано.
 *
 * Вторая: innerJoin с проектами выбрасывал объявления компании — у них
 * проекта нет. Уведомление создано, счётчик его считал, а в списке его не
 * было. На живых данных: 153 уведомления у человека, видно 152.
 */

const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8')
const route = read('inbox.ts')
const inbox = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/ProjectInbox.tsx'),
  'utf8',
)

describe('лента компании показывает только её события', () => {
  it('ручка принимает компанию', () => {
    expect(route).toMatch(/companyId: z\.string\(\)\.optional\(\)/)
  })

  it('и фильтрует по ней', () => {
    // Саботаж: убрать условие — вернутся чужие компании, молча.
    const line = route.split('\n').find((l) => l.includes('conds.push(eq(notifications.companyId, companyId))'))
    expect(line, 'фильтр по компании исчез').toBeTruthy()
    expect(line!.trimStart().startsWith('//'), 'фильтр закомментирован').toBe(false)
  })

  it('счётчик считает то же, что показывает список', () => {
    // Иначе «5» в бейдже откроет три уведомления, и человек будет искать
    // пропавшие два.
    const at = route.indexOf('const counts = await db')
    expect(route.slice(at, at + 700)).toMatch(/companyId \? eq\(notifications\.companyId, companyId\) : undefined/)
  })

  it('клиент передаёт компанию и держит её в ключе', () => {
    // Без компании в ключе переключение компаний покажет старые данные из
    // кэша — и это выглядит тем же багом.
    expect(inbox).toMatch(/queryKey: \['inbox', companyId \?\? 'all'\]/)
    expect(inbox).toMatch(/companyId=\$\{encodeURIComponent\(companyId\)\}/)
  })
})

describe('объявления компании видны в ленте', () => {
  it('соединение с проектами — левое, а не внутреннее', () => {
    // У объявления проекта нет вовсе: innerJoin выбрасывал его из ленты
    // молча — уведомление создано, человек его не видит.
    const at = route.indexOf('const rows = await db')
    const fn = route.slice(at, at + 800)
    expect(fn).toMatch(/\.leftJoin\(projects, eq\(projects\.id, notifications\.projectId\)\)/)
    expect(fn, 'вернулось внутреннее соединение').not.toMatch(/\.innerJoin\(projects/)
  })

  it('имя проекта необязательно', () => {
    expect(route).toMatch(/projectName: r\.project\?\.name \?\? null/)
  })

  it('клиент не рисует пустую подпись', () => {
    expect(inbox).toMatch(/!projectId && n\.projectName &&/)
  })
})

describe('колокольчик остаётся глобальным', () => {
  it('он про человека, а не про компанию', () => {
    // Висит в шапке над всеми компаниями: человек ждёт от него «всё, что мне
    // пришло». Сузить его до компании значило бы прятать чужие уведомления
    // там, где их и ищут.
    const bell = readFileSync(
      join(import.meta.dirname, '../../../app/src/components/NotificationBell.tsx'),
      'utf8',
    )
    expect(bell).toMatch(/queryKey: \['inbox'\]/)
    expect(bell).not.toMatch(/companyId=\$\{/)
  })
})
