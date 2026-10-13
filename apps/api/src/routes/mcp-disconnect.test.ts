import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// MCP — отдельный пакет; как и в task-verified-status, сверяем его исходник.
const auth = readFileSync(join(import.meta.dirname, '../../../mcp/src/auth.ts'), 'utf8')
const tools = readFileSync(join(import.meta.dirname, '../../../mcp/src/tools.ts'), 'utf8')

describe('chatick_disconnect забывает доступ по-настоящему', () => {
  it('закрывает сессию на сервере, стирает файл и память', () => {
    // Раньше чистилась только память: файл ~/.chatick/mcp-token.json
    // оставался, и следующий вызов молча подключался обратно.
    const body = auth.slice(auth.indexOf('export async function forget'))
    expect(body).toMatch(/memory = null/)
    expect(body).toMatch(/rmSync\(TOKEN_FILE, \{ force: true \}\)/)
    expect(body).toMatch(/\/x\/disconnect`, \{ method: 'POST'/)
  })

  it('инструмент ждёт забывания и только у локальной программы', () => {
    expect(tools).toMatch(/await forget\(\)/)
    // На сервере (MCP по адресу) стирать нечего — там доступ через OAuth.
    const local = tools.slice(tools.indexOf('export const LOCAL_ONLY_TOOLS'))
    expect(local).toContain("'chatick_disconnect'")
  })
})
