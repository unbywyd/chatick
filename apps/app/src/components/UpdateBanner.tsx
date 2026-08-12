import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

// Уведомление о новой версии (SPEC §8.33).
//
// Рассчитывать, что человек сам догадается обновить страницу, нельзя: он
// увидит старое приложение и решит, что починка не приехала. Поэтому сборка
// оставляет version.json, а приложение сверяет его со своим отпечатком.
//
// Файл спрашиваем с no-store: закешированный ответ означал бы, что мы никогда
// не узнаем об обновлении — ровно та беда, ради которой всё и затевалось.

const CHECK_INTERVAL_MS = 5 * 60_000

export function UpdateBanner() {
  const { t } = useTranslation()
  const [outdated, setOutdated] = useState(false)

  useEffect(() => {
    // В разработке версия не проставляется — проверять нечего.
    if (typeof __BUILD_VERSION__ === 'undefined') return

    let stop = false

    const check = async () => {
      try {
        const r = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' })
        if (!r.ok) return
        const { version } = (await r.json()) as { version?: string }
        if (!stop && version && version !== __BUILD_VERSION__) setOutdated(true)
      } catch {
        // сеть отвалилась — молчим: это не повод пугать сообщением
      }
    }

    void check()
    const timer = setInterval(check, CHECK_INTERVAL_MS)
    // Вернулись к вкладке — самое время проверить: приложение могли не
    // трогать сутки, и таймер всё это время работал впустую.
    const onFocus = () => void check()
    window.addEventListener('focus', onFocus)

    return () => {
      stop = true
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  if (!outdated) return null

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-center gap-3 border-t bg-brand px-4 py-2 text-sm text-brand-foreground shadow-lg">
      <RefreshCw className="size-4 shrink-0" />
      <span className="font-medium">{t('update.available')}</span>
      {/* Цвета кнопки задаём явно: вариант outline берёт светлый фон темы, а
          на лаймовой полосе тёмный текст на нём становится нечитаемым. */}
      <Button
        size="sm"
        variant="outline"
        className="h-7 cursor-pointer border-brand-foreground bg-transparent text-brand-foreground hover:bg-brand-foreground hover:text-brand-ink"
        onClick={() => window.location.reload()}
      >
        {t('update.reload')}
      </Button>
    </div>
  )
}
