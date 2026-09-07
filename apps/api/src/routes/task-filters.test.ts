import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Фильтры «что не в порядке» в списке задач.
 *
 * Отвечают на вопросы, ради которых список и открывают: что стоит, что забыли,
 * почему человек простаивает. Без них ассистент вытягивал полсотни задач и
 * перебирал их сам — на живом проекте 223 открытых ради трёх просроченных.
 *
 * Правила ОДИНАКОВЫ в мосте и у ассистента в интерфейсе. Разойдись они, и
 * человек получил бы разные ответы от бота в чате и от помощника в редакторе,
 * глядя на одну и ту же доску.
 */

const read = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8').replace(/\r\n/g, '\n')
const bridge = read('routes/bridge.ts')
const memory = read('lib/memory.ts')
const docs = read('lib/bridge-docs.ts')
const mcp = readFileSync(join(import.meta.dirname, '../../../mcp/src/index.ts'), 'utf8').replace(/\r\n/g, '\n')

const bridgeTasks = bridge.slice(
  bridge.indexOf("bridgeRoute.get('/tasks'"),
  bridge.indexOf("bridgeRoute.get('/tasks/:id'"),
)
const listTasks = memory.slice(memory.indexOf('list_tasks: async'), memory.indexOf('get_task: async'))

describe('фильтры считают одно и то же в обоих местах', () => {
  it('без оценки — проверка на ЧИСЛО, а не на наличие', () => {
    // estimate_minutes это ТЕКСТ: пустая строка встречается наравне с null, и
    // `is not null` посчитал бы её оценкой.
    //
    // Саботаж: заменить на `is null` — тест падает.
    const rule = /estimateMinutes\} is null or \$\{tasks\.estimateMinutes\} !~ '\^\[0-9\]\+\$'/
    expect(bridgeTasks, 'мост: оценка проверяется не на число').toMatch(rule)
    expect(listTasks, 'ассистент: оценка проверяется не на число').toMatch(rule)
  })

  it('заблокированные — по живому блокеру, как замочек в интерфейсе', () => {
    // Связь переживает закрытие задачи намеренно. Без фильтра по статусу
    // блокера сюда попала бы давно расшитая работа.
    //
    // Саботаж: убрать bt.status <> 'done' — тест падает.
    for (const [name, text] of [['мост', bridgeTasks], ['ассистент', listTasks]] as const) {
      const at = text.indexOf('blocked_task_id')
      expect(at, `${name}: фильтра blocked нет`).toBeGreaterThan(-1)
      expect(text.slice(at - 200, at + 200), `${name}: считаются закрытые блокеры`).toMatch(
        /bt\.status <> 'done' and bt\.deleted_at is null/,
      )
    }
  })

  it('«давно не трогали» — число дней, а не зашитый порог', () => {
    // «Застряло» для спринта и для годового проекта — разные сроки, и
    // придумывать один за человека незачем.
    //
    // Саботаж: заменить на фиксированные 14 дней — тест падает.
    for (const [name, text] of [['мост', bridgeTasks], ['ассистент', listTasks]] as const) {
      expect(text, `${name}: срок застоя зашит числом`).toMatch(/make_interval\(days => \$\{Math\.min\(365/)
    }
  })

  it('фильтры не показывают закрытые задачи', () => {
    // Просроченная закрытая задача никого не волнует, а «давно не трогали» у
    // сделанной — норма.
    //
    // Саботаж: убрать ограничение по статусу — тест падает.
    expect(bridgeTasks, 'мост: фильтры не отсекают закрытые').toMatch(
      /notInArray\(tasks\.status, \['done', 'verified'\]\)/,
    )
    expect(listTasks, 'ассистент: фильтры не отсекают закрытые').toMatch(
      /status\} not in \('done', 'verified'\)/,
    )
  })

  it('явный status важнее неявного «незакрытые»', () => {
    // Спросили status=done вместе с overdue — честнее вернуть пусто, чем
    // молча подменить список на открытые.
    //
    // Саботаж: у ассистента добавлять ограничение всегда — тест падает.
    expect(listTasks, 'ассистент затирает явно заданный статус').toMatch(/if \(!status\) conds\.push/)
  })
})

describe('ассистент в интерфейсе умеет спрашивать про человека', () => {
  it('assignee принимает имя, «me» и «ничьи»', () => {
    // Спрашивают «что у Алекса», а не «что у пользователя nYVwZN6».
    // Саботаж: убрать ветку поиска по имени — тест падает.
    expect(listTasks, 'нет «me»').toMatch(/who === 'me'/)
    expect(listTasks, 'нет ничьих задач').toMatch(/who === 'none'/)
    expect(listTasks, 'имя не ищется среди участников проекта').toMatch(/projectMembers/)
  })

  it('двусмысленное имя не угадывается', () => {
    // Двое подходят под «Даниэль» — переспросить дешевле, чем показать не того
    // человека и получить решение по чужим данным.
    //
    // Саботаж: брать первого найденного — тест падает.
    expect(listTasks, 'при совпадении нескольких берётся первый').toMatch(/found\.length > 1/)
    expect(listTasks, 'ищет без запаса на проверку двусмысленности').toMatch(/\.limit\(2\)/)
  })
})

describe('про фильтры сказано всем троим читателям', () => {
  // Ассистент читает то описание инструмента, то гайд — молчание любой копии
  // означает, что фильтрами просто не воспользуются.
  for (const name of ['blocked', 'stale', 'noEstimate', 'overdue']) {
    it(`${name} назван в гайде и в MCP`, () => {
      expect(docs, `гайд молчит про ${name}`).toContain(name)
      expect(mcp, `MCP молчит про ${name}`).toContain(name)
    })
  }

  it('у ассистента в интерфейсе они тоже описаны', () => {
    const tool = memory.slice(memory.indexOf("name: 'list_tasks'"), memory.indexOf("name: 'announce'"))
    for (const name of ['blocked', 'stale', 'noEstimate', 'overdue', 'assignee']) {
      expect(tool, `описание list_tasks молчит про ${name}`).toContain(name)
    }
  })
})
