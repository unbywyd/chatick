/**
 * Стадии релиза по типам сборки.
 *
 * Зашиты в код намеренно. Свободный текст статуса означал бы, что у одного
 * «TestFlight», у другого «testflight», у третьего «тестфлайт» — и сводка
 * «что сейчас в проде», ради которой всё затевалось, перестаёт складываться.
 *
 * Тип сборки при этом строка, а не енам: версия бывает не только мобильной, и
 * новый тип добавляется сюда одной записью, не трогая базу.
 */

export type Stage = {
  /** Что пишется в releases.status — стабильный ключ, не подпись. */
  key: string
  /** Подписи: интерфейс переводит по ключу, здесь — запасной вариант. */
  label: string
  /**
   * Эта стадия означает «доехало до людей».
   *
   * Нужна сводке наверху страницы: без явной пометки система не знает, какая
   * из стадий конечная, и «что сейчас в проде» пришлось бы угадывать по
   * порядку — а он у платформ разный.
   */
  live?: boolean
}

export type BuildType = {
  key: string
  label: string
  stages: Stage[]
}

/**
 * У iOS «поднять в TestFlight» и «опубликовать в App Store» — две разные
 * вещи, между которыми живёт ревью Apple. У Android внутренний трек и
 * публикация фактически одно действие. Поэтому лестницы разные, а не общая:
 * иначе «1.4 в проде» значило бы разное для двух платформ.
 */
export const BUILD_TYPES: BuildType[] = [
  {
    key: 'ios',
    label: 'iOS',
    stages: [
      { key: 'building', label: 'Building' },
      { key: 'testflight', label: 'TestFlight' },
      { key: 'in_review', label: 'Waiting for Apple review' },
      { key: 'released', label: 'App Store', live: true },
    ],
  },
  {
    key: 'android',
    label: 'Android',
    stages: [
      { key: 'building', label: 'Building' },
      { key: 'internal', label: 'Internal track' },
      { key: 'released', label: 'Google Play', live: true },
    ],
  },
  {
    key: 'web',
    label: 'Web',
    stages: [
      { key: 'building', label: 'Building' },
      { key: 'staging', label: 'Staging' },
      { key: 'released', label: 'Production', live: true },
    ],
  },
  {
    key: 'backend',
    label: 'Backend',
    stages: [
      { key: 'building', label: 'Building' },
      { key: 'staging', label: 'Staging' },
      { key: 'released', label: 'Production', live: true },
    ],
  },
  {
    key: 'desktop',
    label: 'Desktop',
    stages: [
      { key: 'building', label: 'Building' },
      { key: 'beta', label: 'Beta' },
      { key: 'released', label: 'Released', live: true },
    ],
  },
  {
    /**
     * Запасной тип: что-то, для чего отдельной лестницы нет.
     *
     * Без него человек с непредусмотренной платформой упирается в «выберите
     * из списка» и не заводит версию вообще — то есть теряется ровно то,
     * ради чего всё делалось.
     */
    key: 'other',
    label: 'Other',
    stages: [
      { key: 'building', label: 'In progress' },
      { key: 'released', label: 'Released', live: true },
    ],
  },
]

const BY_KEY = new Map(BUILD_TYPES.map((t) => [t.key, t]))

export function buildType(key: string): BuildType | null {
  return BY_KEY.get(key) ?? null
}

/** Допустима ли стадия для этого типа сборки. */
export function isValidStage(typeKey: string, stageKey: string): boolean {
  return Boolean(buildType(typeKey)?.stages.some((s) => s.key === stageKey))
}

/** Первая стадия — с неё начинается любая версия. */
export function firstStage(typeKey: string): string | null {
  return buildType(typeKey)?.stages[0]?.key ?? null
}

/** Значит ли эта стадия «доехало до людей» — для сводки «что сейчас в проде». */
export function isLiveStage(typeKey: string, stageKey: string): boolean {
  return Boolean(buildType(typeKey)?.stages.find((s) => s.key === stageKey)?.live)
}
