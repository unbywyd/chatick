import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Возраст задачи в таблице.
 *
 * Просили «дату создания», но вопрос за просьбой был другой — дословно: «а то
 * заходишь и пытаешься понять, где старые таски, а где новые». Дата на него не
 * отвечает: двадцать дат надо сравнивать в уме. «23д» отвечает сразу.
 *
 * Колонки не добавляли: их девять при min-w-640px, и таблица уже тесная.
 * Метка встала под номером — колонка узкая и наполовину пустая.
 */

const table = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/tabs/tasks/TasksTable.tsx'),
  'utf8',
)

describe('возраст показывается там, где он что-то значит', () => {
  it('у закрытой задачи метки нет', () => {
    // «Сколько висит» — вопрос про работу, которая идёт: у сделанной висеть
    // уже нечего. На живых данных 29 закрытых задач носили метку впустую.
    //
    // Саботаж: убрать проверку — метка вернётся на сделанные.
    expect(table).toMatch(/if \(status === 'done'\) return null/)
  })

  it('сегодняшние молчат, вчерашние показывают «1д»', () => {
    // «0д» — не ответ, а шум в каждой новой строке.
    expect(table).toMatch(/if \(days < 1\) return null/)
  })

  it('порога по возрасту нет — возраст видно у всех открытых', () => {
    // Был порог в три недели, чтобы метка «выделяла меньшинство». Убран:
    // человеку нужен возраст задачи, а не отметка избранных. Скрытый возраст
    // у половины строк отвечает на вопрос хуже, чем показанный у всех.
    expect(table, 'вернулся порог по возрасту').not.toMatch(/AGE_LABEL_DAYS/)
  })
})

describe('таблица не выросла на колонку', () => {
  it('колонок по-прежнему девять', () => {
    // Таблица уже тесная: девять колонок при min-w-640px. Десятая ради даты,
    // которая не отвечает на заданный вопрос, — плохой размен.
    const at = table.indexOf("{ key: 'number'")
    const block = table.slice(at, table.indexOf(']', at))
    const keys = block.match(/key: '/g) ?? []
    expect(keys.length, 'в таблице появилась новая колонка').toBe(9)
    expect(block, 'колонка даты создания всё-таки добавлена').not.toMatch(/key: 'created/)
  })

  it('возраст стоит под номером, в существующей колонке', () => {
    const at = table.indexOf('<TaskAge')
    expect(at, 'метка возраста не выводится').toBeGreaterThan(-1)
    // Именно в ячейке номера: там уже есть место, и ширина не меняется.
    const cell = table.slice(table.lastIndexOf('<td', at), at + 60)
    expect(cell).toMatch(/\{task\.number\}/)
  })
})

describe('точная дата не потеряна', () => {
  it('она в подсказке', () => {
    // Метка отвечает «давно»; когда именно — спрашивают редко и прицельно.
    expect(table).toMatch(/title=\{t\('tasks\.createdOn'/)
  })

  it('дата и склонение дней — через локаль, не своей таблицей', () => {
    expect(table).toMatch(/toLocaleDateString\(i18n\.language/)
    expect(table).toMatch(/t\('tasks\.ageDays', \{ count: days \}\)/)
  })
})

describe('перевод на три языка', () => {
  for (const lang of ['ru', 'en', 'he']) {
    it(`${lang}: строки возраста переведены`, () => {
      const json = JSON.parse(
        readFileSync(join(import.meta.dirname, `../../../app/src/i18n/locales/${lang}.json`), 'utf8'),
      ) as { tasks: Record<string, string> }
      for (const key of ['ageDays', 'createdOn']) {
        expect(json.tasks?.[key], `${lang}.tasks.${key} отсутствует`).toBeTruthy()
      }
    })
  }
})
