#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { type Scope } from './bridge.js'
import { currentScope } from './auth.js'
import { createChatickServer } from './tools.js'

/**
 * Программа MCP на машине человека (stdio). Все инструменты — в tools.ts:
 * тот же код работает и как MCP по адресу на сервере.
 */
/**
 * Токен для вызова. Если его нет — не молчим и не падаем, а объясняем, что
 * делать: инструмент, ответивший «Unauthorized», отправляет модель гадать.
 */
async function need(): Promise<Scope> {
  const scope = await currentScope()
  if (!scope) {
    throw new Error('Not connected to Chatick. Call chatick_connect first — it takes a few seconds.')
  }
  return scope
}

const server = createChatickServer({ need, local: true })
const transport = new StdioServerTransport()
await server.connect(transport)
