import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Репорты от ассистента: чего не хватило, что сломалось, о чём попросил человек.
//
// Канал в одну сторону и без человека на нашем конце в момент отправки, поэтому
// проверяем не «доходит ли», а то, что он не превратится в мусоропровод:
// репорт без контекста разобрать нечем, поток без потолка забьёт ящик, а
// обещание «починим» ассистент раздаст сам, если ему не сказать обратного.

const here = import.meta.dirname
const lib = readFileSync(join(here, 'assistant-report.ts'), 'utf8')
const docs = readFileSync(join(here, 'bridge-docs.ts'), 'utf8')
const route = readFileSync(join(here, '../routes/bridge.ts'), 'utf8')
const about = readFileSync(join(here, '../routes/about.ts'), 'utf8')
const mcp = readFileSync(join(here, '../../../mcp/src/index.ts'), 'utf8')

describe('репорт нельзя прислать пустым', () => {
  it('короткий текст отклоняется', () => {
    // «Не работает» от ассистента бесполезнее, чем от человека: переспросить
    // его потом будет некому.
    expect(lib).toMatch(/body\.length < 30/)
  })

  it('есть верхняя граница', () => {
    expect(lib).toMatch(/body\.length > 5000/)
  })
})

describe('поток ограничен', () => {
  it('счёт идёт по человеку, а не по адресу', () => {
    // Ассистент ходит с сервера: по IP все туннели слились бы в один, и один
    // болтливый клиент закрыл бы канал остальным.
    const rate = lib.slice(lib.indexOf('const [{ recent }]'))
    expect(rate.slice(0, rate.indexOf('if (recent'))).toMatch(/feedback\.userId\} = \$\{input\.user\.id\}/)
  })

  it('потолок в час задан числом, а не по вкусу вызывающего', () => {
    expect(lib).toMatch(/const HOURLY_LIMIT = \d+/)
    expect(lib).toMatch(/recent >= HOURLY_LIMIT/)
  })

  it('превышение отвечает 429, а не тихо глотает', () => {
    expect(lib).toMatch(/status: 429/)
  })
})

describe('репорт подписан человеком, а не ассистентом', () => {
  it('автор — владелец туннеля', () => {
    // Иначе непонятно, кому отвечать и у скольких людей та же боль.
    expect(lib).toMatch(/email: input\.user\.email/)
    expect(lib).toMatch(/userId: input\.user\.id/)
  })

  it('в базе видно, что писал ассистент', () => {
    // Репорты ассистента читают иначе: он пишет чаще и с другой стороны.
    expect(lib).toMatch(/source: 'assistant'/)
  })

  it('в письме тоже видно', () => {
    const n = lib.slice(lib.indexOf('async function notify'))
    expect(n).toMatch(/через ассистента/)
  })
})

describe('контекст доезжает до того, кто разбирает', () => {
  it('сохраняется в meta', () => {
    expect(lib).toMatch(/context: input\.context\?\.slice/)
  })

  it('попадает в тело письма, а не только в базу', () => {
    // Иначе репорт «не хватает ручки» разбирают переспросами, а спросить уже
    // не у кого.
    const n = lib.slice(lib.indexOf('async function notify'))
    expect(n).toMatch(/что пытались сделать/)
  })
})

describe('ассистент не обещает того, чего не будет', () => {
  it('ответ ручки прямо это запрещает', () => {
    const h = route.slice(route.indexOf("bridgeRoute.post('/report'"))
    expect(h.slice(0, h.indexOf('\n})'))).toMatch(/do not promise the person a fix or a date/i)
  })

  it('и гайд, и описание инструмента говорят то же', () => {
    expect(docs).toMatch(/never promise the person a fix or a date/i)
    expect(mcp).toMatch(/never\s+' \+\s*\n\s*'promise the person a fix or a date|never promise the person a fix or a date/i)
  })
})

describe('репорт про Chatick, а не про чужой проект', () => {
  it('гайд отделяет одно от другого', () => {
    // Иначе канал превращается в свалку задач чужой команды, которые нам
    // чинить нечем.
    expect(docs).toMatch(/Do not use it for anything about the person's own project/i)
  })

  it('проект не обязателен', () => {
    // Самые ценные репорты приходят оттуда, где ассистент не смог ничего
    // сделать — выбирать проект не в чем.
    const h = route.slice(route.indexOf("bridgeRoute.post('/report'"))
    expect(h.slice(0, h.indexOf('\n})'))).not.toMatch(/resolveProject/)
  })
})

describe('разбор входящего закрыт от посторонних', () => {
  it('список и пометка требуют админа платформы', () => {
    // Роль владельца в своей компании к чужим обращениям отношения не имеет.
    const guard = about.slice(about.indexOf('async function platformAdmin'))
    expect(guard.slice(0, guard.indexOf('}\n'))).toMatch(/me\?\.isAdmin/)
    expect(about).toMatch(/aboutRoute\.get\('\/feedback'/)
    expect(about).toMatch(/aboutRoute\.patch\('\/feedback\/:id'/)
  })

  it('«сделано» — отдельный статус, не «ответили»', () => {
    // На просьбу можно ответить и не сделать; внедрённое не всегда требует
    // ответа. Без различия список улучшений неотличим от списка вопросов.
    expect(about).toMatch(/'new', 'read', 'answered', 'done'/)
  })
})
