import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, ZoomIn, ZoomOut, Maximize2, Download } from 'lucide-react'

// Просмотр картинок в полный экран (SPEC §8.36).
//
// Свой, а не библиотека: нужно окно с зумом и перетаскиванием — на это
// хватает сотни строк, а любая готовая тянет свои стили, свою тему и свой
// способ открываться, который придётся переучивать под наш.
//
// Слушает клики глобально: картинки приходят из текста задач, документов и
// заметок, а он один на всё приложение. Иначе пришлось бы вешать обработчик
// в каждом месте, где выводится разметка, и однажды забыть.

type Shot = { src: string; alt: string }

const MIN = 1
const MAX = 6
const STEP = 0.4

export function ImageViewer() {
  const [shot, setShot] = useState<Shot | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number } | null>(null)

  // Клик по картинке в любом тексте — открываем. Слушаем на всём документе:
  // разметка рисуется в разных местах и перерисовывается, вешать обработчики
  // на каждую картинку значило бы следить за их жизненным циклом.
  useEffect(() => {
    const open = (el: HTMLImageElement) => {
      setShot({ src: el.currentSrc || el.src, alt: el.alt || '' })
      setZoom(1)
      setPos({ x: 0, y: 0 })
    }
    const pick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement)?.closest?.('img')
      if (!(el instanceof HTMLImageElement)) return null
      // Только картинки внутри текста: аватарки, логотипы и иконки открывать
      // незачем — это не содержимое, а оформление.
      if (!el.closest('.tiptap-editor, .tiptap-readonly, .doc-editor, .msg-md, .prose')) return null
      if (el.classList.contains('no-zoom')) return null
      return el
    }

    const onClick = (e: MouseEvent) => {
      const el = pick(e)
      if (!el) return
      // В редакторе клик по картинке выделяет её — там открываем двойным,
      // иначе просмотр мешал бы правке.
      if (el.closest('.tiptap-editor, .doc-editor')) return
      e.preventDefault()
      open(el)
    }
    const onDouble = (e: MouseEvent) => {
      const el = pick(e)
      if (!el) return
      e.preventDefault()
      open(el)
    }

    document.addEventListener('click', onClick)
    document.addEventListener('dblclick', onDouble)
    return () => {
      document.removeEventListener('click', onClick)
      document.removeEventListener('dblclick', onDouble)
    }
  }, [])

  // Esc закрывает, стрелки масштабируют — руки остаются на клавиатуре.
  useEffect(() => {
    if (!shot) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShot(null)
      else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(MAX, z + STEP))
      else if (e.key === '-') setZoom((z) => Math.max(MIN, z - STEP))
      else if (e.key === '0') {
        setZoom(1)
        setPos({ x: 0, y: 0 })
      }
    }
    document.addEventListener('keydown', onKey)
    // Фон не должен ехать под окном просмотра.
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [shot])

  if (!shot) return null

  const zoomAt = (delta: number) =>
    setZoom((z) => {
      const next = Math.min(MAX, Math.max(MIN, z + delta))
      // Вернулись к единице — возвращаем и положение, иначе картинка
      // остаётся сдвинутой в углу и кажется потерянной.
      if (next === 1) setPos({ x: 0, y: 0 })
      return next
    })

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/90 backdrop-blur-sm"
      onClick={(e) => {
        // Клик мимо картинки закрывает — привычно по любому просмотрщику.
        if (e.target === e.currentTarget) setShot(null)
      }}
    >
      <div className="flex items-center justify-between gap-2 p-3">
        <span className="min-w-0 flex-1 truncate text-sm text-white/60">{shot.alt}</span>
        <div className="flex items-center gap-1">
          <ViewerButton onClick={() => zoomAt(-STEP)} disabled={zoom <= MIN} title="−">
            <ZoomOut className="size-4" />
          </ViewerButton>
          <span className="w-12 text-center text-xs tabular-nums text-white/60">{Math.round(zoom * 100)}%</span>
          <ViewerButton onClick={() => zoomAt(STEP)} disabled={zoom >= MAX} title="+">
            <ZoomIn className="size-4" />
          </ViewerButton>
          <ViewerButton
            onClick={() => {
              setZoom(1)
              setPos({ x: 0, y: 0 })
            }}
            title="1:1"
          >
            <Maximize2 className="size-4" />
          </ViewerButton>
          <ViewerButton onClick={() => window.open(shot.src, '_blank', 'noopener')} title="↓">
            <Download className="size-4" />
          </ViewerButton>
          <ViewerButton onClick={() => setShot(null)} title="Esc">
            <X className="size-4" />
          </ViewerButton>
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-hidden"
        onWheel={(e) => {
          // Колесо масштабирует: прокручивать тут нечего, а тянуться к
          // кнопкам ради каждого шага — лишнее движение.
          zoomAt(e.deltaY < 0 ? STEP : -STEP)
        }}
        onMouseDown={(e) => {
          if (zoom <= 1) return
          drag.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }
        }}
        onMouseMove={(e) => {
          if (!drag.current) return
          setPos({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y })
        }}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
        onClick={(e) => {
          if (e.target === e.currentTarget) setShot(null)
        }}
      >
        <img
          src={shot.src}
          alt={shot.alt}
          draggable={false}
          onDoubleClick={() => (zoom > 1 ? (setZoom(1), setPos({ x: 0, y: 0 })) : setZoom(2))}
          className="mx-auto block max-h-full max-w-full select-none object-contain"
          style={{
            transform: `translate(${pos.x}px, ${pos.y}px) scale(${zoom})`,
            cursor: zoom > 1 ? (drag.current ? 'grabbing' : 'grab') : 'zoom-in',
            transition: drag.current ? 'none' : 'transform .12s ease-out',
          }}
        />
      </div>
    </div>,
    document.body,
  )
}

function ViewerButton({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) {
  return (
    <button
      type="button"
      {...props}
      className="grid size-8 place-items-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  )
}
