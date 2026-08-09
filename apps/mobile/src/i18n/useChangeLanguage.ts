import { useCallback } from 'react'
import { I18nManager } from 'react-native'
import { useTranslation } from 'react-i18next'
import i18n, { isRTLLanguage, storeLanguage, type LocaleCode } from './index'
import { restartApp } from './restart'

// Смена языка целиком, одним местом (Rule 7).
//
// Перезапуск нужен ТОЛЬКО при смене направления письма: иврит → английский
// требует его, а русский → английский нет. Перезапускать всегда — значит
// дёргать человека там, где смена должна быть мгновенной.

export type ChangeLanguageOptions = {
  /** Спросить подтверждение перед перезапуском. Возвращает false — отменяем. */
  onDirectionChange?: () => Promise<boolean> | boolean
}

export function useChangeLanguage() {
  const { i18n: instance } = useTranslation()

  return useCallback(
    async (target: LocaleCode, options: ChangeLanguageOptions = {}) => {
      const current = (instance.language ?? 'en') as LocaleCode
      if (current === target) return

      const directionChanged = isRTLLanguage(current) !== isRTLLanguage(target)

      await storeLanguage(target)
      await i18n.changeLanguage(target)

      if (!directionChanged) return

      // Направление меняется — спрашиваем, если экран этого просил.
      const ok = options.onDirectionChange ? await options.onDirectionChange() : true
      if (!ok) return

      I18nManager.forceRTL(isRTLLanguage(target))
      await restartApp()
    },
    [instance],
  )
}
