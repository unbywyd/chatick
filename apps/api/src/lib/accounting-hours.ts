/**
 * Раскладка часов за месяц для бухгалтерии.
 *
 * Бухгалтерии нужен не трекер как есть, а табель по правилам: сумма за месяц —
 * ровно наработанная, а по дням — поровну, не больше восьми часов в день и
 * только в рабочие дни. Рабочая неделя израильская: воскресенье–четверг.
 * Пятница берётся, только если в рабочие дни не влезло; суббота — если не
 * влезло и с пятницами.
 *
 * Считаем в целых минутах: так сумма по дням и сумма по проектам сходятся с
 * итогом до минуты, без хвостов от округления часов.
 */

export type DayPlan = {
  /** YYYY-MM-DD */
  date: string
  /** 0 = воскресенье … 6 = суббота */
  weekday: number
  minutes: number
}

const FRIDAY = 5
const SATURDAY = 6

/** Все дни месяца. month — 1..12. */
export function daysOfMonth(year: number, month: number): { date: string; weekday: number }[] {
  const out = []
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  for (let d = 1; d <= last; d++) {
    const at = new Date(Date.UTC(year, month - 1, d))
    out.push({ date: at.toISOString().slice(0, 10), weekday: at.getUTCDay() })
  }
  return out
}

/** Поровну в целых минутах: лишние минуты — первым дням, по одной. */
function spread(total: number, n: number): number[] {
  if (n === 0) return []
  const base = Math.floor(total / n)
  const extra = total - base * n
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0))
}

/**
 * Разложить минуты месяца по дням.
 *
 * overflow — сколько минут не влезло даже с пятницами и субботами при
 * ограничении в день. Такие минуты всё равно раскладываются (сумму терять
 * нельзя), но дни выходят длиннее предела — это надо показать человеку.
 */
export function planMonth(
  year: number,
  month: number,
  totalMinutes: number,
  maxDayMinutes = 8 * 60,
): { days: DayPlan[]; usedFridays: boolean; usedSaturdays: boolean; overLimit: boolean } {
  const days: DayPlan[] = daysOfMonth(year, month).map((d) => ({ ...d, minutes: 0 }))
  const tiers = [
    days.filter((d) => d.weekday !== FRIDAY && d.weekday !== SATURDAY),
    days.filter((d) => d.weekday === FRIDAY),
    days.filter((d) => d.weekday === SATURDAY),
  ]

  let left = totalMinutes
  let usedTiers = 0
  for (const tier of tiers) {
    if (left <= 0) break
    usedTiers++
    const room = tier.length * maxDayMinutes
    if (left <= room) {
      // Влезло в этот ярус — поровну по нему. Предыдущие уже заполнены до предела.
      spread(left, tier.length).forEach((m, i) => (tier[i]!.minutes = m))
      left = 0
      break
    }
    for (const d of tier) d.minutes = maxDayMinutes
    left -= room
  }

  // Не влезло никуда: предел нарушаем, но поровну по всем дням и без потерь.
  const overLimit = left > 0
  if (overLimit) spread(left, days.length).forEach((m, i) => (days[i]!.minutes += m))

  return { days, usedFridays: usedTiers >= 2 || overLimit, usedSaturdays: usedTiers >= 3 || overLimit, overLimit }
}

/**
 * Разложить проекты по дням пропорционально их доле.
 *
 * Каждый день делится между проектами по тому, сколько у проекта ещё
 * осталось; остаток минуты уходит тем, у кого дробная часть больше. Так
 * строки сходятся с днями, столбцы — с итогами проектов, и ни одна клетка не
 * уходит в минус.
 */
export function splitByProject(days: DayPlan[], projects: { id: string; minutes: number }[]): Map<string, number>[] {
  const remaining = new Map(projects.map((p) => [p.id, p.minutes]))
  return days.map((day) => {
    const cell = new Map<string, number>()
    const pool = [...remaining.values()].reduce((a, b) => a + b, 0)
    if (day.minutes === 0 || pool === 0) return cell
    const exact = [...remaining].map(([id, m]) => ({ id, x: (day.minutes * m) / pool }))
    const floors = exact.map((e) => ({ id: e.id, m: Math.floor(e.x), frac: e.x - Math.floor(e.x) }))
    let rest = day.minutes - floors.reduce((a, f) => a + f.m, 0)
    for (const f of [...floors].sort((a, b) => b.frac - a.frac)) {
      if (rest <= 0) break
      f.m++
      rest--
    }
    for (const f of floors) {
      if (!f.m) continue
      cell.set(f.id, f.m)
      remaining.set(f.id, remaining.get(f.id)! - f.m)
    }
    return cell
  })
}
