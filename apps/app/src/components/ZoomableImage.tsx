import { useEffect, useRef, useState } from 'react'
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react'

// Картинка с масштабом и перетаскиванием.
//
// Отдельно от просмотрщиков, потому что их два: свой для картинок внутри
// текста и общий FileViewer для вложений и файлов проекта — он умеет ещё
// pdf, видео и звук. Зум нужен обоим, а дублировать его значило бы однажды
// починить в одном месте и забыть про другое.

const MIN = 1
const MAX = 6
const STEP = 0.4

export function ZoomableImage({
  src,
  alt,
  onBackdropClick,
}: {
  src: string
  alt: string
  /** Клик по пустому полю вокруг картинки: в просмотрщике им закрывают окно. */
  onBackdropClick?: () => void
}) {
  const [zoom, setZoom] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number } | null>(null)

  const reset = () => {
    setZoom(1)
    setPos({ x: 0, y: 0 })
  }

  const zoomBy = (delta: number) =>
    setZoom((z) => {
      const next = Math.min(MAX, Math.max(MIN, z + delta))
      // Вернулись к единице — возвращаем и положение: иначе картинка
      // остаётся сдвинутой в углу и кажется потерянной.
      if (next === 1) setPos({ x: 0, y: 0 })
      return next
    })

  // Другая картинка — начинаем с чистого листа.
  useEffect(reset, [src])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '+' || e.key === '=') zoomBy(STEP)
      else if (e.key === '-') zoomBy(-STEP)
      else if (e.key === '0') reset()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div
      className="relative flex size-full items-center justify-center overflow-hidden"
      // Поле вокруг картинки принадлежит этому блоку, а не просмотрщику: он
      // отдал ему всю площадь. Поэтому закрывать по клику мимо приходится
      // отсюда. При увеличении не закрываем: там клик мимо — это перетаскивание,
      // и окно захлопывалось бы посреди разглядывания.
      onClick={(e) => {
        if (e.target === e.currentTarget && zoom === 1) onBackdropClick?.()
      }}
      onWheel={(e) => zoomBy(e.deltaY < 0 ? STEP : -STEP)}
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
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        onDoubleClick={() => (zoom > 1 ? reset() : setZoom(2))}
        className="max-h-full max-w-full select-none rounded-lg object-contain"
        style={{
          transform: `translate(${pos.x}px, ${pos.y}px) scale(${zoom})`,
          cursor: zoom > 1 ? (drag.current ? 'grabbing' : 'grab') : 'zoom-in',
          transition: drag.current ? 'none' : 'transform .12s ease-out',
        }}
      />

      {/* Кнопки внизу по центру: у верхнего края уже живёт шапка просмотрщика */}
      <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-lg bg-black/60 p-1 backdrop-blur-sm">
        <ZoomButton onClick={() => zoomBy(-STEP)} disabled={zoom <= MIN}>
          <ZoomOut className="size-4" />
        </ZoomButton>
        <span className="w-12 text-center text-xs tabular-nums text-white/70">{Math.round(zoom * 100)}%</span>
        <ZoomButton onClick={() => zoomBy(STEP)} disabled={zoom >= MAX}>
          <ZoomIn className="size-4" />
        </ZoomButton>
        <ZoomButton onClick={reset} disabled={zoom === 1}>
          <Maximize2 className="size-4" />
        </ZoomButton>
      </div>
    </div>
  )
}

function ZoomButton({
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
