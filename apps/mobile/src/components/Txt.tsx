import { I18nManager, StyleSheet, Text, type TextProps, type TextStyle } from 'react-native'

// Общая обёртка над <Text> (Rule 3 руководства по RTL).
//
// Зачем вообще: значение textAlign по умолчанию — 'auto', и оно разрешается
// по-разному. Android смотрит на язык самой строки, iOS — на локализацию
// бандла. Симптом ровно такой: на Android всё идеально, а на iOS каждая
// подпись уезжает влево. Это не баг iOS и не поломка вёрстки.
//
// Поэтому направление задаём явно и в ОДНОМ месте, а не рассыпаем по сотням
// вызовов.
//
// Исключение — строки смешанного или неизвестного письма: имя проекта на
// иврите, сообщение с латиницей и цифрами, адрес. Им direction прибивать
// нельзя, иначе куски переставляются местами. Для них есть auto.

type Props = TextProps & {
  /**
   * Содержимое неизвестного направления — имена, сообщения, всё, что ввёл
   * человек. Выравнивание отдаём платформе, а не решаем за неё.
   */
  auto?: boolean
  /** Всегда слева направо: телефоны, почта, ссылки, номера задач (Rule 5). */
  ltr?: boolean
}

export function Txt({ auto, ltr, style, ...rest }: Props) {
  const isRTL = I18nManager.isRTL

  const direction: TextStyle = ltr
    ? // Цифры и латиница в RTL-окружении иначе переставляются группами —
      // это порча данных, а не косметика.
      { textAlign: 'left', writingDirection: 'ltr' }
    : auto
      ? { textAlign: 'auto' }
      : { textAlign: isRTL ? 'right' : 'left', writingDirection: isRTL ? 'rtl' : 'ltr' }

  // Свой textAlign из style должен побеждать: у заголовков по центру он есть.
  const flat = StyleSheet.flatten(style) as TextStyle | undefined
  const override: TextStyle = {}
  if (flat?.textAlign) override.textAlign = flat.textAlign
  if (flat?.writingDirection) override.writingDirection = flat.writingDirection

  return <Text {...rest} style={[direction, style, override]} />
}
