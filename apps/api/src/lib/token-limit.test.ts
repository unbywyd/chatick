import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Ограничение длины ответа называется по-разному у разных моделей.
//
// Свежие модели OpenAI (o-серия, gpt-5 и новее) отвечают 400 на max_tokens и
// требуют max_completion_tokens. В чате это выглядело как «не получилось
// получить ответ» — человек видел общее сообщение и не мог понять, что дело в
// настройке модели.

const llm = readFileSync(join(import.meta.dirname, 'llm.ts'), 'utf8')

/** Правило из самого llm.ts — проверяем то, что работает, а не копию. */
function rule(): (m: string) => string {
  const m = llm.match(/const needsNewName = (\/.+\/)\.test\(m\)/)
  expect(m, 'правило выбора имени не найдено').toBeTruthy()
  // eslint-disable-next-line no-eval
  const re = eval(m![1]) as RegExp
  return (model: string) => (re.test(model.toLowerCase()) ? 'max_completion_tokens' : 'max_tokens')
}

describe('имя параметра выбирается по модели', () => {
  const pick = rule()

  it('новые модели OpenAI требуют max_completion_tokens', () => {
    for (const m of ['gpt-5.6-luna', 'o1-preview', 'o3-mini', 'gpt-9-future'])
      expect(pick(m), m).toBe('max_completion_tokens')
  })

  it('старые модели и прочие провайдеры — max_tokens', () => {
    // Настроены в проде прямо сейчас: ошибиться здесь значит сломать
    // работающий чат ради починки сломанного.
    for (const m of ['gpt-4o-mini', 'gpt-4-turbo', 'claude-sonnet-5', 'deepseek-v4-flash', 'llama-3.3-70b-versatile'])
      expect(pick(m), m).toBe('max_tokens')
  })
})

describe('покрыты все запросы к OpenAI-совместимым', () => {
  it('ни один /chat/completions не шлёт max_tokens напрямую', () => {
    // Саботаж: вернуть max_tokens в любой из них — чат снова отвалится на
    // новой модели, причём молча.
    for (const m of llm.matchAll(/\/chat\/completions[\s\S]{0,600}?\}\)/g)) {
      expect(m[0], 'прямой max_tokens в запросе к OpenAI').not.toMatch(/\bmax_tokens:/)
    }
  })

  it('ветка Anthropic оставлена как есть', () => {
    // Там max_tokens верен всегда, и полагаться на совпадение правила было бы
    // случайностью, а не решением.
    const at = llm.indexOf("if (p.kind === 'anthropic')")
    expect(at).toBeGreaterThan(-1)
    expect(llm.slice(at, at + 700)).toMatch(/max_tokens: opts\.maxTokens/)
  })
})
