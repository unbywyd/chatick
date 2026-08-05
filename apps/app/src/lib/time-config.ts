// Настройки учёта времени (SPEC §8.36).
//
// Живут на КОМПАНИИ: часовой пояс, рабочие часы и правила забытого таймера —
// свойства организации, а не отдельной работы. Проект их наследует; поле у
// проекта осталось в базе под возможное переопределение, но из интерфейса
// убрано — десять способов задать одно и то же неизбежно разъезжаются.
//
// Отдельным файлом, а не внутри формы: тип нужен и настройкам компании, и
// вкладке часов, а форма настроек проекта к нему больше отношения не имеет.

export type TimeConfig = {
  maxTimers: number
  idleAction: 'remind' | 'stop'
  idleHours: number
  repeatHours: number
  /** страна задаёт пояс, первый день недели и язык — одним выбором */
  country: string
  timezone: string
  weekStart: number
  /** пропускать описания записей через ИИ на язык проекта */
  translate: boolean
  /** начало рабочего дня, минуты от полуночи: 9:00 = 540 */
  workDayStart: number
  /** конец рабочего дня, минуты от полуночи: 18:00 = 1080 */
  workDayEnd: number
}

export const DEFAULT_TIME_CONFIG: TimeConfig = {
  maxTimers: 1,
  idleAction: 'remind',
  idleHours: 8,
  repeatHours: 8,
  country: '',
  timezone: 'UTC',
  weekStart: 1,
  translate: false,
  workDayStart: 9 * 60,
  workDayEnd: 18 * 60,
}

