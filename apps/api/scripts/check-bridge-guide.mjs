// Сверка: каждая ручка моста должна быть описана в гайде.
//
// Зачем. Гайда два — проектный и компанейский, и агент видит только свой.
// Ручка, попавшая в один документ, для половины подключений молча не
// существует: ассистент читает гайд, раздела не находит и делает вывод, что
// фичи нет. Так уже случилось с чек-листом.
//
// Каталог ручек теперь общий (endpointCatalog), но гайды всё ещё пишутся
// руками, и новая ручка может просто не попасть ни в один. Этот скрипт ловит
// такое до деплоя:
//
//   node scripts/check-bridge-guide.mjs
//
// Выход 1 — есть ручки без описания.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '../src/routes/bridge.ts'), 'utf8')
const docs = readFileSync(join(here, '../src/lib/bridge-docs.ts'), 'utf8')

// Ручки вида bridgeRoute.get('/tasks/:id/checklist', ...)
const routes = new Set()
for (const m of src.matchAll(/bridgeRoute\.(get|post|patch|delete|put)\('([^']+)'/g)) {
  routes.add(`${m[1].toUpperCase()} ${m[2]}`)
}

// Служебное, что описывать в каталоге незачем: корень и сам гайд.
const SKIP = new Set(['GET /', 'GET /guide'])

const missing = []
for (const route of routes) {
  if (SKIP.has(route)) continue
  const path = route.split(' ')[1]
  // :id и <id> — одно и то же для читателя; сравниваем по «скелету» пути.
  const skeleton = path.replace(/:[A-Za-z]+/g, '<>').replace(/\/$/, '')
  const found = docs
    .split('\n')
    .some((line) => line.includes('/x') && line.replace(/<[^>]*>/g, '<>').includes(`/x${skeleton}`))
  if (!found) missing.push(route)
}

if (missing.length) {
  console.error(`Ручки моста без описания в гайде (${missing.length}):`)
  for (const r of missing.sort()) console.error(`  ${r}`)
  console.error('\nДобавьте их в endpointCatalog() или в соответствующий раздел bridge-docs.ts.')
  process.exit(1)
}

console.log(`Гайд покрывает все ручки моста (${routes.size - SKIP.size}).`)
