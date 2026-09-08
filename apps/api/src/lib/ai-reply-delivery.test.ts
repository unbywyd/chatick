import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Ответ ассистента должен ДОЕХАТЬ до экрана, а не только родиться.
 *
 * «Ассистент отвечает минутами» — замер по временным меткам в базе показал
 * 3–4 секунды на ответ. Минуты уходили не в модели: ответ приходит на экран
 * только событием в сокет, а при переподключении сокета клиент ничего не
 * перечитывал. Событие, ушедшее в закрытое соединение, терялось; ответ лежал
 * в базе, «ИИ думает» висело до 90-секундной страховки.
 *
 * Вторая половина — цена: 64 инструмента без кеша промпта давали 22 500
 * токенов входа на ответ в 50 токенов, и так на каждом из 12 кругов.
 */

const api = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8').replace(/\r\n/g, '\n')
const app = (p: string) =>
  readFileSync(join(import.meta.dirname, '../../../app/src/', p), 'utf8').replace(/\r\n/g, '\n')

const socket = app('hooks/useProjectSocket.ts')
const llm = api('lib/llm.ts')
const messages = api('routes/messages.ts')

describe('пропущенный ответ подбирается после реконнекта', () => {
  it('onopen после обрыва перечитывает ленту', () => {
    // Саботаж: убрать invalidateQueries из onopen — тест падает.
    const at = socket.indexOf('ws.onopen')
    expect(at, 'onopen исчез').toBeGreaterThan(-1)
    const block = socket.slice(at, at + 1400)
    expect(block, 'после реконнекта лента не перечитывается').toMatch(
      /if \(reconnected\) qc\.invalidateQueries\(\{ queryKey: \['messages', projectId\] \}\)/,
    )
  })

  it('первое соединение ленту не дёргает', () => {
    // Лента и так грузится; лишний запрос при каждом входе в проект — шум.
    // Саботаж: invalidate безусловно — тест падает.
    const at = socket.indexOf('ws.onopen')
    const block = socket.slice(at, at + 1400)
    expect(block, 'reconnected не отличается от первого входа').toMatch(/const reconnected = attempt > 0/)
    expect(block, 'attempt сбрасывается ДО проверки').not.toMatch(/attempt = 0[\s\S]{0,40}const reconnected/)
  })
})

describe('промпт ассистента кешируется', () => {
  it('метка cache_control стоит на инструментах и системном промпте', () => {
    // 64 инструмента ≈ 4000 токенов описаний плюс промпт — на каждом из 12
    // кругов заново. Саботаж: убрать cache_control — тест падает.
    const at = llm.indexOf('const cachedTools')
    expect(at, 'кеширование инструментов исчезло').toBeGreaterThan(-1)
    expect(llm, 'инструменты без cache_control').toMatch(/idx === tools\.length - 1 \? \{ \.\.\.\(t as object\), cache_control: \{ type: 'ephemeral' \} \}/)
    expect(llm, 'системный промпт без cache_control').toMatch(/text: opts\.system, cache_control: \{ type: 'ephemeral' \}/)
  })

  it('в запрос уходят кешированные версии, а не исходные', () => {
    // Собрать cachedTools и отправить tools — типичная ошибка при правке.
    const at = llm.indexOf('const cachedTools')
    const req = llm.slice(at, at + 1200)
    expect(req, 'в запрос уходят некешированные инструменты').toMatch(/tools: cachedTools/)
    expect(req, 'в запрос уходит некешированный промпт').toMatch(/system: cachedSystem/)
  })

  it('у вызова есть таймаут', () => {
    // Провайдер, отвечающий бесконечно, не должен держать спиннер навсегда.
    // Саботаж: убрать signal — тест падает.
    const at = llm.indexOf('const cachedTools')
    expect(llm.slice(at, at + 1200), 'запрос без таймаута').toMatch(/signal: AbortSignal\.timeout\(/)
  })
})

describe('время ответа и круги пишутся в лог', () => {
  // Без этого «где лупится» не отвечается: искать пришлось по меткам в базе.
  it('сервер логирует длительность каждого ответа', () => {
    expect(messages, 'тайминг ответа не логируется').toMatch(/console\.log\(`\[ai-chat\] \$\{Date\.now\(\) - startedAt\}ms/)
  })
  it('цикл инструментов логирует круги и токены', () => {
    expect(llm, 'круги не логируются').toMatch(/\[llm\] tools done: rounds=\$\{i \+ 1\} in=\$\{acc\.tokensIn\}/)
  })
})
