import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { View } from 'react-native'
import { isRTLLanguage } from '../i18n'

// Направление письма для всего дерева.
//
// Направление берётся из ЯЗЫКА приложения, а не из I18nManager.isRTL. Флаг
// вычисляется при создании нативного модуля, до запуска JS, и кэшируется в
// момент импорта — в процессе он уже не обновляется. Измерения на железе
// (Galaxy S21 Ultra, Android 15; iPhone 16 Pro Max) показали: раскладка
// зеркалится правильно, а флаг при этом равен false. То есть код, который ему
// верит, ошибается — но на иврите в ивритском интерфейсе это незаметно,
// потому что там ошибаться не на чем. Вылезает на латинице, телефонах и кодах.
//
// Отсюда два следствия:
//  — раскладку не трогаем вовсе: Yoga зеркалит start/end и 'row' сам;
//  — для двух вещей, которые Yoga вывести не может (направленные значки и
//    textAlign у полей ввода), направление берём отсюда.
//
// direction на View применяется к уже смонтированному узлу сразу, без
// перемонтирования и без перезагрузки бандла — в отличие от forceRTL, который
// на iOS не применяется вовсе.
//
// Расхождение проверено на нашем эмуляторе (Pixel 6 Pro, API 34): при
// lang=he интерфейс отрисовался справа налево, а I18nManager.isRTL при этом
// равнялся false. То есть до этой правки все шесть мест, читавшие флаг,
// работали по случайности — на иврите это незаметно, потому что ошибаться
// там не на чем.

type DirectionValue = {
  dir: 'ltr' | 'rtl'
  /** Признак RTL из языка приложения. НЕ I18nManager.isRTL. */
  isRTL: boolean
  /** Множитель для направленных значков: transform: [{ scaleX: flip }]. */
  flip: 1 | -1
  /** Готовое значение для TextInput.textAlign. */
  textAlign: 'left' | 'right'
}

const DirectionContext = createContext<DirectionValue>({
  dir: 'ltr',
  isRTL: false,
  flip: 1,
  textAlign: 'left',
})

export function DirectionProvider({ lang, children }: { lang: string; children: ReactNode }) {
  const dir: 'ltr' | 'rtl' = isRTLLanguage(lang) ? 'rtl' : 'ltr'

  const value = useMemo<DirectionValue>(
    () => ({
      dir,
      isRTL: dir === 'rtl',
      flip: dir === 'rtl' ? -1 : 1,
      textAlign: dir === 'rtl' ? 'right' : 'left',
    }),
    [dir],
  )

  return (
    <DirectionContext.Provider value={value}>
      <View style={{ flex: 1, direction: dir }}>{children}</View>
    </DirectionContext.Provider>
  )
}

export function useDirection(): DirectionValue {
  return useContext(DirectionContext)
}
