import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import en from './locales/en.json'
import ru from './locales/ru.json'
import he from './locales/he.json'

export const LOCALES = [
  { code: 'en', label: 'English', dir: 'ltr' },
  { code: 'ru', label: 'Русский', dir: 'ltr' },
  { code: 'he', label: 'עברית', dir: 'rtl' },
] as const

export type LocaleCode = (typeof LOCALES)[number]['code']

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ru: { translation: ru },
      he: { translation: he },
    },
    fallbackLng: 'en',
    supportedLngs: LOCALES.map((l) => l.code),
    interpolation: { escapeValue: false },
    detection: {
      // ?lng= идёт первым ради входа из десктопа: приложение открывает вкладку
      // в системном браузере, и язык там должен быть тот, что выбран в
      // приложении, а не тот, что стоит в чужом браузере.
      order: ['querystring', 'localStorage', 'navigator'],
      lookupQuerystring: 'lng',
      lookupLocalStorage: 'chatick_lang',
      caches: ['localStorage'],
    },
  })

/**
 * В иврите у чисел есть отдельная форма для двух (_two). Где её не завели,
 * i18next уходил в английский — «40 משימות עליך across 2 projects». Берём
 * общую форму множественного числа на иврите: для двух она верна.
 * Пакеты v2 подключаются позже, при импорте модулей, — ловим и их.
 */
function fillTwo(lng: string, ns: string) {
  if (lng !== 'he') return
  const walk = (o: Record<string, unknown>, path: string[]) => {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') walk(v as Record<string, unknown>, [...path, k])
      else if (typeof v === 'string' && k.endsWith('_other')) {
        const two = k.slice(0, -'_other'.length) + '_two'
        if (!(two in o)) i18n.addResource(lng, ns, [...path, two].join('.'), v, { silent: true })
      }
    }
  }
  walk(i18n.getResourceBundle(lng, ns) ?? {}, [])
}
for (const ns of Object.keys(i18n.store.data.he ?? {})) fillTwo('he', ns)
i18n.store.on('added', fillTwo)

// Держим <html lang dir> в синхроне с локалью (RTL для иврита)
function applyDir(lng: string) {
  const locale = LOCALES.find((l) => l.code === lng)
  document.documentElement.lang = lng
  document.documentElement.dir = locale?.dir ?? 'ltr'
}
applyDir(i18n.resolvedLanguage ?? 'en')
i18n.on('languageChanged', applyDir)

export default i18n
