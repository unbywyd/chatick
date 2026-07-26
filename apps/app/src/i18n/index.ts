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

// Держим <html lang dir> в синхроне с локалью (RTL для иврита)
function applyDir(lng: string) {
  const locale = LOCALES.find((l) => l.code === lng)
  document.documentElement.lang = lng
  document.documentElement.dir = locale?.dir ?? 'ltr'
}
applyDir(i18n.resolvedLanguage ?? 'en')
i18n.on('languageChanged', applyDir)

export default i18n
