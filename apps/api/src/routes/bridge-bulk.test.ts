import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Групповая правка и удаление задач через мост.
//
// Смысл ручек — в пропускной способности: «проставь номера всем экранам»,
// «закрой весь спринт» это десятки задач, и по запросу на штуку ассистент
// упирается в лимиты и теряет середину списка.
//
// Опасность ровно одна и она не в объёме: партия не должна стать способом
// обойти проверки, которые есть у поштучной правки. Поэтому здесь проверяется
// не «работает ли», а «проверяет ли каждую задачу отдельно».

const src = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')
const docs = readFileSync(join(import.meta.dirname, '../lib/bridge-docs.ts'), 'utf8')

function handler(method: string, path: string): string {
  const start = src.indexOf(`bridgeRoute.${method}('${path}'`)
  expect(start, `ручка ${method.toUpperCase()} ${path} не найдена`).toBeGreaterThan(-1)
  const rest = src.slice(start + 20)
  const end = rest.indexOf('bridgeRoute.')
  return rest.slice(0, end === -1 ? undefined : end)
}

describe('PATCH /x/tasks/bulk', () => {
  const body = handler('patch', '/tasks/bulk')

  it('объявлена раньше /tasks/:id — иначе «bulk» уедет в параметр', () => {
    expect(src.indexOf("bridgeRoute.patch('/tasks/bulk'")).toBeLessThan(
      src.indexOf("bridgeRoute.patch('/tasks/:id'"),
    )
  })

  it('права — по тому, что меняют, как и поштучно', () => {
    // Двигать по доске может любой, кто видит задачи; переписывать — нет.
    expect(body).toMatch(/tasks\.changeStatus/)
    expect(body).toMatch(/tasks\.edit/)
    expect(body).toMatch(/statusOnly/)
  })

  it('персональные номера считаются правкой, а не перемещением', () => {
    // Иначе проставить номера всем задачам проекта смог бы любой участник.
    const line = body.match(/const statusOnly = .*/)?.[0] ?? ''
    expect(line).toMatch(/!refsById/)
  })

  it('владение проверяется у КАЖДОЙ задачи, а не один раз на партию', () => {
    // Единственная проверка до цикла означала бы: подмешал к своим чужую —
    // и она отредактирована.
    const loop = body.slice(body.indexOf('for (const key of wanted)'))
    expect(loop).toMatch(/ownsOrManages/)
  })

  it('чужие поля не проглатывает — ни в теле, ни внутри set', () => {
    expect(body).toMatch(/unknownFields\(b, BULK_FIELDS\)/)
    expect(body).toMatch(/unknownFields\(set, TASK_FIELDS\)/)
  })

  it('размер партии ограничен', () => {
    expect(body).toMatch(/BULK_MAX/)
    expect(src).toMatch(/const BULK_MAX = \d+/)
  })

  it('пустой запрос не выдаёт за успех', () => {
    expect(body).toMatch(/Nothing to update/)
    expect(body).toMatch(/non-empty array/)
  })

  it('уведомления и журнал — как при поштучной правке', () => {
    // Партия не повод молча менять чужую задачу.
    expect(body).toMatch(/notifyTask/)
    expect(body).toMatch(/unassignNotice/)
    expect(body).toMatch(/logActivity/)
  })

  it('провалы возвращаются вместе с успехами', () => {
    // «ok» на запрос, где половина задач не нашлась, — худший исход:
    // ассистент доложит о сделанном, а сделана будет половина.
    expect(body).toMatch(/failed/)
    expect(body).toMatch(/errors: failed/)
  })
})

describe('DELETE /x/tasks/bulk', () => {
  const body = handler('delete', '/tasks/bulk')

  it('объявлена раньше /tasks/:id', () => {
    expect(src.indexOf("bridgeRoute.delete('/tasks/bulk'")).toBeLessThan(
      src.indexOf("bridgeRoute.delete('/tasks/:id'"),
    )
  })

  it('право считается по каждой задаче: своя — участнику, чужая — только с tasks.delete', () => {
    const loop = body.slice(body.indexOf('for (const raw of'))
    expect(loop).toMatch(/ownsOrManages/)
    expect(loop).toMatch(/own \? 'tasks\.create' : 'tasks\.delete'/)
  })

  it('удаление мягкое — это то, что делает партию допустимой', () => {
    // Жёсткое удаление пачкой одним запросом было бы не тем же действием.
    expect(body).toMatch(/deletedAt: new Date\(\)/)
    expect(body).toMatch(/restorableForDays: 7/)
    expect(body).not.toMatch(/db\.delete\(/)
  })

  it('размер партии ограничен тем же потолком', () => {
    expect(body).toMatch(/BULK_MAX/)
  })

  it('пишет в журнал и снимает уведомления', () => {
    expect(body).toMatch(/logActivity/)
    expect(body).toMatch(/unassignNotice/)
  })

  it('провалы видны в ответе', () => {
    expect(body).toMatch(/errors: failed/)
  })
})

// Список задач — вход для групповых ручек: ассистент сначала находит задачи,
// потом отдаёт их номера в bulk. Поэтому важны две вещи, которых раньше не
// было: честность про обрезание и возможность не тянуть описания.
describe('GET /x/tasks как источник для групповых ручек', () => {
  const body = handler('get', '/tasks')

  it('говорит, сколько задач подошло, а не только сколько отдал', () => {
    // Иначе спринт из шестидесяти приезжает полусотней, и «закрыл весь
    // спринт» означает «закрыл пятьдесят из шестидесяти».
    expect(body).toMatch(/total/)
    expect(body).toMatch(/count\(\*\)::int/)
  })

  it('обрезание помечено явным признаком, а не «сравни два числа»', () => {
    expect(body).toMatch(/truncated: total > rows\.length/)
  })

  it('краткий вид не тащит описания и вложения', () => {
    const brief = body.slice(body.indexOf("fields') === 'brief'"))
    expect(brief).toMatch(/number: r\.t\.number/)
    expect(brief).toMatch(/title: r\.t\.title/)
    // Ради этого всё и делалось: описания — основная масса ответа.
    const upToReturn = brief.slice(0, brief.indexOf('})'))
    expect(upToReturn).not.toMatch(/description/)
    expect(upToReturn).not.toMatch(/attachments/)
  })

  it('краткий вид сохраняет номер и refs — по ним и выбирают', () => {
    const brief = body.slice(body.indexOf("fields') === 'brief'"))
    expect(brief).toMatch(/refs: r\.t\.refs/)
  })

  it('краткий вид тоже сообщает про обрезание', () => {
    const brief = body.slice(body.indexOf("fields') === 'brief'"))
    expect(brief).toMatch(/truncated/)
  })
})

describe('гайд для ассистента', () => {
  it('обе ручки перечислены', () => {
    expect(docs).toMatch(/PATCH  \/x\/tasks\/bulk/)
    expect(docs).toMatch(/DELETE \/x\/tasks\/bulk/)
  })

  it('объясняет, чем set отличается от refs', () => {
    // Иначе номера будут проставлены всем одинаковые.
    expect(docs).toMatch(/what is the same for every task/)
    expect(docs).toMatch(/what differs per task/)
  })

  it('требует читать errors перед докладом', () => {
    expect(docs).toMatch(/ALWAYS read "errors"/)
  })

  it('велит спросить человека перед удалением собранного списка', () => {
    expect(docs).toMatch(/confirm with the human/)
  })

  it('предупреждает про обрезанный список', () => {
    // Молчаливое обрезание читается как полнота — здесь это стоит дороже
    // всего, потому что из этого списка собирают групповой запрос.
    expect(docs).toMatch(/CHECK IT before acting on "all of them"/)
  })

  it('объясняет краткий вид и зачем он', () => {
    expect(docs).toMatch(/fields=brief/)
    expect(docs).toMatch(/picking\s+tasks rather than reading them/)
  })

  it('предупреждает, что список отдаёт 200, а партия принимает 100', () => {
    expect(docs).toMatch(/list allows 200 and bulk allows/)
  })
})
