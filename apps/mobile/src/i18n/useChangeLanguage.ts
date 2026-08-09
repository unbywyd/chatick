import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import i18n, { loadFontsFor, storeLanguage, type LocaleCode } from './index'

// Смена языка целиком, одним местом.
//
// Перезапуска здесь больше нет — и это не упрощение, а исправление. Раньше
// смена направления письма требовала I18nManager.forceRTL и перезагрузки
// бандла: флаг читался при создании корневого представления. На iOS этот путь
// не работает вовсе, а на Android он оставлял I18nManager.isRTL
// несогласованным с настоящей раскладкой.
//
// Теперь направление живёт в состоянии приложения: DirectionProvider получает
// язык и ставит direction на корневой View. Смена применяется к уже
// смонтированному дереву мгновенно, одинаково на обеих платформах — человека
// больше не выбрасывает из приложения посреди работы.

export function useChangeLanguage() {
  const { i18n: instance } = useTranslation()

  return useCallback(
    async (target: LocaleCode) => {
      const current = (instance.language ?? 'en') as LocaleCode
      if (current === target) return

      await storeLanguage(target)
      // Шрифт — до смены языка: иначе на кадр между ними интерфейс покажется
      // системным начертанием.
      await loadFontsFor(target)
      await i18n.changeLanguage(target)
    },
    [instance],
  )
}
