import { afterEach, describe, expect, it, vi } from 'vitest'
import { completeWithTools, type StreamEvent } from './llm.js'

/** Ответ провайдера потоком: SSE-строки, порезанные на произвольные куски. */
function sse(events: unknown[], chunk = 17): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
  const bytes = new TextEncoder().encode(text)
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk))
      c.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const tool = { name: 'my_ball', description: 'x', parameters: { type: 'object', properties: { view: { type: 'string' } } } }

afterEach(() => vi.unstubAllGlobals())

describe('completeWithTools потоком — Anthropic', () => {
  it('текст кусками, событие инструмента, аргументы из кусков JSON, итог — всё увиденное', async () => {
    const bodies: unknown[] = []
    const rounds = [
      sse([
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Смотрю ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'задачи…' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'my_ball' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"vi' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ew":"mine"}' } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
      ]),
      sse([
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'На тебе 3 задачи.' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
      ]),
    ]
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return rounds.shift()!
    })
    const events: StreamEvent[] = []
    const handler = vi.fn(async () => '{"items":[1,2,3]}')
    const out = await completeWithTools(
      { provider: 'anthropic', model: 'm', apiKey: 'k' },
      { system: 's', user: 'что на мне', tools: [tool], handlers: { my_ball: handler }, onEvent: (e) => events.push(e) },
    )
    expect(handler).toHaveBeenCalledWith({ view: 'mine' })
    expect(events.filter((e) => e.type === 'tool')).toEqual([{ type: 'tool', name: 'my_ball' }])
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Смотрю задачи…\n\nНа тебе 3 задачи.')
    expect(out).toBe('Смотрю задачи…\n\nНа тебе 3 задачи.')
    // запрос шёл потоком; в историю второго круга ушли чистые блоки
    expect((bodies[0] as { stream?: boolean }).stream).toBe(true)
    const second = bodies[1] as { messages: { role: string; content: unknown }[] }
    expect(second.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Смотрю задачи…' },
        { type: 'tool_use', id: 'tu1', name: 'my_ball', input: { view: 'mine' } },
      ],
    })
  })

  it('без onEvent — прежний ответ одним куском', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }), { status: 200 }),
    )
    const out = await completeWithTools({ provider: 'anthropic', model: 'm', apiKey: 'k' }, { system: 's', user: 'u', tools: [tool], handlers: {} })
    expect(out).toBe('ok')
  })
})

describe('completeWithTools потоком — OpenAI-совместимые', () => {
  it('tool_calls собираются из дельт по индексу, текст идёт кусками', async () => {
    const rounds = [
      sse([
        { choices: [{ delta: { content: 'Секунду. ' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'my_ball', arguments: '{"view":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"from-me"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
      ]),
      sse([{ choices: [{ delta: { content: 'Ждёшь от Элиши две.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]),
    ]
    vi.stubGlobal('fetch', async () => rounds.shift()!)
    const events: StreamEvent[] = []
    const handler = vi.fn(async () => '[]')
    const out = await completeWithTools(
      { provider: 'deepseek', model: 'm', apiKey: 'k' },
      { system: 's', user: 'u', tools: [tool], handlers: { my_ball: handler }, onEvent: (e) => events.push(e) },
    )
    expect(handler).toHaveBeenCalledWith({ view: 'from-me' })
    expect(events.filter((e) => e.type === 'tool')).toEqual([{ type: 'tool', name: 'my_ball' }])
    expect(out).toBe('Секунду. \n\nЖдёшь от Элиши две.')
  })
})
