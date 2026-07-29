import { useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { signInWithGoogle } from '../lib/auth'
import { theme } from '../theme'

// Вход. Одна кнопка: пароля у нас нет, письма с кодом — тоже.
//
// Кнопка НЕ блокируется на время ожидания: в браузере что-то могло пойти не
// так, и человек вправе начать заново, не дожидаясь десяти минут. В десктопе
// эта блокировка уже стоила залипшего экрана — повторять не будем.

export function LoginScreen({ onDone }: { onDone: () => void }) {
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Номер попытки: по нему прежний опрос понимает, что больше не нужен.
  const attempt = useRef(0)

  const start = async () => {
    const mine = ++attempt.current
    setError(null)
    setWaiting(true)
    try {
      const res = await signInWithGoogle(() => attempt.current !== mine)
      if (attempt.current !== mine) return
      if (res === 'ok') return onDone()
      if (res === 'denied') setError('Доступ не подтверждён')
      if (res === 'expired') setError('Вход занял слишком много времени. Попробуйте ещё раз.')
    } catch {
      if (attempt.current === mine) setError('Не получилось войти. Проверьте связь и попробуйте ещё раз.')
    } finally {
      if (attempt.current === mine) setWaiting(false)
    }
  }

  const cancel = () => {
    attempt.current++
    setWaiting(false)
    setError(null)
  }

  return (
    <View style={s.root}>
      <View style={s.top}>
        <Text style={s.title}>
          Streamline teamwork,{'\n'}
          <Text style={s.titleAccent}>one chat</Text> at a time
        </Text>
        <Text style={s.sub}>A chat platform built for efficient project teamwork.</Text>
      </View>

      <View style={s.bottom}>
        {error ? <Text style={s.error}>{error}</Text> : null}

        <Pressable style={s.btn} onPress={start}>
          {waiting ? <ActivityIndicator color={theme.brandFg} /> : null}
          <Text style={s.btnText}>{waiting ? 'Попробовать ещё раз' : 'Sign in with Google'}</Text>
        </Pressable>

        {waiting ? (
          <>
            <Text style={s.hint}>Ждём завершения входа в браузере…</Text>
            <Pressable onPress={cancel} hitSlop={12}>
              <Text style={s.cancel}>Отмена</Text>
            </Pressable>
          </>
        ) : null}
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, paddingHorizontal: 24, justifyContent: 'space-between' },
  top: { paddingTop: 120 },
  title: { color: theme.fg, fontSize: 40, fontWeight: '700', lineHeight: 46 },
  titleAccent: { color: theme.brand },
  sub: { color: theme.muted, fontSize: 16, marginTop: 16, lineHeight: 22 },
  bottom: { paddingBottom: 56, gap: 12, alignItems: 'center' },
  error: { color: theme.danger, fontSize: 14, textAlign: 'center', marginBottom: 4 },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: theme.brand,
    borderRadius: 999,
    paddingVertical: 18,
    width: '100%',
  },
  btnText: { color: theme.brandFg, fontSize: 16, fontWeight: '700' },
  hint: { color: theme.muted, fontSize: 14 },
  cancel: { color: theme.muted, fontSize: 13, textDecorationLine: 'underline' },
})
