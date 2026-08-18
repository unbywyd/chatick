import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Таблица задач: колонки не должны разъезжаться между строками.
//
// Права считаются на КАЖДУЮ задачу (canEditTask: свою правлю, чужую нет), а
// заголовок таблицы один. Пока ячейку ручки рисовали по правам строки, у
// своих задач она была, у чужих нет — и всё, что правее, съезжало на колонку:
// точки шли через одну, исполнители прыгали из столбца в столбец.

const here = import.meta.dirname
const src = readFileSync(join(here, '../../../app/src/components/tabs/tasks/TasksTable.tsx'), 'utf8')

const tableRow = (() => {
  const from = src.indexOf('function TableRow(')
  return src.slice(from, src.indexOf('\n}\n', from))
})()

describe('колонки не разъезжаются', () => {
  it('ячейка ручки рисуется по колонке, а не по правам строки', () => {
    // showDrag приходит от заголовка; canEdit решает лишь, класть ли в неё
    // кнопку. Условие по canEdit убрало бы саму ячейку.
    expect(tableRow).toMatch(/\{showDrag && \(/)
    expect(tableRow).not.toMatch(/\{canEdit && \(\s*\n\s*<td className="w-6 ps-1">/)
  })

  it('строка получает showDrag от таблицы, а не решает сама', () => {
    expect(src).toMatch(/showDrag=\{canEdit\}/)
  })

  it('заголовок и ячейка объявляются одним и тем же признаком', () => {
    // Заголовок: {canEdit && <th className="w-6" />}. Если признаки
    // разойдутся, колонок в шапке и в строке будет разное число.
    expect(src).toMatch(/\{canEdit && <th className="w-6" \/>\}/)
  })

  it('showDrag обязателен — не опциональный проп', () => {
    // С «?» его забыли бы передать, и ячейка молча исчезла бы снова.
    expect(src).toMatch(/showDrag: boolean\b/)
    expect(src).not.toMatch(/showDrag\?: boolean/)
  })
})

describe('номер задачи не рвётся на две строки', () => {
  it('перенос запрещён', () => {
    // «TASK-8» вставало в две строки, и строка таблицы делалась вдвое выше
    // соседних.
    // Не первое вхождение: {task.number} встречается ещё и в DragOverlay.
    const at = src.indexOf('align-middle text-xs tabular-nums')
    expect(at, 'ячейка номера на месте').toBeGreaterThan(-1)
    expect(src.slice(Math.max(0, at - 200), at)).toMatch(/<td className="whitespace-nowrap/)
  })
})
