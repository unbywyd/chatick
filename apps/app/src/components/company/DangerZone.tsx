import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Опасная зона (SPEC §3.1).
 *
 * Необратимое живёт отдельно от обычных настроек и внизу страницы: рядом с
 * повседневными пунктами до него дотягиваются случайно. Сюда же со временем
 * лягут другие действия, которые нельзя отменить.
 */
export function DangerZone({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()

  return (
    <section className="mt-10 rounded-xl border border-destructive/40">
      <header className="flex items-center gap-2 border-b border-destructive/40 px-4 py-2.5">
        <AlertTriangle className="size-4 text-destructive" />
        <h2 className="text-sm font-semibold text-destructive">{t('danger.title')}</h2>
      </header>
      <div className="divide-y divide-destructive/20">{children}</div>
    </section>
  )
}

/** Одна строка опасной зоны: что произойдёт слева, кнопка справа. */
export function DangerAction({
  title,
  description,
  actionLabel,
  onAction,
  disabled,
  disabledHint,
}: {
  title: string
  description: string
  actionLabel: string
  onAction: () => void
  disabled?: boolean
  /** почему нельзя — молча гасить кнопку значит оставить человека гадать */
  disabledHint?: string
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{disabled && disabledHint ? disabledHint : description}</p>
      </div>
      <Button variant="destructive" size="sm" onClick={onAction} disabled={disabled}>
        {actionLabel}
      </Button>
    </div>
  )
}
