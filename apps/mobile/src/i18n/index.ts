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
// Направление письма здесь не выставляется: им занимается DirectionProvider,
// который берёт его из языка и ставит direction на корневой View. Нативный
// флаг I18nManager для этого не годится — он снимается до запуска JS и в
// процессе не обновляется.

export const LOCALES = [
  { code: 'en', label: 'English', dir: 'ltr' },
  { code: 'ru', label: 'Русский', dir: 'ltr' },
  { code: 'he', label: 'עברית', dir: 'rtl' },
] as const

export type LocaleCode = (typeof LOCALES)[number]['code']

const LANG_KEY = 'chatick.lang'

export const isRTLLanguage = (code: string): boolean =>
  LOCALES.find((l) => l.code === code)?.dir === 'rtl'

/**
 * Разрешаем системе зеркалить нативные элементы (диалоги, меню выбора текста).
 * Направление самого интерфейса задаёт DirectionProvider, а не этот флаг.
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
 * Загружает шрифт под язык: Heebo для иврита, Inter для остального.
 *
 * Ни один из них не покрывает оба письма — я сверил таблицы cmap: в Heebo
 * ноль кириллических знаков, в Inter ноль ивритских. Один шрифт на всё
 * оставил бы половину интерфейса на системном.
 *
 * Грузим только нужный набор: второй в этом запуске не понадобится, а лишние
 * 300 КБ на старте — задержка на пустом месте. Вызывается и при старте, и при
 * смене языка: переход между языками одного направления (иврит → английский)
 * идёт без перезапуска, и шрифт там иначе не появился бы.
 */
export async function loadFontsFor(code: string): Promise<void> {
  try {
    const Font = await import('expo-font')
    await Font.loadAsync(
      code === 'he'
        ? {
            'Heebo-Regular': require('../../assets/fonts/Heebo-Regular.ttf'),
            'Heebo-Medium': require('../../assets/fonts/Heebo-Medium.ttf'),
            'Heebo-Bold': require('../../assets/fonts/Heebo-Bold.ttf'),
          }
        : {
            'Inter-Regular': require('../../assets/fonts/Inter-Regular.ttf'),
            'Inter-Medium': require('../../assets/fonts/Inter-Medium.ttf'),
            'Inter-Bold': require('../../assets/fonts/Inter-Bold.ttf'),
          },
    )
  } catch {
    // Шрифт не загрузился — интерфейс отрисуется системным. Это хуже внешне,
    // но лучше, чем не показать приложение вовсе.
  }
}

/**
 * Готовит язык до показа интерфейса: выбирает его и грузит шрифты.
 *
 * Направление письма здесь НЕ применяется и перезапуск не нужен. Раньше тут
 * стоял I18nManager.forceRTL с перезагрузкой бандла под сплешем. От этого
 * отказались: на iOS forceRTL не применяется вовсе (проверено на релизной
 * сборке при чистой установке), а на Android он работает, но оставляет
 * I18nManager.isRTL несогласованным с настоящей раскладкой — и весь код,
 * который верил флагу, ошибался молча.
 *
 * Теперь направление задаёт DirectionProvider через свойство direction на
 * корневом View: оно применяется к уже смонтированному дереву сразу, без
 * перезагрузки и одинаково на обеих платформах.
 */
export async function bootstrapLanguage(): Promise<void> {
  const stored = await getStoredLanguage()
  const resolved = stored ?? deviceLanguage()
  if (i18n.language !== resolved) await i18n.changeLanguage(resolved)
  await loadFontsFor(resolved)
}

export default i18n
