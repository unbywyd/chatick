import { DevSettings } from 'react-native'

// Перезагрузка бандла — единственный способ применить смену направления
// письма (Rule 6): I18nManager.forceRTL пишет нативный флаг, который читается
// при создании корневого представления, а не на лету.
//
// В разработке это DevSettings, в собранном приложении — expo-updates. Модуль
// требуем лениво: сборка без нативного модуля тогда деградирует до «не
// перезагрузилось», а не падает при импорте.

export async function restartApp(): Promise<void> {
  if (__DEV__) {
    DevSettings.reload()
    return
  }
  try {
    const Updates = await import('expo-updates')
    await Updates.reloadAsync()
  } catch {
    // Нативного модуля нет — направление применится при следующем ручном
    // запуске. Молча: падать здесь хуже, чем показать один кадр не в ту
    // сторону.
  }
}
