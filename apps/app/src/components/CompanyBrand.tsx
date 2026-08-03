import { cn } from '@/lib/utils'
import { LogoMark } from '@/components/Logo'

// Логотип компании вместо нашего (SPEC §8.40).
//
// Внутри своей компании человек должен видеть её, а не гостить в чужом
// продукте. Логотип и название — компании; «on Chatick» остаётся мелкой
// подписью.
//
// Подпись убирать нельзя, и это не про тщеславие: человек должен понимать, в
// каком продукте он находится. Иначе первый же вопрос «где мои файлы» или
// «куда писать о поломке» упирается в пустоту — своей поддержки у компании
// нет, а нашей он не найдёт.
//
// На экранах ДО входа в компанию (вход, приглашение, подключение) остаётся
// наш логотип: там ещё неизвестно, чья компания, а иногда и человек.

export function CompanyBrand({
  name,
  logoUrl,
  className,
}: {
  name?: string | null
  logoUrl?: string | null
  className?: string
}) {
  // Компании нет или она без имени — показываем себя, как раньше.
  if (!name) {
    return (
      <span className={cn('inline-flex items-center gap-2 text-foreground', className)}>
        <LogoMark />
        <span className="text-base font-bold tracking-tight">Chatick</span>
      </span>
    )
  }

  return (
    <span className={cn('inline-flex items-center gap-2 text-foreground', className)}>
      {logoUrl ? (
        <img
          src={logoUrl}
          alt=""
          className="no-zoom size-6 shrink-0 rounded object-cover"
          // Битая ссылка не должна оставлять дыру: показываем нашу метку.
          onError={(e) => {
            e.currentTarget.style.display = 'none'
          }}
        />
      ) : (
        <LogoMark />
      )}
      <span className="flex min-w-0 flex-col leading-none">
        <span className="truncate text-sm font-bold tracking-tight">{name}</span>
        <span className="mt-0.5 text-[10px] font-medium text-muted-foreground">on Chatick</span>
      </span>
    </span>
  )
}
