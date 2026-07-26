import { Avatar } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

/**
 * Аватар проекта как в мессенджерах: коллаж из участников вместо одной картинки
 * (SPEC §8.29). До двух лиц, третьим кружком — «+N».
 */
export function AvatarGroup({
  members,
  total,
  size = 48,
  className,
}: {
  members: { id: string; name: string; avatarUrl: string | null }[]
  total?: number
  size?: number
  className?: string
}) {
  const count = total ?? members.length
  // ровно двое — показываем обоих; больше — одно лицо и счётчик остальных
  const shown = members.slice(0, count > 2 ? 1 : 2)
  const rest = count - shown.length
  const inner = Math.round(size * 0.62)

  if (!shown.length) {
    return (
      <span
        className={cn('grid shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground', className)}
        style={{ width: size, height: size }}
      >
        <svg viewBox="0 0 24 24" width={size * 0.5} height={size * 0.5} fill="none" aria-hidden>
          <path
            d="M17 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M10 6a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </span>
    )
  }

  // один участник — обычный круглый аватар, без коллажа
  if (shown.length === 1 && rest <= 0) {
    return (
      <span className={cn('shrink-0', className)}>
        <Avatar name={shown[0]!.name} src={shown[0]!.avatarUrl} size={size} />
      </span>
    )
  }

  return (
    <span className={cn('relative shrink-0', className)} style={{ width: size, height: size }}>
      <span className="absolute start-0 top-0 rounded-full ring-2 ring-background">
        <Avatar name={shown[0]!.name} src={shown[0]!.avatarUrl} size={inner} />
      </span>
      {shown[1] && (
        <span className="absolute bottom-0 end-0 rounded-full ring-2 ring-background">
          <Avatar name={shown[1].name} src={shown[1].avatarUrl} size={inner} />
        </span>
      )}
      {rest > 0 && (
        <span
          className="absolute bottom-0 end-0 grid place-items-center rounded-full bg-secondary text-[10px] font-semibold text-muted-foreground ring-2 ring-background"
          style={{ width: inner, height: inner }}
        >
          +{rest}
        </span>
      )}
    </span>
  )
}
