import { useState } from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'
import { theme } from '../theme'

// Аватар компании, проекта или человека.
//
// Лого может не загрузиться — сеть в телефоне пропадает постоянно. Тогда
// показываем букву на цвете проекта, а не пустой квадрат: по цвету и букве
// строку в списке всё ещё можно узнать.

const initial = (name: string) => (name.trim()[0] ?? '?').toUpperCase()

export function Avatar({
  name,
  logoUrl,
  color,
  size = 44,
  round = false,
}: {
  name: string
  logoUrl: string | null
  /** цвет проекта — фон подложки, когда лого нет */
  color?: string | null
  size?: number
  round?: boolean
}) {
  const [failed, setFailed] = useState(false)
  const radius = round ? size / 2 : Math.round(size * 0.24)
  const box = { width: size, height: size, borderRadius: radius }

  if (logoUrl && !failed) {
    return <Image source={{ uri: logoUrl }} style={box} onError={() => setFailed(true)} />
  }

  return (
    <View style={[box, s.fallback, color ? { backgroundColor: color } : null]}>
      <Text style={[s.letter, { fontSize: size * 0.4 }, color ? s.onColor : null]}>{initial(name)}</Text>
    </View>
  )
}

const s = StyleSheet.create({
  fallback: { backgroundColor: theme.cardSoft, alignItems: 'center', justifyContent: 'center' },
  letter: { color: theme.fg, fontWeight: '700' },
  // На цветной подложке белым: цвета проектов светлые, и theme.fg на них тонет.
  onColor: { color: '#fff' },
})
