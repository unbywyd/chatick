import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/**
 * Хук после условного return = React #310.
 *
 * «Rendered more hooks than during the previous render»: при одном состоянии
 * условный выход срабатывает и хук не выполняется, при другом выполняется.
 * Число хуков между отрисовками меняется, и React падает.
 *
 * На StartScreen ветка была «новичок в мастере настройки» — падало ровно у
 * тех, кто зашёл впервые, и в тестах не показывалось никак.
 *
 * Разбор настоящим парсером, а не по отступам: первая версия этой проверки
 * считала границей компонента строку, начинающуюся с `}` — и принимала за
 * неё `}) {` в конце многострочной сигнатуры с деструктуризацией. Настоящий
 * баг она пропускала, то есть была хуже, чем её отсутствие.
 */
/**
 * Пути считаем от самого скрипта, а не от текущей папки.
 *
 * Скрипт зовут из двух мест: из apps/app (сборка) и из корня (тесты). С
 * относительным шаблоном `git ls-files` первый случай находил НОЛЬ файлов и
 * молча проходил — зелёная проверка, не проверяющая ничего, хуже отсутствующей.
 */
const SRC = join(import.meta.dirname, '..', 'src')

function collect(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collect(full))
    else if (entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

const files = collect(SRC)
if (!files.length) {
  console.error(`Не найдено ни одного .tsx в ${SRC} — проверять нечего.`)
  process.exit(1)
}

const isHookCall = (node) =>
  ts.isCallExpression(node) &&
  ((ts.isIdentifier(node.expression) && /^use[A-Z]/.test(node.expression.text)) ||
    (ts.isPropertyAccessExpression(node.expression) && /^use[A-Z]/.test(node.expression.name.text)))

/** Компонент: функция с заглавной буквы (объявление, стрелка или выражение). */
function componentName(node) {
  if (ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text)) return node.name.text
  if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && /^[A-Z]/.test(node.name.text)) {
    if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      return node.name.text
    }
  }
  return null
}

const hits = []

function checkBody(body, file, sf, name) {
  if (!body || !ts.isBlock(body)) return
  let condReturn = null
  for (const stmt of body.statements) {
    // Условный выход на верхнем уровне тела: if (...) return / if (...) { return }
    if (!condReturn && ts.isIfStatement(stmt)) {
      const t = stmt.thenStatement
      const returnsEarly =
        ts.isReturnStatement(t) ||
        (ts.isBlock(t) && t.statements.some((s) => ts.isReturnStatement(s)))
      if (returnsEarly) condReturn = stmt
    }
    if (!condReturn) continue
    // Хук ПОСЛЕ этого условного выхода — но только на верхнем уровне тела:
    // внутри вложенных функций (колбэки, обработчики) правило не действует.
    let found = null
    const walk = (n) => {
      if (found) return
      if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return
      if (isHookCall(n)) { found = n; return }
      ts.forEachChild(n, walk)
    }
    walk(stmt)
    if (found) {
      const line = sf.getLineAndCharacterOfPosition(found.getStart(sf)).line + 1
      const condLine = sf.getLineAndCharacterOfPosition(condReturn.getStart(sf)).line + 1
      hits.push(`${file}:${line} — ${name}: хук после условного return (строка ${condLine})`)
      condReturn = null
    }
  }
}

for (const file of files) {
  const src = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const visit = (node) => {
    const name = componentName(node)
    if (name) {
      const fn = ts.isFunctionDeclaration(node) ? node : node.initializer
      checkBody(fn?.body, file, sf, name)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

if (hits.length) {
  console.error('Хук стоит ПОСЛЕ условного return — React упадёт с #310:\n')
  console.error(hits.join('\n'))
  console.error('\nПеренесите хуки выше условного выхода: их число обязано')
  console.error('совпадать между отрисовками.')
  process.exit(1)
}
console.log(`Порядок хуков в порядке (проверено файлов: ${files.length}).`)
