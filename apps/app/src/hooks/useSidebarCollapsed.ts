import { useEffect, useState } from 'react'

// Свёрнут ли список проектов. Состояние нужно двоим: самому сайдбару (что
// рисовать) и колонке вокруг него (какой ширины быть) — иначе колонка остаётся
// широкой и рядом со свёрнутым сайдбаром зияет пустота.

const KEY = 'chatick_sidebar_collapsed'
const EVENT = 'chatick:sidebar-collapsed'

const read = () => localStorage.getItem(KEY) !== '0'

export function useSidebarCollapsed(): [boolean, () => void] {
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
