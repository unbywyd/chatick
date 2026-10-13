import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import ts from 'typescript'

/**
 * Самопроверка перевода старых адресов в v2 (src/lib/v2-links.ts).
 *
 * Тестового раннера у веба нет, а заводить его ради одной чистой функции
 * несоразмерно. Модуль без импортов: транспилируем его здесь же и гоняем
 * случаи, которые реально приходят из трея, уведомлений и меню оболочки.
 *
 *   node apps/app/scripts/check-v2-links.mjs
 */
const src = readFileSync(join(import.meta.dirname, '..', 'src', 'lib', 'v2-links.ts'), 'utf8')
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { toV2Link, activeFromLocation } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

const ctx = { companyId: 'CO', companyOf: (p) => (p === 'P1' ? 'C1' : null) }
const cases = [
  // задачи: панель поверх списка
  ['/c/C1/p/P1/tasks/T1', '/c/C1?t=T1'],
  ['/c/C1/p/P1/tasks?task=T1', '/c/C1?t=T1'],
  ['/c/C1/p/P1/tasks', '/c/C1?p=P1'],
  ['/c/C1/p/P1/tasks/', '/c/C1?p=P1'],
  // чата в v2 нет — в проект
  ['/c/C1/p/P1/chat', '/c/C1?p=P1'],
  ['/c/C1/p/P1/chat?msg=M1', '/c/C1?p=P1'],
  ['/c/C1/p/P1', '/c/C1?p=P1'],
  // заметки, документы, остальные разделы
  ['/c/C1/p/P1/notes?note=N1', '/c/C1/notes/n/N1'],
  ['/c/C1/p/P1/notes/N1', '/c/C1/notes/n/N1'],
  ['/c/C1/p/P1/notes', '/c/C1/notes?p=P1'],
  ['/c/C1/p/P1/documents/D1', '/c/C1/docs/d/P1/D1'],
  ['/c/C1/p/P1/time', '/c/C1/time?p=P1'],
  ['/c/C1/p/P1/releases/R1', '/c/C1/versions?p=P1'],
  ['/c/C1/p/P1/files/F1', '/c/C1/files?p=P1'],
  ['/c/C1/p/P1/notifications', '/c/C1/settings/notifications'],
  // полный адрес из письма
  ['https://app.chatick.com/#/c/C1/p/P1/tasks/T1', '/c/C1?t=T1'],
  // совсем старое /p/<id>: компанию знаем — переводим, не знаем — как есть
  ['/p/P1/tasks/T1', '/c/C1?t=T1'],
  ['/p/P2/chat', '/p/P2/chat'],
  // без компании — берём контекст
  ['/inbox', '/c/CO/notifications'],
  ['/settings/notifications', '/c/CO/settings/notifications'],
  ['/settings/profile', '/c/CO/settings/profile'],
  ['/start', '/c/CO'],
  ['/tasks?task=T9', '/c/CO?t=T9'],
  ['/notes?note=N9', '/c/CO/notes/n/N9'],
  // уже v2 — не трогаем
  ['/c/C1?t=T1', '/c/C1?t=T1'],
  ['/c/C1/task/T1', '/c/C1/task/T1'],
  ['/c/C1/time', '/c/C1/time'],
  ['/login', '/login'],
]
for (const [from, want] of cases) assert.equal(toV2Link(from, ctx), want, `toV2Link(${from})`)

// Без компании в контексте адреса без компании не трогаем: лучше «не найдено»,
// чем чужая компания.
assert.equal(toV2Link('/settings/notifications', {}), '/settings/notifications')
assert.equal(toV2Link('/inbox'), '/inbox')

const loc = [
  [['/c/C1', '?p=P1&t=T1'], { companyId: 'C1', projectId: 'P1', taskId: 'T1' }],
  [['/c/C1/time', ''], { companyId: 'C1', projectId: null, taskId: null }],
  [['/c/C1/task/T2', ''], { companyId: 'C1', projectId: null, taskId: 'T2' }],
  [['/c/C1/task/new', ''], { companyId: 'C1', projectId: null, taskId: null }],
  [['/c/C1/p/P1/tasks/T3', ''], { companyId: 'C1', projectId: 'P1', taskId: 'T3' }],
  [['/c/C1/p/P1/chat', ''], { companyId: 'C1', projectId: 'P1', taskId: null }],
  [['/p/P1', ''], { companyId: null, projectId: 'P1', taskId: null }],
  [['/companies', ''], { companyId: null, projectId: null, taskId: null }],
]
for (const [[path, search], want] of loc) assert.deepEqual(activeFromLocation(path, search), want, `activeFromLocation(${path}${search})`)

console.log(`v2-links: ${cases.length + 2 + loc.length} проверок прошли`)
