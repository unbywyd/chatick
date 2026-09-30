import { describe, it, expect } from 'vitest'
import { daysOfMonth, planMonth, splitByProject } from './accounting-hours.js'

/**
 * Табель для бухгалтерии: сумма — ровно наработанная, по дням — поровну,
 * не больше 8 часов, в воскресенье–четверг; пятница и суббота — только если
 * не влезло. Ошибка здесь — неверная зарплатная ведомость, поэтому правила
 * проверяем на границах, а не на одном удобном примере.
 */

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const H = 60

// Сентябрь 2026: 30 дней, 1-е — вторник. Вс–Чт: 22 дня, пятниц 4, суббот 4.
const Y = 2026
const M = 9

describe('календарь', () => {
  it('сентябрь 2026: 30 дней, 22 рабочих, 4 пятницы, 4 субботы', () => {
    const d = daysOfMonth(Y, M)
    expect(d).toHaveLength(30)
    expect(d[0]).toEqual({ date: '2026-09-01', weekday: 2 })
    expect(d.filter((x) => x.weekday < 5)).toHaveLength(22)
    expect(d.filter((x) => x.weekday === 5)).toHaveLength(4)
    expect(d.filter((x) => x.weekday === 6)).toHaveLength(4)
  })

  it('високосный февраль', () => {
    expect(daysOfMonth(2028, 2)).toHaveLength(29)
  })
})

describe('раскладка по дням', () => {
  it('итог сохраняется до минуты', () => {
    for (const total of [0, 1, 59, 7 * H + 13, 100 * H + 37, 176 * H, 176 * H + 1, 240 * H + 7, 300 * H + 11]) {
      expect(sum(planMonth(Y, M, total).days.map((d) => d.minutes)), `total ${total}`).toBe(total)
    }
  })

  it('влезает в рабочие — пятницы и субботы пустые, дни поровну', () => {
    const { days, usedFridays, usedSaturdays } = planMonth(Y, M, 100 * H + 37)
    expect(usedFridays).toBe(false)
    expect(usedSaturdays).toBe(false)
    expect(days.filter((d) => d.weekday >= 5).every((d) => d.minutes === 0)).toBe(true)
    const work = days.filter((d) => d.weekday < 5).map((d) => d.minutes)
    // «Поровну»: разница между днями не больше минуты.
    expect(Math.max(...work) - Math.min(...work)).toBeLessThanOrEqual(1)
  })

  it('ровно 22 × 8 — всё в рабочие, по 8', () => {
    const { days, usedFridays } = planMonth(Y, M, 176 * H)
    expect(usedFridays).toBe(false)
    expect(days.filter((d) => d.weekday < 5).every((d) => d.minutes === 8 * H)).toBe(true)
  })

  it('на минуту больше — рабочие по 8, остаток в пятницу, суббота пустая', () => {
    const { days, usedFridays, usedSaturdays } = planMonth(Y, M, 176 * H + 1)
    expect(usedFridays).toBe(true)
    expect(usedSaturdays).toBe(false)
    expect(days.filter((d) => d.weekday < 5).every((d) => d.minutes === 8 * H)).toBe(true)
    expect(sum(days.filter((d) => d.weekday === 5).map((d) => d.minutes))).toBe(1)
    expect(days.filter((d) => d.weekday === 6).every((d) => d.minutes === 0)).toBe(true)
  })

  it('не влезает с пятницами — субботы, но всё ещё не больше 8', () => {
    const total = (22 + 4) * 8 * H + 5 * H
    const { days, usedSaturdays, overLimit } = planMonth(Y, M, total)
    expect(usedSaturdays).toBe(true)
    expect(overLimit).toBe(false)
    expect(days.every((d) => d.minutes <= 8 * H)).toBe(true)
    expect(sum(days.filter((d) => d.weekday === 6).map((d) => d.minutes))).toBe(5 * H)
  })

  it('не влезает никуда — сумма не теряется, превышение помечено', () => {
    const total = 30 * 8 * H + 30
    const { days, overLimit } = planMonth(Y, M, total)
    expect(overLimit).toBe(true)
    expect(sum(days.map((d) => d.minutes))).toBe(total)
  })

  it('предел в день настраивается', () => {
    const { days } = planMonth(Y, M, 22 * 6 * H + 1, 6 * H)
    expect(days.filter((d) => d.weekday < 5).every((d) => d.minutes === 6 * H)).toBe(true)
    expect(sum(days.filter((d) => d.weekday === 5).map((d) => d.minutes))).toBe(1)
  })
})

describe('проекты по дням', () => {
  const projects = [
    { id: 'a', minutes: 61 * H + 17 },
    { id: 'b', minutes: 23 * H + 41 },
    { id: 'c', minutes: 7 },
    { id: 'd', minutes: 15 * H + 2 },
  ]
  const total = sum(projects.map((p) => p.minutes))
  const { days } = planMonth(Y, M, total)
  const cells = splitByProject(days, projects)

  it('строки сходятся с днями', () => {
    days.forEach((d, i) => expect(sum([...cells[i]!.values()]), d.date).toBe(d.minutes))
  })

  it('столбцы сходятся с проектами', () => {
    for (const p of projects) expect(sum(cells.map((c) => c.get(p.id) ?? 0)), p.id).toBe(p.minutes)
  })

  it('минусов нет', () => {
    for (const c of cells) for (const m of c.values()) expect(m).toBeGreaterThan(0)
  })

  it('проект держит свою долю в каждом рабочем дне', () => {
    // Доля проекта в день не должна уплывать: иначе в начале месяца один
    // проект, в конце другой, и табель читается как выдуманный.
    const share = projects[0]!.minutes / total
    const work = days.map((d, i) => ({ d, c: cells[i]! })).filter((x) => x.d.minutes > 0)
    for (const { d, c } of work) expect(Math.abs((c.get('a') ?? 0) / d.minutes - share)).toBeLessThan(0.01)
  })
})
