import { Avatar } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

/**
 * Ряд участников внахлёст: несколько лиц и «+N» для остальных.
 *
 * Отличается от AvatarGroup, который собирает коллаж для аватара проекта:
 * здесь важно увидеть, КТО в проекте, а не опознать проект по картинке.
 */
export function AvatarRow({
  members,
  total,
  max = 5,
  size = 24,
  className,
  onClick,
  title,
}: {
  members: { id: string; name: string; avatarUrl: string | null }[]
  /** всего участников — если список пришёл урезанным */
  total?: number
  max?: number
  size?: number
  className?: string
  onClick?: () => void
  title?: string
}) {
  const count = total ?? members.length
  const shown = members.slice(0, max)
  const rest = count - shown.length
  if (!shown.length) return null

  const Tag = onClick ? 'button' : 'span'

  return (
    <Tag
      onClick={onClick}
      title={title}
      className={cn('flex shrink-0 items-center', onClick && 'cursor-pointer', className)}
    >
      {shown.map((m, i) => (
        // Нахлёст: ряд занимает меньше места, а порядок читается по глубине.
        <span
          key={m.id}
          className="rounded-full ring-2 ring-background"
          style={{ marginInlineStart: i === 0 ? 0 : -size / 3, zIndex: shown.length - i }}
        >
          <Avatar name={m.name} src={m.avatarUrl} size={size} title={m.name} />
        </span>
      ))}
      {rest > 0 && (
        <span
          className="grid place-items-center rounded-full bg-secondary font-semibold text-muted-foreground ring-2 ring-background"
          style={{ width: size, height: size, marginInlineStart: -size / 3, fontSize: size * 0.4 }}
        >
          +{rest}
        </span>
      )}
    </Tag>
  )
}
