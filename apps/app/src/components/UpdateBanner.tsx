import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'

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

  // Вид — как у плавающей кнопки ассистента v2: тёмная «таблетка» внизу, лаймовая
  // кнопка. Плашка живёт вне .app (её видно и на входе), поэтому цвета v2 здесь
  // заданы значениями, а не переменными. Прежняя лаймовая полоса на всю ширину
  // была из старого дизайна, и её кнопка при наведении становилась нечитаемой.
  return (
    <div
      role="status"
      className="fixed bottom-6 left-1/2 z-50 flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-3 rounded-2xl bg-[#1F2B1B] py-2 ps-4 pe-2 text-sm text-[#EEF3E6] shadow-[0_14px_34px_-10px_rgba(0,0,0,.45)]"
      style={{ fontFamily: "'Onest','Heebo',system-ui,sans-serif" }}
    >
      <RefreshCw className="size-4 shrink-0 text-[#D4F36B]" />
      <span className="font-semibold">{t('update.available')}</span>
      <button
        type="button"
        className="h-8 shrink-0 cursor-pointer rounded-[10px] bg-[#D4F36B] px-3.5 font-semibold text-[#1B1D1A] transition-colors hover:bg-[#C4E655]"
        onClick={() => window.location.reload()}
      >
        {t('update.reload')}
      </button>
    </div>
  )
}
