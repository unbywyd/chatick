import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { api, getSessionToken } from '@/lib/api'
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
  const qc = useQueryClient()
  const current = LOCALES.find((l) => l.code === i18n.resolvedLanguage)

  /**
   * Язык интерфейса — он же язык человека в профиле.
   *
   * Раньше переключатель менял только интерфейс, в браузере. В профиле
   * оставался язык, доставшийся при создании, — а на нём ИИ пишет сводки
   * уведомлений и письма. Человек видел ивритский интерфейс и английские
   * уведомления, и поменять это было негде: отдельного места для языка
   * профиля в приложении нет.
   *
   * Сохраняем молча и не ждём ответа: интерфейс должен переключиться сразу.
   * Не дошло — в следующий раз дойдёт, а язык интерфейса уже верный.
   *
   * Экраны входа и приглашения тоже показывают этот переключатель, но там
   * человека ещё нет — сохранять некуда.
   */
  const pick = (code: string) => {
    void i18n.changeLanguage(code)
    if (!getSessionToken()) return
    void api('/api/v1/auth/me', { method: 'PATCH', body: JSON.stringify({ locale: code }) })
      .then(() => qc.invalidateQueries({ queryKey: ['me'] }))
      .catch(() => {})
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={t('language')} className="gap-1.5">
          {/* Иконка только на широком: в шапке телефона она отнимала место у
              самого языка, а рядом уже стоит стрелка — что это выбор, видно
              и без второго значка. */}
          <Languages className="hidden size-3.5 sm:block" />
          {/* На узком — код языка: «עברית» и «Русский» распирали шапку, а
              «HE» и «RU» отвечают на тот же вопрос. */}
          <span className="sm:hidden">{current?.code.toUpperCase()}</span>
          <span className="hidden sm:inline">{current?.label}</span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LOCALES.map((l) => (
          <DropdownMenuCheckItem key={l.code} checked={l.code === i18n.resolvedLanguage} onSelect={() => pick(l.code)}>
            {l.label}
          </DropdownMenuCheckItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
