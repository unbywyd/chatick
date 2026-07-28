// Языки проекта (SPEC §4.1).
//
// Язык проекта — не язык интерфейса. На нём ведутся задачи, документы и чат, а
// сообщения на других языках ИИ переводит. Поэтому список не ограничен теми
// тремя, на которые переведён интерфейс: команда может писать на португальском,
// пользуясь английским интерфейсом.
//
// Отсортировано по числу говорящих: сверху то, что выбирают чаще.

export type ProjectLanguage = {
  code: string
  /** самоназвание — его ищут в первую очередь */
  label: string
  /** английское название: по нему ищут на нелокализованной раскладке */
  english: string
}

export const PROJECT_LANGUAGES: ProjectLanguage[] = [
  { code: 'en', label: 'English', english: 'English' },
  { code: 'zh', label: '中文', english: 'Chinese' },
  { code: 'hi', label: 'हिन्दी', english: 'Hindi' },
  { code: 'es', label: 'Español', english: 'Spanish' },
  { code: 'ar', label: 'العربية', english: 'Arabic' },
  { code: 'fr', label: 'Français', english: 'French' },
  { code: 'pt', label: 'Português', english: 'Portuguese' },
  { code: 'ru', label: 'Русский', english: 'Russian' },
  { code: 'de', label: 'Deutsch', english: 'German' },
  { code: 'ja', label: '日本語', english: 'Japanese' },
  { code: 'ko', label: '한국어', english: 'Korean' },
  { code: 'it', label: 'Italiano', english: 'Italian' },
  { code: 'tr', label: 'Türkçe', english: 'Turkish' },
  { code: 'pl', label: 'Polski', english: 'Polish' },
  { code: 'uk', label: 'Українська', english: 'Ukrainian' },
  { code: 'nl', label: 'Nederlands', english: 'Dutch' },
  { code: 'id', label: 'Bahasa Indonesia', english: 'Indonesian' },
  { code: 'vi', label: 'Tiếng Việt', english: 'Vietnamese' },
  { code: 'th', label: 'ไทย', english: 'Thai' },
  { code: 'he', label: 'עברית', english: 'Hebrew' },
  { code: 'sv', label: 'Svenska', english: 'Swedish' },
  { code: 'no', label: 'Norsk', english: 'Norwegian' },
  { code: 'da', label: 'Dansk', english: 'Danish' },
  { code: 'fi', label: 'Suomi', english: 'Finnish' },
  { code: 'cs', label: 'Čeština', english: 'Czech' },
  { code: 'el', label: 'Ελληνικά', english: 'Greek' },
  { code: 'ro', label: 'Română', english: 'Romanian' },
  { code: 'hu', label: 'Magyar', english: 'Hungarian' },
  { code: 'bg', label: 'Български', english: 'Bulgarian' },
  { code: 'sr', label: 'Српски', english: 'Serbian' },
  { code: 'hr', label: 'Hrvatski', english: 'Croatian' },
  { code: 'sk', label: 'Slovenčina', english: 'Slovak' },
  { code: 'lt', label: 'Lietuvių', english: 'Lithuanian' },
  { code: 'lv', label: 'Latviešu', english: 'Latvian' },
  { code: 'et', label: 'Eesti', english: 'Estonian' },
  { code: 'ka', label: 'ქართული', english: 'Georgian' },
  { code: 'hy', label: 'Հայերեն', english: 'Armenian' },
  { code: 'az', label: 'Azərbaycan', english: 'Azerbaijani' },
  { code: 'kk', label: 'Қазақша', english: 'Kazakh' },
  { code: 'uz', label: "O'zbek", english: 'Uzbek' },
  { code: 'fa', label: 'فارسی', english: 'Persian' },
  { code: 'bn', label: 'বাংলা', english: 'Bengali' },
  { code: 'ur', label: 'اردو', english: 'Urdu' },
  { code: 'ta', label: 'தமிழ்', english: 'Tamil' },
  { code: 'ms', label: 'Bahasa Melayu', english: 'Malay' },
  { code: 'fil', label: 'Filipino', english: 'Filipino' },
  { code: 'sw', label: 'Kiswahili', english: 'Swahili' },
]

/** Язык по коду; для незнакомого показываем сам код, а не пустоту. */
export function languageLabel(code: string): string {
  return PROJECT_LANGUAGES.find((l) => l.code === code)?.label ?? code
}

/**
 * Поиск по самоназванию, английскому названию и коду.
 *
 * Три поля не прихоть: человек с английской раскладкой ищет «German», носитель
 * пишет «Deutsch», а тот, кто знает коды, вводит «de».
 */
export function searchLanguages(query: string): ProjectLanguage[] {
  const q = query.trim().toLowerCase()
  if (!q) return PROJECT_LANGUAGES
  return PROJECT_LANGUAGES.filter(
    (l) =>
      l.label.toLowerCase().includes(q) ||
      l.english.toLowerCase().includes(q) ||
      l.code.toLowerCase().startsWith(q),
  )
}
