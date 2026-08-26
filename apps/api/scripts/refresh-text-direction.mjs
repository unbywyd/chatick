// Пересчёт направления текста в уже сохранённой разметке.
//
// dir пишется один раз, при сохранении, и живёт в HTML. Поэтому исправление
// самого алгоритма не догоняет то, что написано раньше: 67 описаний задач и
// 55 комментариев остались с маркерами по разные стороны списка, а ещё
// 36 ивритских списков — целиком помеченными ltr.
//
//   node scripts/refresh-text-direction.mjs           # показать, что изменится
//   node scripts/refresh-text-direction.mjs --apply   # записать
//
// Правит ТОЛЬКО атрибут dir у блочных тегов: applyDirection не трогает ни
// текст, ни другие атрибуты. Направление, выставленное человеком руками,
// переживает пересчёт — эта проверка внутри самой функции.
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { applyDirection } from '../dist/lib/markdown.js'

const apply = process.argv.includes('--apply')

const url = (readFileSync(new URL('../.env', import.meta.url), 'utf8').match(/^DATABASE_URL=(.+)$/m) ?? [])[1]
if (!url) throw new Error('DATABASE_URL не найден в apps/api/.env')

// Колонка с разметкой → её таблица. notes и projects.about списков не
// содержат вовсе, но пересчёт им не повредит: без dir-блоков вывод совпадёт
// с входом, и строка просто не попадёт в список изменений.
const TARGETS = [
  ['tasks', 'description'],
  ['task_comments', 'body'],
  ['documents', 'content'],
  ['notes', 'body'],
  ['projects', 'about'],
]

/**
 * Снять dir у блочных тегов, чтобы посчитать заново.
 *
 * Без этого пересчёт бессмыслен: applyDirection уважает уже выставленный
 * атрибут — «ручной выбор сильнее догадки», — и старое значение осталось бы
 * на месте. Ровно та проверка, которая нужна при вводе текста, мешает при
 * пересчёте, поэтому здесь мы сначала стираем.
 *
 * Цена честная и её надо назвать вслух: направление, выставленное человеком
 * кнопкой, тоже сотрётся и будет вычислено заново. Отличить его от
 * автоматического в сохранённом HTML нельзя — атрибут один и тот же.
 * Для абзацев это чаще всего даст то же самое значение, а списки мы и правим.
 *
 * dir="auto" — исключение, его не трогаем. Это не вычисленное значение, а
 * указание браузеру решать самому; так помечает пункты редактор. Стерев его,
 * мы бы ничего не подставили взамен — строка «address: "האנגר 09"» не даёт
 * ни одного слова для подсчёта, — и пункт остался бы вовсе без направления.
 */
const BLOCKS = /<(p|h[1-6]|li|blockquote|ul|ol|td|th|div)((?:\s[^>]*)?)>/gi
const DIR_ATTR = /\sdir\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi
const strip = (html) =>
  html.replace(BLOCKS, (_m, name, attrs) => {
    // Значение сверяем в коде, а не выражением: попытка выразить «кроме auto»
    // регуляркой прошла мимо цели и молча стирала его — проверено на живых
    // строках, где auto как раз и стоит.
    const kept = (attrs ?? '').replace(DIR_ATTR, (m, v) =>
      v.replace(/^['"]|['"]$/g, '').toLowerCase() === 'auto' ? m : '',
    )
    return `<${name}${kept}>`
  })

const sql = postgres(url, { max: 1 })

let total = 0
for (const [table, column] of TARGETS) {
  const rows = await sql.unsafe(`SELECT id, ${column} AS body FROM ${table} WHERE ${column} LIKE '%<%'`)
  let changed = 0
  for (const r of rows) {
    if (!r.body) continue
    const next = applyDirection(strip(r.body))
    if (next === r.body) continue
    changed++
    if (apply) await sql.unsafe(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, [next, r.id])
  }
  total += changed
  console.log(`${table}.${column}: ${changed} из ${rows.length}`)
}

console.log(apply ? `\nЗаписано: ${total}` : `\nБудет изменено: ${total} (запуск с --apply)`)
await sql.end()
