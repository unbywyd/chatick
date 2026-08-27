import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Инбокс — единственная входная точка.
 *
 * Человек спрашивает «что мне ответили?», и ассистент начинал искать. Точек
 * входа было две, и они спорили друг с другом в тексте: у /x/mentions стояло
 * «CHECK THIS BEFORE /x/inbox», у /x/inbox — «Start every check here».
 * Ассистент читал обе и выбирал наугад.
 *
 * Лечили инструкцией. Инструкцию можно не прочитать — поэтому теперь лечим
 * формой ответа: видно, что ждёт и сколько, и идти есть смысл только туда,
 * где счётчик больше нуля.
 */

const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8')
const bridge = read('bridge.ts')
const docs = read('../lib/bridge-docs.ts')
const mcp = readFileSync(join(import.meta.dirname, '../../../mcp/src/index.ts'), 'utf8')

/** Тело ручки: от объявления до следующего маршрута. */
function endpoint(src: string, head: string): string {
  const at = src.indexOf(head)
  if (at < 0) return ''
  const next = src.indexOf('Route.', at + head.length)
  return src.slice(at, next < 0 ? undefined : next)
}

const inbox = endpoint(bridge, "bridgeRoute.get('/inbox'")

describe('сводка инбокса', () => {
  it('ручка отдаёт ветки и общий счётчик', () => {
    expect(inbox, 'ручка /inbox не найдена').toBeTruthy()
    expect(inbox).toMatch(/branches,/)
    expect(inbox).toMatch(/unreadTotal:/)
  })

  it('ветки считаются агрегатом, а не по выданным строкам', () => {
    // Тридцать строк в ответе не говорят, сколько всего ждёт, — а «сколько»
    // и есть первый вопрос. Считать по items значило бы врать при limit.
    expect(inbox).toMatch(/\.groupBy\(notifications\.event\)/)
  })

  it('пустые ветки не выводятся', () => {
    // «count: 0» читается как «я проверил» и на этом успокаивает.
    expect(inbox).toMatch(/\.filter\(\(b\) => b\.count > 0\)/)
  })

  it('items сохраняют id — иначе нечем гасить', () => {
    // POST /x/inbox/read принимает ids. Без id ассистент видит, что работа
    // есть, и не может отметить её сделанной.
    expect(inbox).toMatch(/id: r\.n\.id,/)
  })

  it('подсказка больше не отсылает в mentions как в главное место', () => {
    // Ровно та фраза, из-за которой ассистент уходил из инбокса, не начав.
    expect(inbox).not.toMatch(/check that first/i)
    expect(inbox).toMatch(/Start here/)
  })
})

describe('ветки покрывают ВСЕ события', () => {
  it('ни одно событие не потеряно и лишних нет', () => {
    // Событие вне веток исчезнет из сводки молча: оно будет в items, но
    // счётчика для него никто не увидит. Ровно так однажды потерялся домен
    // releases в правах — забыли в одном месте из трёх.
    const schema = readFileSync(join(import.meta.dirname, '../db/schema.ts'), 'utf8')
    const enumBlock = schema.match(/notificationEvent = pgEnum\('notification_event', \[([\s\S]*?)\]\)/)
    expect(enumBlock, 'енум событий не найден').toBeTruthy()
    const events = new Set([...enumBlock![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]))

    const branchBlock = bridge.match(/const INBOX_BRANCHES = \[([\s\S]*?)\] as const satisfies/)
    expect(branchBlock, 'ветки не найдены').toBeTruthy()
    const mentionBlock = bridge.match(/const MENTION_EVENTS = \[([\s\S]*?)\]/)
    const covered = new Set([
      ...[...branchBlock![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
      ...[...mentionBlock![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
    ])

    for (const e of events) {
      expect(covered.has(e), `событие ${e} не попало ни в одну ветку сводки`).toBe(true)
    }
  })

  it('ветка ответов на чек-лист есть — ради неё всё и делалось', () => {
    expect(bridge).toMatch(/kind: 'answers'/)
    expect(bridge).toMatch(/events: \['checklist_answer'\]/)
  })
})

describe('гайд и MCP говорят одно и то же', () => {
  it('в гайде не осталось «сначала mentions»', () => {
    // Две инструкции, противоречащие друг другу на соседних строках, — это
    // выбор наугад, а не правило.
    expect(docs).not.toMatch(/CHECK THIS BEFORE \/x\/inbox/)
  })

  it('гайд называет инбокс единственным входом', () => {
    expect(docs).toMatch(/START HERE\. The one entry point/)
  })

  it('MCP-инструмент mentions не зовёт себя первым', () => {
    const tool = mcp.slice(mcp.indexOf("'chatick_mentions'"), mcp.indexOf("'chatick_inbox'"))
    expect(tool).not.toMatch(/CHECK THIS FIRST/)
  })

  it('MCP-инструмент inbox описывает ветки', () => {
    const from = mcp.indexOf("'chatick_inbox'")
    const tool = mcp.slice(from, from + 1600)
    expect(tool).toMatch(/branches/)
    // Гашение — по-прежнему часть договора, за этим следит и notification-read.
    expect(tool).toMatch(/chatick_inbox_read/)
  })
})
