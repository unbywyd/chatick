import Svg, { Circle, Path, Rect } from 'react-native-svg'
import { I18nManager, type StyleProp, type ViewStyle } from 'react-native'
import { theme } from '../theme'

// Иконки интерфейса.
//
// Контуры взяты из lucide — того же набора, что в вебе: приложения должны
// выглядеть роднёй, а не двумя разными продуктами. Файл собран скриптом из
// lucide-react, руками контуры не переписывались.
//
// Раньше здесь стояли эмодзи (🔔) и типографские знаки (▶, ›). Эмодзи рисует
// система: он цветной, чужой по стилю, разный на Android и iOS и не
// подчиняется цвету текста — рядом с нашей графикой это выглядит как чужая
// наклейка. Знаки же берутся из шрифта: толщина у них своя, к сетке они не
// выровнены, и как иконки читаются плохо.
//
// Все иконки — одна толщина линии и один размер по умолчанию.

type IconProps = {
  size?: number
  color?: string
  /** Толщина линии. Мельче 20px её стоит поднимать, иначе штрих истончается. */
  strokeWidth?: number
  style?: StyleProp<ViewStyle>
  /**
   * Направленный знак: в RTL отражается по горизонтали. React Native
   * переворачивает раскладку, но не содержимое рисунка — стрелка, указывающая
   * «дальше», иначе продолжит показывать в прежнюю сторону.
   */
  directional?: boolean
}

function Icon({
  size = 20,
  color = theme.fg,
  strokeWidth = 2,
  style,
  directional,
  children,
}: IconProps & { children: React.ReactNode }) {
  const flip = directional && I18nManager.isRTL
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={[flip ? { transform: [{ scaleX: -1 }] } : null, style]}
    >
      {children}
    </Svg>
  )
}

/** Уведомления. */
export function IconBell(p: IconProps) {
  return (
    <Icon {...p}>
      <Path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <Path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
    </Icon>
  )
}

/** Пуск таймера. Заливкой, а не контуром: сплошной треугольник
 *  читается как кнопка действия, а контурный — как декорация. */
export function IconPlay(p: IconProps) {
  return (
    <Icon {...p} directional>
      <Path fill={p.color ?? theme.fg} d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />
    </Icon>
  )
}

/** Пауза. */
export function IconPause(p: IconProps) {
  return (
    <Icon {...p}>
      <Rect fill={p.color ?? theme.fg} x="14" y="3" width="5" height="18" rx="1" />
      <Rect fill={p.color ?? theme.fg} x="5" y="3" width="5" height="18" rx="1" />
    </Icon>
  )
}

/** «Дальше». Направленный: в RTL смотрит в другую сторону. */
export function IconChevronRight(p: IconProps) {
  return (
    <Icon {...p} directional>
      <Path d="m9 18 6-6-6-6" />
    </Icon>
  )
}

/** Создать. */
export function IconPlus(p: IconProps) {
  return (
    <Icon {...p}>
      <Path d="M5 12h14" />
      <Path d="M12 5v14" />
    </Icon>
  )
}

/** Выбрано. */
export function IconCheck(p: IconProps) {
  return (
    <Icon {...p}>
      <Path d="M20 6 9 17l-5-5" />
    </Icon>
  )
}

/** Выход. Направленный: стрелка указывает наружу. */
export function IconLogOut(p: IconProps) {
  return (
    <Icon {...p} directional>
      <Path d="m16 17 5-5-5-5" />
      <Path d="M21 12H9" />
      <Path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    </Icon>
  )
}

/** Поиск. */
export function IconSearch(p: IconProps) {
  return (
    <Icon {...p}>
      <Path d="m21 21-4.34-4.34" />
      <Circle cx="11" cy="11" r="8" />
    </Icon>
  )
}

/** Компания — запасной знак, когда нет логотипа. */
export function IconBuilding(p: IconProps) {
  return (
    <Icon {...p}>
      <Path d="M10 12h4" />
      <Path d="M10 8h4" />
      <Path d="M14 21v-3a2 2 0 0 0-4 0v3" />
      <Path d="M6 10H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2" />
      <Path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16" />
    </Icon>
  )
}

/** Участники. */
export function IconUsers(p: IconProps) {
  return (
    <Icon {...p}>
      <Path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <Path d="M16 3.128a4 4 0 0 1 0 7.744" />
      <Path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <Circle cx="9" cy="7" r="4" />
    </Icon>
  )
}

/** Сообщения. */
export function IconMessageSquare(p: IconProps) {
  return (
    <Icon {...p}>
      <Path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
    </Icon>
  )
}

/** Язык. */
export function IconGlobe(p: IconProps) {
  return (
    <Icon {...p}>
      <Circle cx="12" cy="12" r="10" />
      <Path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <Path d="M2 12h20" />
    </Icon>
  )
}

/** Повторить. */
export function IconRefresh(p: IconProps) {
  return (
    <Icon {...p}>
      <Path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <Path d="M21 3v5h-5" />
      <Path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <Path d="M8 16H3v5" />
    </Icon>
  )
}
