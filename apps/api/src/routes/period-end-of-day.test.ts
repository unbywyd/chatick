import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// «По 8 августа» включает весь день.
//
// Дата без времени разбирается как полночь, поэтому граница `<= to` отсекает
// весь последний день периода. Ошибка тихая вдвойне: вчерашние данные
// считаются верно, цифра выглядит правдоподобной — и расходится с реальностью
// ровно у тех проектов, где работали сегодня. В обзоре компании это выглядело
// как «0:00 часов» при трёх часах в базе.
//
// Проверяем не одну ручку, а весь класс: у любой выборки за период, куда
// клиент шлёт дату вида YYYY-MM-DD, конец дня должен быть закрыт.

const files = ['companies.ts', 'ext.ts', 'activity.ts', 'files.ts', 'messages.ts', 'bridge.ts']

describe('конец периода включает последний день', () => {
  for (const name of files) {
    it(`${name}: каждая граница «to» дотягивает до конца дня`, () => {
      const src = readFileSync(join(import.meta.dirname, name), 'utf8')

      // Сырое new Date(to) без добивки времени — ровно тот баг. Ищем места,
      // где значение из запроса превращается в дату и нигде рядом не
      // упоминается конец суток.
      const raw = [...src.matchAll(/new Date\((q\.)?to\)/g)].filter((m) => {
        const around = src.slice(Math.max(0, m.index! - 200), m.index! + 300)
        return !/23,\s*59,\s*59|23:59:59/.test(around)
      })

      expect(
        raw.map((m) => src.slice(Math.max(0, m.index! - 60), m.index! + 40).trim()),
        `${name}: граница периода обрезает последний день`,
      ).toEqual([])
    })
  }
})

describe('обзор компании', () => {
  const src = readFileSync(join(import.meta.dirname, 'companies.ts'), 'utf8')

  it('дата без времени растягивается до конца суток', () => {
    expect(src).toMatch(/q\.to\.length <= 10 \? `\$\{q\.to\}T23:59:59/)
  })

  it('отдаёт часы за всё время рядом с часами за период', () => {
    // Без этого одна цифра за месяц читается как «часов на проекте нет».
    expect(src).toMatch(/totalMinutes: totalTimeMap\.get\(p\.id\)\?\.minutes \?\? 0/)
  })

  it('итог за всё время считается без периода', () => {
    // Смысл второй цифры именно в том, что она не ограничена периодом —
    // если сюда просочится inPeriod, обе колонки станут одинаковыми.
    const block = src.slice(src.indexOf('const totalTimeRows'), src.indexOf('const byId'))
    expect(block).not.toMatch(/inPeriod/)
    expect(block).toMatch(/endedAt} is not null/)
  })
})
