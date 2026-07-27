import { useTranslation } from 'react-i18next'
import { Building2, Check, ChevronsUpDown, LogOut, Plus } from 'lucide-react'
import type { Company } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

// Переключатель компаний (SPEC §3.1).
//
// Человек может состоять в нескольких компаниях: своей и тех, куда позвали.
// Раньше сменить её можно было только через возврат к списку — то есть уйдя
// со страницы, на которой работаешь.

export function CompanySwitcher({
  companies,
  current,
  onSelect,
  onCreate,
  onLeave,
}: {
  companies: Company[]
  current: Company
  onSelect: (id: string) => void
  /** создать свою — только если её ещё нет */
  onCreate?: () => void
  onLeave: (company: Company) => void
}) {
  const { t } = useTranslation()

  // Своя компания — та, где человек админ. Заводить вторую незачем: для
  // разделения работы существуют проекты.
  const hasOwn = companies.some((c) => c.myRole === 'admin')
  const canCreate = Boolean(onCreate) && !hasOwn
  // Уйти можно только из чужой: свою без хозяина не оставишь.
  const canLeave = current.myRole !== 'admin'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-medium transition-colors hover:bg-accent"
          title={t('start.changeCompany')}
        >
          {current.logoUrl ? (
            <img src={current.logoUrl} alt="" className="size-5 rounded" referrerPolicy="no-referrer" />
          ) : (
            <Building2 className="size-4 text-muted-foreground" />
          )}
          <span className="max-w-40 truncate">{current.name}</span>
          <ChevronsUpDown className="size-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-56">
        <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{t('start.yourCompanies')}</p>
        {companies.map((c) => (
          <DropdownMenuItem key={c.id} onSelect={() => onSelect(c.id)}>
            {c.logoUrl ? (
              <img src={c.logoUrl} alt="" className="size-4 rounded" referrerPolicy="no-referrer" />
            ) : (
              <Building2 className="size-4 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            <span className="text-[10px] text-muted-foreground">{t(`roles.${c.myRole}`)}</span>
            {c.id === current.id && <Check className="size-3.5 text-brand" />}
          </DropdownMenuItem>
        ))}

        {/* Черта только когда под ней что-то есть: у человека со своей
            единственной компанией оба пункта ниже скрыты. */}
        {(canCreate || canLeave) && <DropdownMenuSeparator />}

        {canCreate && (
          <DropdownMenuItem onSelect={onCreate}>
            <Plus className="size-4" />
            {t('start.createCompany')}
          </DropdownMenuItem>
        )}

        {/* Выйти можно только из чужой: свою без хозяина не оставишь. Удаление
            здесь не показываем — необратимому место в опасной зоне настроек,
            а не в меню, куда заходят просто сменить компанию. */}
        {canLeave && (
          <DropdownMenuItem
            onSelect={() => onLeave(current)}
            className={cn('text-destructive focus:text-destructive')}
          >
            <LogOut className="size-4" />
            {t('start.leaveCompany')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
