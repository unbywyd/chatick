import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, getToken, setToken, type CompaniesResponse, type Company, type Me } from './src/lib/api'
import { getCompanyId, setCompanyId } from './src/lib/company'
import { bootstrapLanguage } from './src/i18n'
import { DirectionProvider } from './src/lib/direction'
import { LoginScreen } from './src/screens/LoginScreen'
import { CompanyPickerScreen } from './src/screens/CompanyPickerScreen'
import { HomeScreen } from './src/screens/HomeScreen'
import { theme } from './src/theme'

// Корень приложения (SPEC.md рядом).
//
// Путь: проверяем сохранённый вход → вход → выбор компании → главная.
// Компания обязательна: токен действует на всю компанию, и без неё непонятно,
// чьи проекты показывать (SPEC §4.3).

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

type Stage = 'checking' | 'guest' | 'picking' | 'ready'

function Root() {
  const [stage, setStage] = useState<Stage>('checking')
  const [me, setMe] = useState<Me | null>(null)
  const [company, setCompany] = useState<Company | null>(null)

  const check = useCallback(async () => {
    // Язык и шрифты — раньше всего остального. Направление письма при этом
    // не требует ни флага, ни перезагрузки: его задаёт DirectionProvider.
    await bootstrapLanguage()

    const token = await getToken()
    if (!token) return setStage('guest')
    try {
      setMe(await api<Me>('/api/v1/auth/me'))
    } catch {
      // Токен есть, но сервер его не принял — это гость, а не поломка.
      return setStage('guest')
    }

    // Компанию, выбранную в прошлый раз, подтверждаем у сервера, а не берём
    // на веру: из неё могли исключить, и тогда приложение открылось бы на
    // пространстве, куда доступа больше нет, и упало бы на первом запросе.
    try {
      const saved = await getCompanyId()
      if (saved) {
        const { companies } = await api<CompaniesResponse>('/api/v1/companies')
        const found = companies.find((c) => c.id === saved)
        if (found) {
          setCompany(found)
          return setStage('ready')
        }
        await setCompanyId(null)
      }
    } catch {
      // Список не пришёл — покажем экран выбора, там будет и ошибка, и повтор.
    }
    setStage('picking')
  }, [])

  useEffect(() => {
    void check()
  }, [check])

  const pick = useCallback((c: Company) => {
    void setCompanyId(c.id)
    setCompany(c)
    setStage('ready')
  }, [])

  const logout = useCallback(async () => {
    await setToken(null)
    await setCompanyId(null)
    // Чужие данные не должны пережить выход: без сброса кэша следующий вход
    // на мгновение показал бы компании и уведомления предыдущего человека.
    qc.clear()
    setMe(null)
    setCompany(null)
    setStage('guest')
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

  if (stage === 'picking' || !company) {
    return <CompanyPickerScreen onPick={pick} onLogout={() => void logout()} />
  }

  return (
    <HomeScreen
      me={me}
      company={company}
      onSwitchCompany={() => setStage('picking')}
      onLogout={() => void logout()}
    />
  )
}

function App() {
  // Язык из i18next: провайдер должен перерисоваться при его смене, иначе
  // направление останется прежним до перезапуска.
  const { i18n: instance } = useTranslation()
  return (
    <SafeAreaProvider>
      {/* Без этого провайдера компоненты клавиатуры молча ничего не делают.
          Клавиатура нужна именно так: под edge-to-edge (включён в
          gradle.properties) Android 15 больше не двигает окно сам, и поле
          ввода внутри ScrollView или Modal остаётся под клавиатурой. */}
      <KeyboardProvider>
        <QueryClientProvider client={qc}>
          <StatusBar style="light" />
          {/* Направление всего дерева — из языка приложения. */}
          <DirectionProvider lang={instance.language ?? 'en'}>
            <Root />
          </DirectionProvider>
        </QueryClientProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  )
}

export default App

const s = StyleSheet.create({
  splash: { flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  logo: { color: theme.fg, fontSize: 34, fontWeight: '700' },
})
