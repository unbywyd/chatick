import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * «Недавно прочитанное» в инбоксе моста.
 *
 * Дыра, которую это закрывает: человек читает уведомление в интерфейсе, оно
 * перестаёт быть непрочитанным — и для ассистента исчезает совсем. На вопрос
 * «что мне только что написали?» он отвечает «ничего нового», хотя минуту
 * назад это было на экране.
 *
 * Ручка умела unread=0 и раньше, но MCP такого параметра не отдавал, и
 * ассистент о возможности не знал вовсе.
 */

const read = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8').replace(/\r\n/g, '\n')
const bridge = read('routes/bridge.ts')
const docs = read('lib/bridge-docs.ts')
const mcp = readFileSync(
  join(import.meta.dirname, '../../../mcp/src/index.ts'),
  'utf8',
).replace(/\r\n/g, '\n')

const handler = bridge.slice(
  bridge.indexOf("bridgeRoute.get('/inbox'"),
  bridge.indexOf("bridgeRoute.post('/inbox/read'"),
)

describe('прочитанное отдаётся отдельно от ждущего', () => {
  it('секция есть и не смешана с items', () => {
    // Смешать значило бы сказать «тебя ждут пятеро», когда четверо разобраны.
    // Саботаж: складывать recentlyRead в items — тест падает.
    expect(handler, 'секции recentlyRead нет').toContain('recentlyRead: (() => {')
    expect(handler, 'прочитанное подмешано в items').not.toMatch(/items: \[\.\.\..*recentlyRead/)
  })

  it('в выборку идут только прочитанные и только свежие', () => {
    // Без фильтра по readAt секция дублировала бы непрочитанные, а без окна —
    // натащила бы вчерашнее, к которому вопрос уже не относится.
    //
    // Саботаж: убрать любое из двух условий — тест падает.
    const at = handler.indexOf('const recentlyRead')
    expect(at, 'recentlyRead не вычисляется').toBeGreaterThan(-1)
    const block = handler.slice(at, at + 900)
    expect(block, 'берутся и непрочитанные').toMatch(/readAt\} is not null/)
    expect(block, 'нет окна по времени').toMatch(/make_interval\(mins => \$\{RECENTLY_READ_MINUTES\}\)/)
  })

  it('окно задано одной константой, а не числом по месту', () => {
    // Число, вписанное в запрос и в текст подсказки по отдельности, разойдётся
    // при первой же правке: ассистенту скажут «30 минут», а отдадут час.
    //
    // Саботаж: заменить константу на литерал — тест падает.
    expect(handler, 'окно не вынесено в константу').toMatch(/const RECENTLY_READ_MINUTES = 30/)
  })

  it('на since секция пустая', () => {
    // since спрашивает «что нового с момента X» — прочитанное в такой ответ не
    // входит по смыслу, и подмешивать его значит отвечать не на тот вопрос.
    //
    // Саботаж: убрать тернарник — тест падает.
    expect(handler, 'since не отключает секцию').toMatch(/const recentlyRead = since\s*\n?\s*\? \[\]/)
  })

  it('ограничение по количеству есть на обоих концах', () => {
    // Это контекст, а не список дел: десяти хватает, а полсотни прочитанных
    // вытеснят из внимания сами непрочитанные.
    //
    // Из базы берём с запасом (строки схлопываются по сущности), но итог
    // режем — иначе сорок разных сущностей уедут целиком.
    //
    // Саботаж: убрать slice после группировки — тест падает.
    const query = handler.slice(handler.indexOf('const recentlyRead'), handler.indexOf('return c.json'))
    expect(query, 'выборка из базы не ограничена').toContain('.limit(40)')
    expect(handler, 'итог не ограничен после группировки').toContain('[...seen.values()].slice(0, 10)')
  })

  it('строки схлопываются по сущности, а не по уведомлению', () => {
    // На одну задачу уведомлений несколько — назначили, упомянули,
    // прокомментировали. На живых данных три из пяти прочитанных вели на
    // TASK-34: тремя строками ассистент решит, что дел три.
    //
    // Саботаж: ключевать по r.n.id — тест падает.
    expect(handler, 'группировки по сущности нет').toContain('r.n.entityType && r.n.entityId')
    expect(handler, 'не сказано, сколько событий было').toContain('events: count')
  })})

describe('ассистент узнаёт о секции из всех трёх мест', () => {
  // Инструкция живёт в трёх копиях: подсказка в ответе, гайд моста и описание
  // инструмента MCP. Ассистент читает то одно, то другое — молчание любой из
  // копий означает, что секцию просто не заметят.
  it('подсказка в ответе называет секцию', () => {
    expect(handler, 'hint молчит о recentlyRead').toMatch(/"recentlyRead" is what the person read/)
  })

  it('гайд моста объясняет, зачем она', () => {
    expect(docs, 'гайд молчит о recentlyRead').toMatch(/recentlyRead/)
    // Именно «не работа» — без этого ассистент начнёт её разбирать и гасить.
    expect(docs, 'гайд не говорит, что это не работа').toMatch(/NOT work waiting for you/)
  })

  it('описание инструмента MCP тоже', () => {
    expect(mcp, 'MCP молчит о recentlyRead').toMatch(/recentlyRead/)
  })

  it('все три копии сходятся в главном', () => {
    // Саботаж: сказать в одном месте «час», в другом «30 минут» — падает.
    //
    // Переносы схлопываем: в гайде текст свёрстан в колонку, и фраза «last 30
    // minutes» разорвана посреди — для читателя это одно и то же, а тест на
    // сыром тексте падал бы на верстке, а не на смысле.
    const flat = (t: string) => t.replace(/\s+/g, " ")
    for (const [name, text] of [['hint', handler], ['гайд', docs], ['mcp', mcp]] as const) {
      expect(flat(text), `${name}: не назван срок в 30 минут`).toMatch(/30 minutes/)
    }
  })
})
