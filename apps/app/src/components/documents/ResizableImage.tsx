import Image from '@tiptap/extension-image'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { withDocImageAuth } from '@/lib/api'

// Изображение с ресайзом и выравниванием (SPEC §8.25).
// Штатный @tiptap/extension-image ресайза не умеет — расширяем атрибутами
// width/align и рисуем собственный node view с ручками по углам.

function ImageView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const { src, alt, title, width, align } = node.attrs as {
    src: string
    alt?: string
    title?: string
    width?: string | null
    align?: string
  }
  const wrapRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const editable = editor.isEditable

  // тянем за угол → меняем ширину в процентах от ширины редактора
  const startResize = (e: React.PointerEvent, dir: 'left' | 'right') => {
    e.preventDefault()
    e.stopPropagation()
    const img = wrapRef.current?.querySelector('img')
    const container = wrapRef.current?.parentElement
    if (!img || !container) return

    const startX = e.clientX
    const maxW = container.getBoundingClientRect().width
    // Стартовая ширина — фактически отрисованная ширина картинки.
    // Пока атрибут width не задан, обёртка тянется на всю строку, но сама
    // картинка ограничена своим натуральным размером — поэтому берём его,
    // иначе первое же движение прыгало на 100%.
    const rendered = img.getBoundingClientRect().width
    const natural = img.naturalWidth || rendered
    const startW = Math.min(width ? rendered : Math.min(rendered, natural), maxW)
    // фиксируем текущий размер сразу: дальше все расчёты идут от заданного
    // width, и поведение первого перетаскивания не отличается от последующих
    if (!width) updateAttributes({ width: `${Math.round((startW / maxW) * 100)}%` })
    setDragging(true)

    const onMove = (ev: PointerEvent) => {
      const delta = dir === 'right' ? ev.clientX - startX : startX - ev.clientX
      const next = Math.min(maxW, Math.max(80, startW + delta))
      updateAttributes({ width: `${Math.round((next / maxW) * 100)}%` })
    }
    const onUp = () => {
      setDragging(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const Handle = ({ dir }: { dir: 'left' | 'right' }) => (
    <span
      onPointerDown={(e) => startResize(e, dir)}
      className={cn(
        'absolute top-1/2 z-10 h-9 w-2 -translate-y-1/2 cursor-ew-resize rounded-full bg-brand opacity-0 shadow transition-opacity group-hover:opacity-100',
        selected && 'opacity-100',
        dir === 'right' ? '-end-1' : '-start-1',
      )}
    />
  )

  return (
    <NodeViewWrapper
      className={cn(
        'doc-image-wrap group relative my-2',
        align === 'center' && 'mx-auto',
        align === 'right' && 'ms-auto',
      )}
      style={{ width: width ?? 'auto', maxWidth: '100%' }}
      data-drag-handle
    >
      <div ref={wrapRef} className="relative">
        <img
          // токен подставляем только на показ: в Y.Doc и в сохранённом HTML
          // src лежит без него, иначе токен протух бы прямо в документе
          src={withDocImageAuth(src)}
          alt={alt ?? ''}
          title={title ?? ''}
          draggable={false}
          className={cn(
            'doc-image w-full rounded-lg',
            selected && 'outline outline-2 outline-brand',
            dragging && 'select-none',
          )}
        />
        {editable && (
          <>
            <Handle dir="left" />
            <Handle dir="right" />
            {/* быстрые размеры и выравнивание */}
            <div
              className={cn(
                'absolute start-1/2 top-1.5 z-10 flex -translate-x-1/2 gap-0.5 rounded-md border bg-popover/95 p-0.5 text-[11px] shadow-md backdrop-blur transition-opacity',
                selected ? 'opacity-100' : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100',
              )}
              contentEditable={false}
            >
              {(['25%', '50%', '100%'] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => updateAttributes({ width: w })}
                  className={cn(
                    'rounded px-1.5 py-0.5 hover:bg-secondary',
                    width === w && 'bg-primary text-primary-foreground hover:bg-primary',
                  )}
                >
                  {w}
                </button>
              ))}
              <span className="mx-0.5 w-px bg-border" />
              {([
                ['left', '⭰'],
                ['center', '⭤'],
                ['right', '⭲'],
              ] as const).map(([a, icon]) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => updateAttributes({ align: a })}
                  className={cn(
                    'rounded px-1.5 py-0.5 hover:bg-secondary',
                    align === a && 'bg-primary text-primary-foreground hover:bg-primary',
                  )}
                >
                  {icon}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </NodeViewWrapper>
  )
}

export const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => el.getAttribute('width') || el.style.width || null,
        renderHTML: (attrs) => (attrs.width ? { width: attrs.width, style: `width:${attrs.width}` } : {}),
      },
      align: {
        default: 'left',
        parseHTML: (el) => el.getAttribute('data-align') || 'left',
        renderHTML: (attrs) => (attrs.align && attrs.align !== 'left' ? { 'data-align': attrs.align } : {}),
      },
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView)
  },
})
