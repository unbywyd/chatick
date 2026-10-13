import { useEffect, useState } from 'react'
import { comboFromEvent } from '@/lib/shortcuts'

/**
 * Горячие клавиши v2.
 *
 * Поиск и ассистент — на Ctrl (⌘ на Mac), как принято. Остальное — на Alt:
 * Ctrl+T, Ctrl+N, Ctrl+W браузер забирает себе, а Alt свободен и в вебе, и в
 * приложении. Сочетание можно поменять в шпаргалке («?»), хранится на этой
 * машине: оно зависит от клавиатуры, а не от учётной записи.
 */
export type KeyAction = 'search' | 'assistant' | 'newTask' | 'goTasks' | 'goDocs' | 'goNotes' | 'goFiles' | 'goTime' | 'notifications'

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
const MOD = isMac ? 'Meta' : 'Ctrl'

export const KEY_DEFS: { id: KeyAction; combo: string }[] = [
  { id: 'search', combo: `${MOD}+K` },
  { id: 'assistant', combo: `${MOD}+J` },
  { id: 'newTask', combo: 'Alt+T' },
  { id: 'goTasks', combo: 'Alt+K' },
  { id: 'goDocs', combo: 'Alt+D' },
  { id: 'goNotes', combo: 'Alt+N' },
  { id: 'goFiles', combo: 'Alt+F' },
  { id: 'goTime', combo: 'Alt+Y' },
  { id: 'notifications', combo: 'Alt+B' },
]

const STORE = 'chatick_v2_keys'
const EVENT = 'chatick:keys'

type Bindings = Partial<Record<KeyAction, string>>

function load(): Bindings {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, unknown>
    const known = new Set<string>(KEY_DEFS.map((d) => d.id))
    return Object.fromEntries(Object.entries(v).filter(([k, x]) => known.has(k) && typeof x === 'string')) as Bindings
  } catch {
    return {}
  }
}

export function saveBinding(id: KeyAction, combo: string | null) {
  const next = load()
  if (combo) next[id] = combo
  else delete next[id]
  try {
    localStorage.setItem(STORE, JSON.stringify(next))
  } catch {
    /* не запомним — останется по умолчанию */
  }
  window.dispatchEvent(new Event(EVENT))
}

export function resetBindings() {
  try {
    localStorage.removeItem(STORE)
  } catch {
    /* нечего сбрасывать */
  }
  window.dispatchEvent(new Event(EVENT))
}

/** Действующие сочетания; обновляются, когда их меняют в шпаргалке. */
export function useBindings(): Record<KeyAction, string> {
  const [b, setB] = useState(load)
  useEffect(() => {
    const on = () => setB(load())
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [])
  return Object.fromEntries(KEY_DEFS.map((d) => [d.id, b[d.id] ?? d.combo])) as Record<KeyAction, string>
}

/** Сочетание из события в виде «Ctrl+K» (по физической клавише, раскладка не важна). */
export const comboOf = (e: KeyboardEvent) => comboFromEvent(e)

/** Как показать: на Mac — значками, иначе — словами через пробел. */
export function showCombo(combo: string): string {
  if (isMac) return combo.replace('Ctrl', '⌃').replace('Meta', '⌘').replace('Alt', '⌥').replace('Shift', '⇧').replace(/\+/g, '')
  return combo.replace(/\+/g, ' ')
}

/** Человек печатает: Alt-сочетания тогда не перехватываем (на Mac ⌥ набирает символы). */
export function typing(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
}
