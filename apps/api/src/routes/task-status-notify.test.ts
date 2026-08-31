import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Кого уведомляют, когда у задачи меняется статус.
//
// Долго уведомляли только исполнителя, и самый обычный случай выпадал целиком:
// я поставил задачу Талю, Таль перевёл её в ревью — и я об этом не узнаю, хотя
// ревью ждут именно от меня. Заказчик работы молча оставался в неведении о её
// ходе, а узнавал, только зайдя на доску сам.
//
// Ошибка тихая с обеих сторон: тот, кто менял статус, видит, что всё прошло;
// тот, кто ждал, просто не получает письма и не знает, что должен был.

const src = readFileSync(join(import.meta.dirname, 'tasks.ts'), 'utf8')
const bridge = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')

/**
 * Блок уведомления о смене статуса.
 *
 * Границы ищем по КОДУ, а не отступом в N символов: срез фиксированной длины
 * сползал от каждого добавленного комментария, и тест падал на исправном
 * правиле. Берём от объявления получателей до конца вызова notify.
 */
const block = (() => {
  const start = src.indexOf('const statusRecipients')
  expect(start, 'блок уведомления о смене статуса не найден').toBeGreaterThan(-1)
  const end = src.indexOf('if (opts.mentions)', start)
  expect(end, 'конец блока не найден').toBeGreaterThan(start)
  return src.slice(start, end)
})()

describe('смена статуса', () => {
  it('уведомляет и исполнителя, и автора задачи', () => {
    expect(block).toMatch(/task\.assigneeId, task\.createdById/)
  })

  it('не падает, когда исполнителя нет', () => {
    // Задача без исполнителя — обычное дело: автор всё равно должен узнать.
    // Без фильтра по null в получателях оказался бы undefined.
    expect(block).toMatch(/\.filter\(\(id\): id is string => Boolean\(id\)\)/)
    expect(block).toMatch(/statusRecipients\.length/)
  })

  it('ключ дедупа не содержит id получателя', () => {
    // notify дописывает его сам; лишний id внутри ключа склеил бы автора с
    // исполнителем и один из них уведомления не получил бы.
    expect(block).toMatch(/dedupeKey: `task_status:\$\{task\.id\}:\$\{task\.status\}`/)
    expect(block).not.toMatch(/dedupeKey: `task_status:[^`]*assigneeId/)
  })
})

describe('«готово» не уведомляет', () => {
  it('done исключён из уведомлений о статусе', () => {
    // Остальные переходы значат «нужно твоё участие»; done значит обратное —
    // участие больше не нужно, и делать с этим нечего.
    //
    // Замер на живых данных: из 304 уведомлений о статусе 111 приходились на
    // done, и 70 из них никто не открыл. У одного человека мимо прошли 95%.
    // Остальные статусы читают — непрочитанных почти нет.
    //
    // Саботаж: убрать !isDone — вернутся 111 уведомлений, которые никто не
    // читает, и счётчик инбокса снова начнёт расти впустую.
    expect(block, 'done снова уведомляет').toMatch(/!isDone/)
    expect(block).toMatch(/const isDone = task\.status === 'done'/)
  })

  it('то же правило у ассистента в чате', () => {
    // Ассистент двигает статусы из чата своим путём. Забыв здесь, мы вернули
    // бы половину шума — и заметили бы это только по счётчику.
    const memory = readFileSync(join(import.meta.dirname, '../lib/memory.ts'), 'utf8')
    expect(memory, 'ассистент шлёт уведомление о done').toMatch(
      /opts\.statusChanged && task\.status !== 'done'/,
    )
  })
})

describe('уведомление знает свою компанию', () => {
  it('companyId проставляется при создании', () => {
    // Инбокс отбирает по company_id: без него уведомление не попадает в ленту
    // НИКОГДА, но исправно считается в счётчике сайдбара. Человек видит «1»,
    // открывает проект — и не находит ничего.
    //
    // Так и случилось: колонку добавили миграцией 0093 и заполнили прошлые
    // записи, а в notify() проставить забыли. 103 уведомления родились
    // невидимыми.
    //
    // Саботаж: убрать строку — счётчик снова начнёт врать.
    const notify = readFileSync(join(import.meta.dirname, '../lib/notify.ts'), 'utf8')
    expect(notify, 'уведомление создаётся без компании').toMatch(/companyId: project\.companyId/)
  })
})

describe('оба пути ведут через одну функцию', () => {
  it('мост уведомляет тем же notifyTask, а не своей копией', () => {
    // Иначе правило пришлось бы держать в двух местах, и мост отстал бы —
    // ровно так уже случалось с гайдом.
    const calls = bridge.match(/notifyTask\(/g) ?? []
    expect(calls.length, 'мост должен звать общий notifyTask').toBeGreaterThanOrEqual(2)
    expect(bridge).not.toMatch(/event: 'task_status'/)
  })
})
