import { StyleSheet, Text, type TextProps, type TextStyle } from 'react-native'
import i18n from '../i18n'
import { useDirection } from '../lib/direction'

// Общая обёртка над <Text> (Rule 3 руководства по RTL).
//
// Зачем вообще: значение textAlign по умолчанию — 'auto', и оно разрешается
// по-разному. Android смотрит на язык самой строки, iOS — на локализацию
// бандла. Симптом ровно такой: на Android всё идеально, а на iOS каждая
// подпись уезжает влево. Это не баг iOS и не поломка вёрстки.
//
// Поэтому направление задаём явно и в ОДНОМ месте, а не рассыпаем по сотням
// вызовов. Здесь же выбирается шрифт: иврит рисуется Heebo.
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

/**
 * Шрифт под язык: Heebo для иврита, Inter для остального.
 *
 * Один шрифт на всё не годится — я сверил таблицы cmap обоих файлов:
 * в Heebo 50 ивритских знаков и НОЛЬ кириллических, в Inter 248
 * кириллических и ноль ивритских. Поставь любой из них на всё приложение —
 * и половина интерфейса осталась бы без начертания и упала на системный
 * шрифт. Латиница есть в обоих, поэтому английский выглядит одинаково.
 *
 * Системный шрифт Android содержит и то, и другое, но рисует иврит сухо и
 * узко: рядом с латиницей это читается как «текст из чужого приложения».
 */
const FONTS: Record<string, Record<string, string>> = {
  he: {
    '400': 'Heebo-Regular',
    normal: 'Heebo-Regular',
    '500': 'Heebo-Medium',
    '600': 'Heebo-Medium',
    '700': 'Heebo-Bold',
    bold: 'Heebo-Bold',
    '800': 'Heebo-Bold',
    '900': 'Heebo-Bold',
  },
  default: {
    '400': 'Inter-Regular',
    normal: 'Inter-Regular',
    '500': 'Inter-Medium',
    '600': 'Inter-Medium',
    '700': 'Inter-Bold',
    bold: 'Inter-Bold',
    '800': 'Inter-Bold',
    '900': 'Inter-Bold',
  },
}

export function Txt({ auto, ltr, style, ...rest }: Props) {
  // Направление — из языка приложения, а не из I18nManager.isRTL: тот флаг
  // снимается при старте нативного модуля и в процессе не обновляется.
  // На железе измерено, что он бывает false при зеркальной раскладке.
  const { isRTL } = useDirection()

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

  // fontWeight вместе с fontFamily не работает: у статических начертаний вес
  // зашит в сам файл, и система, увидев оба, рисует синтетически утолщённый
  // Regular вместо настоящего Bold. Поэтому вес переводим в имя файла и
  // убираем fontWeight из стиля.
  //
  // Смешанная строка (ивритское имя в русском интерфейсе) отрисуется Inter,
  // и ивритские знаки в нём возьмутся из системного запасного шрифта. Это
  // правильнее обратного: назначать Heebo по содержимому строки означало бы
  // проверять каждую на наличие ивритских букв при каждой перерисовке.
  const font: TextStyle = {}
  const table = FONTS[i18n.language] ?? FONTS.default!
  const weight = String(flat?.fontWeight ?? '400')
  font.fontFamily = table[weight] ?? table['400']
  font.fontWeight = undefined

  return <Text {...rest} style={[direction, style, override, font]} />
}
