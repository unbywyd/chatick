import { useCallback, useEffect, useRef, useState } from 'react'

// Перетаскиваемая граница колонки (SPEC §8.29).
// Ширина запоминается: раскладка рабочего стола — личное дело пользователя,
// каждый раз подгонять её заново раздражает.

export function useResizable(storageKey: string, defaultWidth: number, min: number, max: number) {
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(storageKey))
    return saved >= min && saved <= max ? saved : defaultWidth
  })
  const [dragging, setDragging] = useState(false)
  const startX = useRef(0)
  const startW = useRef(0)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      startX.current = e.clientX
      startW.current = width
      setDragging(true)
    },
    [width],
  )

  useEffect(() => {
    if (!dragging) return
    // RTL: перетаскивание вправо должно сужать, а не расширять
    const rtl = document.documentElement.dir === 'rtl'
    const onMove = (e: PointerEvent) => {
      const delta = (e.clientX - startX.current) * (rtl ? -1 : 1)
      setWidth(Math.min(max, Math.max(min, startW.current + delta)))
    }
    const onUp = () => setDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    // пока тянем — не выделяем текст под курсором
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [dragging, min, max])

  useEffect(() => {
    localStorage.setItem(storageKey, String(width))
  }, [storageKey, width])

  return { width, dragging, onPointerDown, reset: () => setWidth(defaultWidth) }
}
