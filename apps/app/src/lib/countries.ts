// Страна задаёт сразу три вещи: часовой пояс, первый день недели и язык.
// Выбрать одну страну проще, чем настраивать их по отдельности, — а ошибиться
// в поясе дорого: по нему режутся сутки в отчётах.

export type CountryPreset = {
  code: string
  name: string
  timezone: string
  /** 0 = воскресенье, 1 = понедельник, 6 = суббота */
  weekStart: number
  /** язык проекта по умолчанию, если он у нас поддержан */
  language?: 'en' | 'ru' | 'he'
}

export const COUNTRIES: CountryPreset[] = [
  { code: 'IL', name: 'Israel', timezone: 'Asia/Jerusalem', weekStart: 0, language: 'he' },
  { code: 'RU', name: 'Russia', timezone: 'Europe/Moscow', weekStart: 1, language: 'ru' },
  { code: 'GE', name: 'Georgia', timezone: 'Asia/Tbilisi', weekStart: 1, language: 'ru' },
  { code: 'UA', name: 'Ukraine', timezone: 'Europe/Kyiv', weekStart: 1, language: 'ru' },
  { code: 'KZ', name: 'Kazakhstan', timezone: 'Asia/Almaty', weekStart: 1, language: 'ru' },
  { code: 'BY', name: 'Belarus', timezone: 'Europe/Minsk', weekStart: 1, language: 'ru' },
  { code: 'AM', name: 'Armenia', timezone: 'Asia/Yerevan', weekStart: 1, language: 'ru' },
  { code: 'US', name: 'United States', timezone: 'America/New_York', weekStart: 0, language: 'en' },
  { code: 'CA', name: 'Canada', timezone: 'America/Toronto', weekStart: 0, language: 'en' },
  { code: 'GB', name: 'United Kingdom', timezone: 'Europe/London', weekStart: 1, language: 'en' },
  { code: 'DE', name: 'Germany', timezone: 'Europe/Berlin', weekStart: 1, language: 'en' },
  { code: 'FR', name: 'France', timezone: 'Europe/Paris', weekStart: 1, language: 'en' },
  { code: 'ES', name: 'Spain', timezone: 'Europe/Madrid', weekStart: 1, language: 'en' },
  { code: 'PT', name: 'Portugal', timezone: 'Europe/Lisbon', weekStart: 1, language: 'en' },
  { code: 'NL', name: 'Netherlands', timezone: 'Europe/Amsterdam', weekStart: 1, language: 'en' },
  { code: 'PL', name: 'Poland', timezone: 'Europe/Warsaw', weekStart: 1, language: 'en' },
  { code: 'CZ', name: 'Czechia', timezone: 'Europe/Prague', weekStart: 1, language: 'en' },
  { code: 'TR', name: 'Türkiye', timezone: 'Europe/Istanbul', weekStart: 1, language: 'en' },
  { code: 'AE', name: 'United Arab Emirates', timezone: 'Asia/Dubai', weekStart: 0, language: 'en' },
  { code: 'IN', name: 'India', timezone: 'Asia/Kolkata', weekStart: 0, language: 'en' },
  { code: 'CN', name: 'China', timezone: 'Asia/Shanghai', weekStart: 1, language: 'en' },
  { code: 'JP', name: 'Japan', timezone: 'Asia/Tokyo', weekStart: 0, language: 'en' },
  { code: 'AU', name: 'Australia', timezone: 'Australia/Sydney', weekStart: 1, language: 'en' },
  { code: 'BR', name: 'Brazil', timezone: 'America/Sao_Paulo', weekStart: 0, language: 'en' },
  { code: 'AR', name: 'Argentina', timezone: 'America/Argentina/Buenos_Aires', weekStart: 1, language: 'en' },
  { code: 'CY', name: 'Cyprus', timezone: 'Asia/Nicosia', weekStart: 1, language: 'en' },
  { code: 'RS', name: 'Serbia', timezone: 'Europe/Belgrade', weekStart: 1, language: 'en' },
  { code: 'TH', name: 'Thailand', timezone: 'Asia/Bangkok', weekStart: 0, language: 'en' },
]

export const countryByCode = (code: string): CountryPreset | undefined =>
  COUNTRIES.find((c) => c.code === code.toUpperCase())

/** Пояс браузера — разумная догадка при первой настройке проекта. */
export function guessCountry(): CountryPreset | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return COUNTRIES.find((c) => c.timezone === tz)
  } catch {
    return undefined
  }
}

/**
 * Все зоны IANA, какие знает браузер. Вводить их руками нельзя: опечатка
 * в «Asia/Jerusalem» тихо ломает подсчёт суток в отчётах.
 */
export function allTimezones(): string[] {
  const withSupport = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }
  const list = withSupport.supportedValuesOf?.('timeZone')
  if (list?.length) return list
  // старые браузеры: хотя бы то, что есть в пресетах, плюс UTC
  return ['UTC', ...new Set(COUNTRIES.map((c) => c.timezone))].sort()
}

/** «Asia/Jerusalem» → «+03:00»: смещение помогает узнать нужный пояс. */
export function timezoneOffset(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date())
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? ''
  } catch {
    return ''
  }
}
