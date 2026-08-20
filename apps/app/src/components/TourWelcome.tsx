import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'

/**
 * Приветствие перед вводным туром.
 *
 * Одна задача: обозначить переход. Человек только что вошёл, интерфейс ещё
 * чужой, и вываливать на него подсказки сразу — всё равно что начать экскурсию
 * с середины предложения. Экран даёт паузу и называет по имени.
 *
 * Живёт вместе с туром: пройден тур — приветствия тоже нет. Отдельной отметки
 * не заводим, иначе появится состояние «поздоровались, но не показали».
 */

/** Сколько ждать до автоперехода. */
const SECONDS = 10

export function TourWelcome({ name, onStart }: { name: string; onStart: () => void }) {
  const { t } = useTranslation()
  const [left, setLeft] = useState(SECONDS)
  const startedRef = useRef(false)
  /**
   * Экран уходит.
   *
   * Не снимаем его мгновенно: резкое исчезновение читается как сбой, особенно
   * после медленного появления. Сначала гасим, и только потом отдаём управление
   * туру — иначе подсказка вспыхнет поверх ещё видимого приветствия.
   */
  const [leaving, setLeaving] = useState(false)

  /**
   * Отсчёт до автоперехода.
   *
   * Начать сам, а не ждать нажатия: человек, который просто смотрит, всё равно
   * попадёт в тур, а тот, кто читает быстро, нажмёт кнопку. Останавливать
   * отсчёт на наведении не будем — экран здесь не для чтения, а для перехода.
   *
   * startedRef: строгий режим React монтирует эффект дважды, и без защиты
   * переход случился бы вдвое быстрее.
   */
  /** Уйти один раз: и по кнопке, и по клавише, и по истечении отсчёта. */
  const leave = useRef(() => {})
  leave.current = () => {
    if (startedRef.current) return
    startedRef.current = true
    setLeaving(true)
    // Столько же, сколько длится затухание в CSS (tour-leave).
    window.setTimeout(onStart, 900)
  }

  useEffect(() => {
    const id = window.setInterval(() => {
      setLeft((v) => {
        if (v <= 1) {
          window.clearInterval(id)
          leave.current()
          return 0
        }
        return v - 1
      })
    }, 1000)
    return () => window.clearInterval(id)
  }, [onStart])

  // Enter и пробел — тоже «продолжить»: рука уже на клавиатуре после входа.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
        e.preventDefault()
        leave.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onStart])

  return createPortal(
    <div className={`tour-welcome fixed inset-0 z-[110] overflow-hidden bg-background${leaving ? ' is-leaving' : ''}`}>
      {/* Живой фон: три пятна разного цвета, у каждого свой путь и период.
          Прозрачность пробовали — сквозь неё просвечивал интерфейс, и экран
          выглядел грязно. Непрозрачный фон честнее: это отдельный момент, а
          не полупрозрачная плёнка поверх работы. */}
      <div className="tour-welcome-haze" aria-hidden>
        <span className="tour-haze-a" />
        <span className="tour-haze-b" />
        <span className="tour-haze-c" />
      </div>

      <div className="relative flex h-full flex-col items-center justify-center px-6 text-center">
        {/* Галочка рисует себя — та же, что в логотипе. Один авторский момент
            на экран: дальше только текст, проявляющийся следом. */}
        <svg viewBox="0 0 48 48" fill="none" className="tour-welcome-mark size-16 sm:size-20" aria-hidden>
          <path
            d="M24 4C12.4 4 3 12.7 3 23.5c0 5.4 2.4 10.3 6.2 13.8L8 44l8.4-3.2c2.4.7 4.9 1.2 7.6 1.2 11.6 0 21-8.7 21-19.5S35.6 4 24 4Z"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinejoin="round"
            className="tour-mark-bubble"
          />
          <path
            d="M15 24.5 21 30l12-12"
            stroke="var(--brand)"
            strokeWidth="5.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="tour-mark-tick"
          />
        </svg>

        {/* Имя — крупно, как здоровается система при первом запуске. Баланс
            переносов, чтобы длинное имя не рвалось по одному слову в строке. */}
        <h1 className="tour-welcome-title mt-8 text-balance text-5xl font-semibold tracking-[-0.04em] sm:text-6xl md:text-7xl">
          {t('tour.welcome.hello', { name })}
        </h1>
        <p className="tour-welcome-sub mt-5 max-w-md text-balance text-base text-muted-foreground sm:text-lg">
          {t('tour.welcome.text')}
        </p>

        <div className="tour-welcome-cta mt-12 flex flex-col items-center gap-3">
          {/* Крупнее обычной кнопки: на пустом экране «default» теряется, а
              заводить размер в общей кнопке ради одного места незачем. */}
          <Button variant="brand" className="h-11 px-8 text-base" onClick={() => leave.current()}>
            {t('tour.welcome.start')}
          </Button>
          {/* Отсчёт словами, а не голой цифрой: «5» под кнопкой ничего не
              обещает, а «начнём через 5 с» объясняет, что произойдёт само. */}
          <span className="text-xs tabular-nums text-muted-foreground">
            {t('tour.welcome.countdown', { count: left })}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
