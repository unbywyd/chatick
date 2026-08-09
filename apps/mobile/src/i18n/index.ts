import { I18nManager } from 'react-native'
import { getLocales } from 'expo-localization'
import AsyncStorage from '@react-native-async-storage/async-storage'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import ru from './locales/ru.json'
import he from './locales/he.json'

// Языки мобильного приложения.
//
// Коды и файлы те же, что в вебе (apps/app/src/i18n): человек, сменивший язык
// на сайте, ждёт его же в телефоне, а два набора ключей неизбежно разойдутся.
//
// Направление письма — по Rule 6 руководства: приложение многоязычное, значит
// вариант B — флаг ставится в JS и применяется перезагрузкой бандла под
// сплешем. Без expo-updates это НЕ работает вовсе, поэтому пакет обязателен.

export const LOCALES = [
  { code: 'en', label: 'English', dir: 'ltr' },
  { code: 'ru', label: 'Русский', dir: 'ltr' },
  { code: 'he', label: 'עברית', dir: 'rtl' },
] as const

export type LocaleCode = (typeof LOCALES)[number]['code']

const LANG_KEY = 'chatick.lang'
/**
 * Одноразовая отметка о перезагрузке ради смены направления. Без неё сбой
 * применения флага уводит приложение в вечный перезапуск — человек видит
 * бесконечный сплеш и не может ничего сделать (Rule 6, пункт 2).
 */
const RTL_GUARD_KEY = 'chatick.rtlRestarted'

export const isRTLLanguage = (code: string): boolean =>
  LOCALES.find((l) => l.code === code)?.dir === 'rtl'

/**
 * Разрешаем RTL, но НЕ решаем направление на этапе импорта: настоящий язык
 * читается из хранилища асинхронно, и направление, выставленное по запасному
 * языку, дало бы «английский текст в RTL-раскладке» до следующего запуска.
 */
I18nManager.allowRTL(true)

export async function getStoredLanguage(): Promise<LocaleCode | null> {
  try {
    const v = await AsyncStorage.getItem(LANG_KEY)
    return v && LOCALES.some((l) => l.code === v) ? (v as LocaleCode) : null
  } catch {
    return null
  }
}

export async function storeLanguage(code: LocaleCode): Promise<void> {
  try {
    await AsyncStorage.setItem(LANG_KEY, code)
  } catch {
    // Не сохранилось — выбор действует до конца сеанса.
  }
}

/** Язык телефона, если он у нас есть. Иначе английский. */
function deviceLanguage(): LocaleCode {
  const tags = getLocales()
  for (const t of tags) {
    const code = (t.languageCode ?? '').toLowerCase()
    if (LOCALES.some((l) => l.code === code)) return code as LocaleCode
  }
  return 'en'
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ru: { translation: ru },
    he: { translation: he },
  },
  // Стартуем с языка телефона — синхронно, чтобы первый кадр не был пустым.
  // Сохранённый выбор приезжает следом, в bootstrapLanguage().
  lng: deviceLanguage(),
  fallbackLng: 'en',
  supportedLngs: LOCALES.map((l) => l.code),
  interpolation: { escapeValue: false },
  // В RN нет <br>, а экранирование строк здесь только мешает.
  returnNull: false,
})

/**
 * Готовит язык до показа интерфейса.
 *
 * Возвращает needsRestart, если направление письма не совпадает с текущим:
 * флаг I18nManager записывается нативно и читается при создании корневого
 * представления, поэтому применяется только со следующей загрузки бандла.
 * Перезагружаемся под сплешем — человек видит чуть более долгий запуск,
 * но никогда не видит кадр в неверном направлении.
 */
export async function bootstrapLanguage(): Promise<{ needsRestart: boolean }> {
  const stored = await getStoredLanguage()
  const resolved = stored ?? deviceLanguage()
  if (i18n.language !== resolved) await i18n.changeLanguage(resolved)

  const shouldBeRTL = isRTLLanguage(resolved)
  if (I18nManager.isRTL !== shouldBeRTL) {
    I18nManager.forceRTL(shouldBeRTL)
    const already = await AsyncStorage.getItem(RTL_GUARD_KEY).catch(() => null)
    if (!already) {
      await AsyncStorage.setItem(RTL_GUARD_KEY, '1').catch(() => {})
      return { needsRestart: true }
    }
    // Перезапуск уже был и не помог: один неверный кадр лучше вечного цикла.
    return { needsRestart: false }
  }

  // Направление совпало — снимаем отметку, чтобы следующая смена сработала.
  await AsyncStorage.removeItem(RTL_GUARD_KEY).catch(() => {})
  return { needsRestart: false }
}

export default i18n
