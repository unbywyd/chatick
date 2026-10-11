/**
 * Для сервера: MCP по адресу (apps/api). Отдельная точка входа — index.ts при
 * импорте запустил бы stdio.
 *
 * Транспорт отдаём отсюда же: сервер MCP и транспорт должны быть из ОДНОЙ
 * копии SDK (и одной zod) — у API своя zod другой версии.
 */
export { createChatickServer, LOCAL_ONLY_TOOLS } from './tools.js'
export { setApiBase, type Scope } from './bridge.js'
export { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
export { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
