import { useTranslation } from 'react-i18next'
import { Languages, ChevronDown } from 'lucide-react'
import { LOCALES } from '@/i18n'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckItem,
} from '@/components/ui/dropdown-menu'

export function LanguageSelect() {
  const { i18n, t } = useTranslation()
  const current = LOCALES.find((l) => l.code === i18n.resolvedLanguage)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={t('language')} className="gap-1.5">
          <Languages className="size-3.5" />
          {current?.label}
          <ChevronDown className="size-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LOCALES.map((l) => (
          <DropdownMenuCheckItem key={l.code} checked={l.code === i18n.resolvedLanguage} onSelect={() => i18n.changeLanguage(l.code)}>
            {l.label}
          </DropdownMenuCheckItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
