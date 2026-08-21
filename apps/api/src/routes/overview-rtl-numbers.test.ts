import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Дроби в обзоре компании не переворачиваются на иврите.
 *
 * «231 / 480» (сделано из всего) в RTL читалось как «480 / 231»: выходило,
 * что сделано вдвое больше, чем есть задач. Проверено по базе — там 480
 * всего и 231 сделано, то есть на экране числа стояли наоборот.
 *
 * Доля процентов при этом влезала между числом и дробью: «480 48% / 231».
 */

const tab = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/company/OverviewTab.tsx'),
  'utf8',
)

describe('числа в обзоре читаются слева направо', () => {
  it('карточка со сводкой задаёт направление', () => {
    // Именно у <p> со значением: dir="ltr" встречается и в других местах
    // файла, и проверка «есть где-то в блоке» проходила бы без него.
    const metric = tab.slice(tab.indexOf('function Metric'))
    expect(metric, 'значение карточки снова переворачивается').toMatch(
      /<p\s+dir="ltr"[\s\S]{0,300}?\{value\}/,
    )
  })

  it('дробь по каждому проекту — тоже', () => {
    const row = tab.match(/<span[^>]*>\s*\{p\.tasksDone\}\/\{p\.tasksTotal\}/)?.[0] ?? ''
    expect(row, 'строка проекта не найдена').not.toBe('')
    expect(row, 'дробь проекта снова переворачивается').toMatch(/dir="ltr"/)
  })

  it('подсказка не разрывает число', () => {
    // Проценты стояли инлайном внутри той же строки и вклинивались между
    // «480» и «/ 231». Теперь это отдельный элемент в общем ряду.
    const metric = tab.slice(tab.indexOf('function Metric'))
    expect(metric).toMatch(/<span>\{value\}<\/span>/)
  })
})
