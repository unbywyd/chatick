// Ввод времени как в Clockify: человек печатает как ему удобно, разделители
// необязательны. Именно это делает правку часов быстрой — иначе каждое
// исправление превращается в возню с двоеточиями.

/**
 * Разбирает время суток. Понимает:
 *   9, 09        → 09:00        930, 0930    → 09:30
 *   9:30, 9.30   → 09:30        1430         → 14:30
 *   9p, 9pm      → 21:00        12am         → 00:00
 * Возвращает минуты от полуночи или null, если разобрать не удалось.
 */
export function parseTimeOfDay(input: string): number | null {
  const raw = input.trim().toLowerCase().replace(/\s+/g, '')
  if (!raw) return null

  const pm = /p\.?m?\.?$/.test(raw)
  const am = /a\.?m?\.?$/.test(raw)
  const body = raw.replace(/[ap]\.?m?\.?$/, '')
  if (!/^\d{1,2}[:.,]?\d{0,2}$|^\d{3,4}$/.test(body)) return null

  let h: number
  let m: number

  if (/[:.,]/.test(body)) {
    const [hs, ms = '0'] = body.split(/[:.,]/)
    h = Number(hs)
    m = Number(ms.padEnd(2, '0')) // «9.3» — это 9:30, а не 9:03
  } else if (body.length <= 2) {
    h = Number(body)
    m = 0
  } else {
    // 930 → 9:30, 1430 → 14:30
    h = Number(body.slice(0, body.length - 2))
    m = Number(body.slice(-2))
  }

  if (Number.isNaN(h) || Number.isNaN(m) || m > 59) return null
  if (pm && h < 12) h += 12
  if (am && h === 12) h = 0
  if (h > 23) return null
  return h * 60 + m
}

/**
 * Разбирает продолжительность. Понимает:
 *   1:30, 1.5h, 90m, 1h30, 1h 30m, 45
 * Голое число — минуты, как в Clockify. Возвращает минуты или null.
 */
export function parseDuration(input: string): number | null {
  const raw = input.trim().toLowerCase().replace(/\s+/g, '')
  if (!raw) return null

  if (/^\d{1,3}:\d{1,2}$/.test(raw)) {
    const [h, m] = raw.split(':').map(Number)
    return (h ?? 0) * 60 + (m ?? 0)
  }

  // 1h30, 1h30m, 2h, 45m
  const hm = raw.match(/^(\d+(?:[.,]\d+)?)h(?:(\d{1,2})m?)?$/)
  if (hm) {
    const hours = Number(hm[1]!.replace(',', '.'))
    return Math.round(hours * 60) + Number(hm[2] ?? 0)
  }
  const mOnly = raw.match(/^(\d+)m$/)
  if (mOnly) return Number(mOnly[1])

  // Голое число читаем как на часах — так же, как показываем: 10 → 10 минут,
  // 150 → 1:50, 230 → 2:30. Иначе человек видит «2:30», вводит 230 и получает
  // три с половиной часа.
  if (/^\d{1,2}$/.test(raw)) return Number(raw) // до двух цифр — минуты
  if (/^\d{3,4}$/.test(raw)) {
    const n = Number(raw)
    const h = Math.floor(n / 100)
    const m = n % 100
    // 190 минутами не бывает — считаем ошибкой ввода, а не 1 ч 90 мин
    return m < 60 ? h * 60 + m : null
  }
  return null
}

/** Минуты от полуночи → «09:30». */
export function formatTimeOfDay(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Секунды → «1:05:09» либо «12:34», как на бегущем таймере. */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
}

/** Минуты → «1 ч 30 мин» в компактном виде «1:30». */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
}

/**
 * Применяет введённое время суток к дате, сохраняя день.
 * Возвращает новую дату — исходная не меняется.
 */
export function withTimeOfDay(date: Date, minutes: number): Date {
  const d = new Date(date)
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  return d
}

/**
 * Конец раньше начала — значит работа перешла через полночь: конец на
 * следующий день. Без этого ночная смена превращалась бы в отрицательное время.
 */
export function resolveEnd(start: Date, endMinutes: number): Date {
  const end = withTimeOfDay(start, endMinutes)
  if (end.getTime() <= start.getTime()) end.setDate(end.getDate() + 1)
  return end
}

/** Сколько дней между началом и концом — для пометки «+1». */
export function dayOffset(start: Date, end: Date): number {
  const a = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  const b = new Date(end.getFullYear(), end.getMonth(), end.getDate())
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}
