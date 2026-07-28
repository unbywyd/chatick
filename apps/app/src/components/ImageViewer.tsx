import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Download } from 'lucide-react'
import { ZoomableImage } from '@/components/ZoomableImage'

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

export function ImageViewer() {
  const [shot, setShot] = useState<Shot | null>(null)

  // Клик по картинке в любом тексте — открываем. Слушаем на всём документе:
  // разметка рисуется в разных местах и перерисовывается, вешать обработчики
  // на каждую картинку значило бы следить за их жизненным циклом.
  useEffect(() => {
    const open = (el: HTMLImageElement) => setShot({ src: el.currentSrc || el.src, alt: el.alt || '' })
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
      // Открываем по одному клику везде, где текст читают. Двойной остаётся
      // только там, где картинку правят: в редакторе одинарный выделяет её,
      // и перехватывать его значило бы ломать перетаскивание и удаление.
      // «Правят» — это когда поле доступно для ввода, а не просто нарисовано
      // тем же компонентом: у задачи в режиме чтения он тот же самый.
      const editing = el.closest('.tiptap-editor, .doc-editor')
      if (editing && (editing as HTMLElement).isContentEditable) return
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

  // Esc закрывает; масштаб — забота ZoomableImage.
  useEffect(() => {
    if (!shot) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Не даём тому же нажатию закрыть заодно и то, что под просмотром:
      // из задачи Esc закрывал и картинку, и саму задачу.
      e.stopPropagation()
      setShot(null)
    }
    document.addEventListener('keydown', onKey, true)
    // Фон не должен ехать под окном просмотра.
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = prev
    }
  }, [shot])

  if (!shot) return null

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
          <ViewerButton onClick={() => window.open(shot.src, '_blank', 'noopener')} title="↓">
            <Download className="size-4" />
          </ViewerButton>
          <ViewerButton onClick={() => setShot(null)} title="Esc">
            <X className="size-4" />
          </ViewerButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 p-4" onClick={(e) => e.target === e.currentTarget && setShot(null)}>
        <ZoomableImage src={shot.src} alt={shot.alt} />
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
