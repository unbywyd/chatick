import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CODE_TTL_MS, SESSION_TTL_MS, IDLE_TTL_MS } from './bridge-auth.js'

// Сроки жизни туннеля.
//
// Здесь важна не «правильность» чисел, а то, что дорого стоит их молчаливое
// уменьшение: туннель, умерший посреди многошаговой работы, оставляет
// полуфабрикат — задачу без чеклиста, который упал с 401. Откатывать это
// приходится человеку руками.

const src = readFileSync(join(import.meta.dirname, '../routes/bridge.ts'), 'utf8')
const docs = readFileSync(join(import.meta.dirname, 'bridge-docs.ts'), 'utf8')

describe('сроки', () => {
  it('простой измеряется часами, а не минутами', () => {
    // Два часа убивали туннель на обеденном перерыве: по журналу сессии жили
    // 27, 32 и 184 минуты и умирали именно от простоя.
    expect(IDLE_TTL_MS).toBeGreaterThanOrEqual(8 * 3600_000)
  })

  it('простой не длиннее потолка — иначе он не значит ничего', () => {
    expect(IDLE_TTL_MS).toBeLessThanOrEqual(SESSION_TTL_MS)
  })

  it('код на подтверждение переживает отлучку, но не ночь', () => {
    // Десяти минут не хватало: пока человек дошёл до браузера, код мёртв.
    // Но код предъявительский и ждёт первого, кто его подтвердит, — сутками
    // такое окно держать незачем.
    expect(CODE_TTL_MS).toBeGreaterThanOrEqual(60 * 60_000)
    expect(CODE_TTL_MS).toBeLessThanOrEqual(12 * 3600_000)
  })
})

describe('клиент узнаёт срок заранее, а не по 401', () => {
  it('на каждом ответе есть остаток времени', () => {
    expect(src).toMatch(/x-tunnel-expires-in/)
    expect(src).toMatch(/x-tunnel-expires-at/)
  })

  it('заголовки ставятся ПОСЛЕ обработки, иначе ответа ещё нет', () => {
    const mw = src.slice(src.indexOf("bridgeRoute.use('/*'"), src.indexOf('const auth = (c:'))
    expect(mw).toMatch(/await next\(\)/)
  })

  it('срок отдаётся сразу с токеном', () => {
    const poll = src.slice(src.indexOf("bridgeRoute.post('/device/poll'"))
    expect(poll).toMatch(/expiresAt/)
    expect(poll).toMatch(/idleTimeoutSec/)
  })

  it('гайд велит проверять остаток перед многошаговой работой', () => {
    expect(docs).toMatch(/CHECK IT BEFORE STARTING ANYTHING MULTI-STEP/)
  })

  it('в гайде указаны те же числа, что в коде', () => {
    // Разошедшиеся числа хуже отсутствующих: ассистент планирует по ним работу.
    expect(docs).toMatch(new RegExp(`after ${SESSION_TTL_MS / 3600_000}h`))
    expect(docs).toMatch(new RegExp(`after ${IDLE_TTL_MS / 3600_000}h idle`))
  })
})
