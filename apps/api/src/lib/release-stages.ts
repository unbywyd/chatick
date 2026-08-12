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
   * Одна строка о том, что стадия означает на самом деле.
   *
   * «Internal track» и «TestFlight» — слова из документации магазинов, и
   * человеку вне мобильной разработки они не говорят ничего. Без пояснения
   * лестница выглядит набором терминов, а выбирать по ней приходится.
   */
  hint?: string
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
      { key: 'building', label: 'Building', hint: 'Сборка идёт' },
      { key: 'testflight', label: 'TestFlight', hint: 'Доступна тестировщикам, в магазине не видна' },
      { key: 'in_review', label: 'Waiting for Apple review', hint: 'Отправлена в Apple, ждём проверки' },
      { key: 'released', label: 'App Store', live: true, hint: 'Опубликована, доступна всем' },
    ],
  },
  {
    key: 'android',
    label: 'Android',
    stages: [
      { key: 'building', label: 'Building', hint: 'Сборка идёт' },
      { key: 'internal', label: 'Internal track', hint: 'Внутренний канал Google Play: только свои тестировщики, в магазине не видна' },
      { key: 'released', label: 'Google Play', live: true, hint: 'Опубликована, доступна всем' },
    ],
  },
  {
    key: 'web',
    label: 'Web',
    stages: [
      { key: 'building', label: 'Building', hint: 'Сборка идёт' },
      { key: 'staging', label: 'Staging', hint: 'Выкачено на тестовый стенд' },
      { key: 'released', label: 'Production', live: true, hint: 'Выкачено в прод' },
    ],
  },
  {
    key: 'backend',
    label: 'Backend',
    stages: [
      { key: 'building', label: 'Building', hint: 'Сборка идёт' },
      { key: 'staging', label: 'Staging', hint: 'Выкачено на тестовый стенд' },
      { key: 'released', label: 'Production', live: true, hint: 'Выкачено в прод' },
    ],
  },
  {
    key: 'desktop',
    label: 'Desktop',
    stages: [
      { key: 'building', label: 'Building', hint: 'Сборка идёт' },
      { key: 'beta', label: 'Beta', hint: 'Бета-канал: обновление получают только подписавшиеся' },
      { key: 'released', label: 'Released', live: true, hint: 'Обновление уходит всем' },
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
      { key: 'building', label: 'In progress', hint: 'В работе' },
      { key: 'released', label: 'Released', live: true, hint: 'Готово и доступно' },
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
