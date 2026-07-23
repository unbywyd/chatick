import { useTranslation } from 'react-i18next'
import { LOCALES } from '@/i18n'

export function LanguageSelect() {
  const { i18n, t } = useTranslation()

  return (
    <select
      aria-label={t('language')}
      value={i18n.resolvedLanguage}
      onChange={(e) => i18n.changeLanguage(e.target.value)}
      className="h-8 rounded-md border bg-transparent px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
    >
      {LOCALES.map((l) => (
        <option key={l.code} value={l.code} className="bg-background text-foreground">
          {l.label}
        </option>
      ))}
    </select>
  )
}
