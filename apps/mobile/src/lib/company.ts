import AsyncStorage from '@react-native-async-storage/async-storage'

// Какая компания выбрана. Хранится между запусками: человек работает в одной
// и той же изо дня в день, и заставлять его выбирать заново при каждом входе —
// лишний экран на пути к делу.
//
// AsyncStorage, а не SecureStore: это не секрет, а идентификатор пространства.
// Прав он не даёт — доступ всё равно проверяется по токену на сервере.

const KEY = 'chatick.companyId'

export async function getCompanyId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(KEY)
  } catch {
    // Хранилище может быть недоступно — это не повод не пустить в приложение,
    // человек просто выберет компанию руками.
    return null
  }
}

export async function setCompanyId(id: string | null): Promise<void> {
  try {
    if (id) await AsyncStorage.setItem(KEY, id)
    else await AsyncStorage.removeItem(KEY)
  } catch {
    // Не сохранилось — выбор действует до конца сеанса.
  }
}
