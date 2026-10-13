import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Сторожа правок перед выкаткой v2 (ревизия v2, фаза 1).
 *
 * Каждая проверка — по тексту кода: поломка здесь тихая (лишний доступ, обход
 * правил), и живой тест на базе её не всегда поймает.
 */

const src = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8').replace(/\r\n/g, '\n')
const mcp = readFileSync(join(import.meta.dirname, '../../../mcp/src/tools.ts'), 'utf8').replace(/\r\n/g, '\n')

describe('старый путь смены статуса подчиняется правилам мяча', () => {
  const ball = src('lib/ball.ts')
  const update = ball.slice(ball.indexOf('export async function updateTask('), ball.indexOf('export async function insertTask('))

  it('updateTask проверяет право на ход тем же mayHandoff, что и веб', () => {
    // Саботаж: убрать проверку — через MCP, ассистента и трей снова закроют чужую задачу.
    expect(update).toMatch(/mayHandoff\(plan\.handoff\.action/)
    expect(update).toMatch(/throw new HandoffRefused/)
  })

  it('каждый вызов updateTask ловит отказ', () => {
    for (const [name, file] of [
      ['мост', 'routes/bridge.ts'],
      ['ассистент', 'lib/memory.ts'],
      ['трей', 'routes/inbox.ts'],
      ['веб v1', 'routes/tasks.ts'],
    ] as const) {
      const text = src(file)
      const calls = text.split('updateTask(').length - 1
      const caught = text.split('HandoffRefused').length - 1
      expect(caught, `${name}: updateTask без обработки отказа`).toBeGreaterThanOrEqual(Math.min(calls, 1))
    }
  })

  it('трей: «готово» исполнителя уходит владельцу на проверку', () => {
    const inbox = src('routes/inbox.ts')
    expect(inbox).toMatch(/status === 'done' && owner && owner !== sub \? 'review' : status/)
  })
})

describe('секреты ресурса через MCP — тому же кругу, что в вебе', () => {
  it('три ручки файлов ресурса проверяют canSeeSecrets', () => {
    // Саботаж: убрать проверку из любой ручки — посторонний скачает ключ подписи.
    const bridge = src('routes/bridge.ts')
    for (const head of [
      "bridgeRoute.get('/resources/:id/files', async",
      "bridgeRoute.get('/resources/:id/files/:fileId', async",
      "bridgeRoute.delete('/resources/:id/files/:fileId', async",
    ]) {
      const at = bridge.indexOf(head)
      expect(at, `нет ручки ${head}`).toBeGreaterThan(-1)
      const body = bridge.slice(at, bridge.indexOf('\n})\n', at))
      expect(body, `${head}: нет проверки секретов`).toMatch(/canSeeSecrets\(/)
    }
  })
})

describe('правила чата не закрывают веб', () => {
  it('428 — только на ручках чата', () => {
    // Саботаж: вернуть проверку на весь проект — новый участник в вебе упрётся в 428.
    const auth = src('auth.ts')
    expect(auth).toMatch(/!membership\.rulesAcceptedAt && c\.req\.path\.startsWith\('\/api\/v1\/messages'\)/)
  })
})

describe('ассистент через MCP ничего не стирает', () => {
  it('chatick_request пропускает DELETE только для развязок', () => {
    expect(mcp).toMatch(/const DELETE_ALLOWED = \[/)
    expect(mcp).toMatch(/method === 'DELETE' && !DELETE_ALLOWED\.some/)
  })
})
