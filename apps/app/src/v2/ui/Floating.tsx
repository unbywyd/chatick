import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Всплывающий слой поверх страницы, привязанный к кнопке.
 *
 * Внутри ячеек таблицы абсолютное окно обрезалось (у ячеек overflow:hidden
 * ради многоточий): человек видел одно поле поиска без списка и думал, что
 * поиск не работает. Здесь слой уходит в корень .app (там переменные темы),
 * встаёт фиксированно под кнопкой, а если внизу тесно — над ней.
 */
export function Floating({
  anchor,
  onClose,
  children,
  className,
  align = 'start',
}: {
  anchor: HTMLElement | null
  onClose: () => void
  children: React.ReactNode
  className?: string
  align?: 'start' | 'end'
}) {
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null)
  const [box, setBox] = useState<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    if (!anchor) return
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const h = box?.offsetHeight ?? 320
      const w = box?.offsetWidth ?? 280
      const up = r.bottom + 6 + h > window.innerHeight - 8 && r.top - 6 - h > 8
      const rtl = anchor.closest('[dir="rtl"]') !== null
      const startLeft = rtl ? r.right - w : r.left
      const endLeft = rtl ? r.left : r.right - w
      let left = align === 'end' ? endLeft : startLeft
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
      setPos({ top: up ? r.top - 6 - h : r.bottom + 6, left, up })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor, box, align])

  // Окно появляется невидимым, пока считает место, — autoFocus в нём не
  // срабатывает. Ставим фокус в поле, как только окно встало.
  const placed = pos !== null
  useLayoutEffect(() => {
    if (!placed || !box) return
    const f = box.querySelector<HTMLElement>('input[autofocus], input, [role="listbox"]')
    f?.focus()
  }, [placed, box])

  useLayoutEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])

  const root = (anchor?.closest('.app') as HTMLElement | null) ?? document.body
  return createPortal(
    <>
      <div className="fl-scrim" onMouseDown={onClose} />
      <div
        ref={setBox}
        className={'fl-pop' + (className ? ' ' + className : '')}
        role="dialog"
        style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}
      >
        {children}
      </div>
    </>,
    root,
  )
}

/**
 * Нечёткое совпадение имени: без регистра, ё = е, и по латинице —
 * «Элиша» находит Elisha, «Хадиль» — Hadeel. Имена в профилях латиницей,
 * а набирают их как слышат.
 */
const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}
const norm = (s: string) => s.toLowerCase().replace(/[\s\-_.]+/g, '')
const lat = (s: string) => norm(s).split('').map((c) => CYR[c] ?? c).join('')
const skel = (s: string) => lat(s).replace(/[aeiouy]/g, '').replace(/(.)\1+/g, '$1')

export function fuzzyMatch(name: string, query: string): boolean {
  const q = query.trim()
  if (!q) return true
  const n = norm(name)
  if (n.includes(norm(q))) return true
  if (lat(name).includes(lat(q))) return true
  // Согласные: «Хадил» ~ Hadeel, «Элиша» ~ Elisha — последний, грубый уровень.
  const sq = skel(q)
  return sq.length >= 2 && skel(name).includes(sq)
}
