import { useTranslation } from 'react-i18next'
import { Building2, Check, ChevronsUpDown, Plus } from 'lucide-react'
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
}: {
  companies: Company[]
  current: Company
  onSelect: (id: string) => void
  /** создать свою — только если её ещё нет */
  onCreate?: () => void
}) {
  const { t } = useTranslation()

  // Своя компания — та, которую человек завёл сам. Заводить вторую незачем:
  // для разделения работы существуют проекты.
  //
  // По роли это определять нельзя: админом делают и в чужой компании, и тогда
  // человек терял и кнопку «создать свою», и возможность из чужой выйти —
  // хотя своей у него нет вовсе.
  const hasOwn = companies.some((c) => c.isOwner)
  const canCreate = Boolean(onCreate) && !hasOwn

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
            {c.id === current.id && <Check className="size-3.5 text-brand-ink" />}
          </DropdownMenuItem>
        ))}

        {/* Черта только когда под ней что-то есть. */}
        {canCreate && <DropdownMenuSeparator />}

        {canCreate && (
          <DropdownMenuItem onSelect={onCreate}>
            <Plus className="size-4" />
            {t('start.createCompany')}
          </DropdownMenuItem>
        )}

        {/*
          Выхода из компании здесь больше НЕТ.
          Он стоял последним пунктом — там, где в любом другом приложении
          «выйти из аккаунта», — и человек, целясь выйти из программы, терял
          доступ ко всем проектам компании. Вернуть себя он не может: нужен
          другой админ или доступ к базе.
          Необратимому место в опасной зоне настроек компании: туда надо
          дойти намеренно, а не задеть мимоходом в меню переключения.
        */}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
