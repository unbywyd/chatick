import { cn } from '@/lib/utils'

// Опознавательный знак проекта: логотип, если загружен, иначе первая буква
// на цветном фоне. В свёрнутом сайдбаре это всё, что человек видит,
// поэтому цвет раздаётся каждому проекту при создании.

/** Первая буква названия — берём графемой, чтобы не расколоть эмодзи. */
function initial(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  const [first] = Array.from(trimmed)
  return (first ?? '?').toUpperCase()
}

export function ProjectBadge({
  name,
  color,
  logoUrl,
  size = 40,
  className,
}: {
  name: string
  color?: string | null
  logoUrl?: string | null
  size?: number
  className?: string
}) {
  const px = `${size}px`
  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt=""
        width={size}
        height={size}
        style={{ width: px, height: px }}
        className={cn('shrink-0 rounded-lg object-cover', className)}
        referrerPolicy="no-referrer"
      />
    )
  }
  return (
    <span
      style={{ width: px, height: px, backgroundColor: color || '#6366f1' }}
      className={cn('grid shrink-0 place-items-center rounded-lg font-semibold text-white', className)}
    >
      <span style={{ fontSize: `${Math.round(size * 0.42)}px` }}>{initial(name)}</span>
    </span>
  )
}
