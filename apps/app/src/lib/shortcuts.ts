// Горячие клавиши: определения, хранение и разбор сочетаний (SPEC §8.36).
//
// Модификатор по умолчанию — Alt. Ctrl и Cmd отпадают: Ctrl+T, Ctrl+N, Ctrl+W
// браузер забирает себе и до приложения они не доходят вовсе, так что
// одинаково работать в вебе и в Electron они не могут. Alt свободен.

/** Что умеют горячие клавиши. Порядок — как на странице настройки. */
export type ActionId =
  | 'newTask'
  | 'newDocument'
  | 'addResource'
  | 'focusChat'
  | 'focusAi'
  | 'goTasks'
  | 'goFiles'
  | 'goTime'

export type ShortcutDef = {
  id: ActionId
  /** ключ в словаре: shortcuts.actions.<id> */
  defaultCombo: string
  /** группа на странице настройки */
  group: 'create' | 'navigate' | 'chat'
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: 'newTask', defaultCombo: 'Alt+T', group: 'create' },
  { id: 'newDocument', defaultCombo: 'Alt+D', group: 'create' },
  { id: 'addResource', defaultCombo: 'Alt+R', group: 'create' },
  { id: 'focusChat', defaultCombo: 'Alt+C', group: 'chat' },
  { id: 'focusAi', defaultCombo: 'Alt+I', group: 'chat' },
  { id: 'goTasks', defaultCombo: 'Alt+K', group: 'navigate' },
  { id: 'goFiles', defaultCombo: 'Alt+F', group: 'navigate' },
  { id: 'goTime', defaultCombo: 'Alt+Y', group: 'navigate' },
]

export type Bindings = Partial<Record<ActionId, string>>

const STORAGE_KEY = 'shortcuts'

/**
 * Настройки лежат локально: сочетание зависит от клавиатуры и привычек
 * человека за конкретной машиной, а не от учётной записи.
 */
export function loadBindings(): Bindings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const known = new Set<string>(SHORTCUTS.map((s) => s.id))
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        ([k, v]) => known.has(k) && typeof v === 'string',
      ),
    ) as Bindings
  } catch {
    return {}
  }
}

export function saveBindings(next: Bindings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  // Слушатель живёт в другом дереве — событие дешевле, чем общий контекст.
  window.dispatchEvent(new CustomEvent('shortcuts:changed'))
}

/** Действующее сочетание: своё, если задано, иначе из коробки. */
export function comboOf(id: ActionId, bindings: Bindings): string {
  return bindings[id] ?? SHORTCUTS.find((s) => s.id === id)?.defaultCombo ?? ''
}

/**
 * Сочетание из события — в канонический вид: «Alt+Shift+T».
 *
 * Берём e.code, а не e.key: с Alt раскладка отдаёт в key символы вроде «†» или
 * кириллицу, и записанное на одной раскладке сочетание перестало бы работать
 * на другой. code привязан к физической клавише и от раскладки не зависит.
 */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const code = e.code
  let key: string
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5)
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code
  else return null

  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.metaKey) parts.push('Meta')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  // Без модификатора это обычный ввод текста, а не команда.
  if (!parts.length) return null
  parts.push(key)
  return parts.join('+')
}

/** Показ сочетания: на Mac принято рисовать значки, а не слова. */
export function displayCombo(combo: string): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
  if (!mac) return combo
  return combo
    .replace('Ctrl', '⌃')
    .replace('Meta', '⌘')
    .replace('Alt', '⌥')
    .replace('Shift', '⇧')
    .replace(/\+/g, '')
}

/**
 * Занято ли сочетание другим действием — чтобы две команды не спорили за одну
 * клавишу. Возвращает конфликтующее действие или null.
 */
export function findConflict(combo: string, id: ActionId, bindings: Bindings): ActionId | null {
  for (const s of SHORTCUTS) {
    if (s.id === id) continue
    if (comboOf(s.id, bindings) === combo) return s.id
  }
  return null
}
