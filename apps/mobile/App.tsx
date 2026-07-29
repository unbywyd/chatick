import { useEffect, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api, getToken, type Me } from './src/lib/api'
import { LoginScreen } from './src/screens/LoginScreen'
import { theme } from './src/theme'

// Корень приложения (SPEC.md рядом).
//
// Пока три состояния: проверяем сохранённый вход → экран входа → заглушка
// после входа. Экраны компаний, проектов и чата приезжают следующими шагами;
// каждый шаг должен собираться в APK, поэтому дерево держим рабочим.

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      // Телефон часто теряет сеть в кармане: молчаливое «нет данных» хуже
      // повторной попытки при возвращении в приложение.
      refetchOnWindowFocus: true,
    },
  },
})

type Stage = 'checking' | 'guest' | 'authed'

function Root() {
  const [stage, setStage] = useState<Stage>('checking')
  const [me, setMe] = useState<Me | null>(null)

  const check = async () => {
    const token = await getToken()
    if (!token) return setStage('guest')
    try {
      setMe(await api<Me>('/api/v1/auth/me'))
      setStage('authed')
    } catch {
      // Токен есть, но сервер его не принял — это гость, а не поломка.
      setStage('guest')
    }
  }

  useEffect(() => {
    void check()
  }, [])

  if (stage === 'checking') {
    return (
      <View style={s.splash}>
        <Text style={s.logo}>Chatick</Text>
        <ActivityIndicator color={theme.brand} />
      </View>
    )
  }

  if (stage === 'guest') return <LoginScreen onDone={() => void check()} />

  return (
    <View style={s.splash}>
      <Text style={s.logo}>Chatick</Text>
      <Text style={s.hi}>{me ? `Вошли как ${me.name || me.email}` : ''}</Text>
      <Text style={s.next}>Следующий шаг: выбор компании и список проектов</Text>
    </View>
  )
}

export default function App() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={qc}>
        <StatusBar style="light" />
        <Root />
      </QueryClientProvider>
    </SafeAreaProvider>
  )
}

const s = StyleSheet.create({
  splash: { flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  logo: { color: theme.fg, fontSize: 34, fontWeight: '700' },
  hi: { color: theme.brand, fontSize: 16 },
  next: { color: theme.muted, fontSize: 14, textAlign: 'center' },
})
