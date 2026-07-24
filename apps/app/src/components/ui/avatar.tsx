import { cn } from '@/lib/utils'

// Аватар пользователя: фото ИЛИ плейсхолдер с инициалом. Единый компонент для всего приложения.
export function Avatar({
  name,
  src,
  size = 20,
  className,
  title,
}: {
  name?: string | null
  src?: string | null
  size?: number
  className?: string
  title?: string
}) {
  const initial = (name || '?').trim()[0]?.toUpperCase() ?? '?'
  const style = { width: size, height: size }
  if (src) {
    return (
      <img
        src={src}
        alt={name ?? ''}
        title={title ?? name ?? undefined}
        referrerPolicy="no-referrer"
        style={style}
        className={cn('shrink-0 rounded-full object-cover', className)}
      />
    )
  }
  return (
    <span
      title={title ?? name ?? undefined}
      style={{ ...style, fontSize: Math.max(9, Math.round(size * 0.42)) }}
      className={cn('grid shrink-0 place-items-center rounded-full bg-secondary font-semibold text-foreground', className)}
    >
      {initial}
    </span>
  )
}
