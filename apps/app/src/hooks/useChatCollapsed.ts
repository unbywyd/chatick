import { useEffect, useState } from 'react'

// Свёрнут ли чат. Состояние нужно двоим: самой панели (что рисовать) и колонке
// вокруг неё (какой ширины быть) — иначе рядом со свёрнутым чатом остаётся
// пустая широкая колонка.
//
// По умолчанию свёрнут: в проект заходят работать с задачами, а разговор
// открывают, когда он нужен. Развёрнутый по умолчанию чат отнимал половину
// экрана у того, кто пришёл посмотреть доску.

const KEY = 'chatick_chat_collapsed'
const EVENT = 'chatick:chat-collapsed'

// Умолчание — свёрнут: пусто в хранилище читаем как «да».
const read = () => localStorage.getItem(KEY) !== '0'

export function useChatCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(read)

  useEffect(() => {
    // одно окно, два подписчика — синхронизируем своим событием
    const onChange = () => setCollapsed(read())
    window.addEventListener(EVENT, onChange)
    return () => window.removeEventListener(EVENT, onChange)
  }, [])

  const toggle = () => {
    localStorage.setItem(KEY, read() ? '0' : '1')
    window.dispatchEvent(new Event(EVENT))
  }

  return [collapsed, toggle]
}
