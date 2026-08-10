// Сверка: пути, которые зовёт MCP-сервер, должны существовать в мосту.
//
// Правды теперь три: код моста, гайд и MCP-сервер. За одну сессию гайд
// отставал от кода дважды — и оба раза молча, потому что копий было две.
// Третья копия повторила бы это, да ещё на чужой машине, где никто не
// заметит: инструмент зовёт ручку, которой больше нет, и человек получает
// 404 вместо работы.
//
//   node scripts/check-mcp-sync.mjs
//
// Выход 1 — MCP зовёт то, чего в мосту нет.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bridgeSrc = join(here, '../src/routes/bridge.ts')
const mcpDir = join(here, '../../mcp/src')

// MCP может быть не установлен рядом — например, в урезанной сборке.
// Тогда сверять нечего, и это не повод ронять сборку API.
if (!existsSync(mcpDir)) {
  console.log('MCP-сервер рядом не найден — сверка пропущена.')
  process.exit(0)
}

const bridge = readFileSync(bridgeSrc, 'utf8')

/** Ручки моста: скелет пути, без имён параметров. */
const routes = new Set()
for (const m of bridge.matchAll(/bridgeRoute\.(get|post|patch|delete|put)\('([^']+)'/g)) {
  const skeleton = m[2].replace(/:[A-Za-z]+/g, '<>').replace(/\/$/, '')
  routes.add(`${m[1].toUpperCase()} ${skeleton}`)
}

/**
 * Пути, которые зовёт MCP: call(scope, 'GET', '/tasks/...').
 *
 * Шаблонные куски (`${...}`) заменяем на <>, как и параметры маршрута:
 * `/tasks/${task}/comments` и `/tasks/:id/comments` — один и тот же путь.
 */
const called = new Map()
for (const file of ['index.ts']) {
  const src = readFileSync(join(mcpDir, file), 'utf8')
  const re = /call(?:<[^>]*>)?\([^,]+,\s*'(GET|POST|PATCH|DELETE)',\s*(`[^`]+`|'[^']+')/g
  for (const m of src.matchAll(re)) {
    const raw = m[2].slice(1, -1)
    const skeleton = raw.replace(/\$\{[^}]+\}/g, '<>').replace(/\/$/, '')
    called.set(`${m[1]} ${skeleton}`, file)
  }
}

const missing = []
for (const [route, file] of called) {
  if (!routes.has(route)) missing.push(`${route}  (${file})`)
}

if (missing.length) {
  console.error(`MCP зовёт ручки, которых нет в мосту (${missing.length}):`)
  for (const r of missing.sort()) console.error(`  ${r}`)
  console.error('\nЛибо ручку переименовали/убрали в bridge.ts, либо в MCP опечатка в пути.')
  process.exit(1)
}

console.log(`MCP согласован с мостом (проверено путей: ${called.size}).`)
