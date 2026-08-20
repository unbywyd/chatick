import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Вводный тур по интерфейсу.
 *
 * Своё, а не готовая библиотека. Тур обязан по ходу ОТКРЫВАТЬ вещи —
 * разворачивать чат, переключать вкладки, — а готовые туры показывают
 * подсказки поверх неподвижной страницы и такого не умеют. Позиционирование —
 * единственное, что в них сложно, — здесь берётся из уже подключённого
 * Popover.
 *
 * Из тура можно выйти на любом шаге: крестиком, кнопкой, Escape или щелчком
 * мимо. Тур, из которого нельзя выйти, — ловушка, а не помощь.
 */

export type TourStep = {
  /** Что подсветить. CSS-селектор; если элемента нет — шаг пропускается. */
  target?: string
  /** Ключ перевода заголовка и текста. */
  key: string
  /**
   * Что сделать перед показом: развернуть чат, перейти на вкладку.
   *
   * Шаг про вкладки бессмыслен, пока они не на экране, а рассказывать про чат
   * при свёрнутой панели — всё равно что показывать на пустое место.
   */
  before?: () => void
  /** Куда прижать подсказку. По умолчанию снизу. */
  side?: 'top' | 'bottom' | 'left' | 'right'
}

/**
 * Прямоугольник цели в координатах окна.
 *
 * Возвращает null, пока цель не найдена ОКОНЧАТЕЛЬНО — и пока null, карточку
 * рисовать нельзя. Иначе выходит скачка: сначала подсказка появляется на месте
 * предыдущего шага, потом прыгает к новой цели, а если по дороге была
 * прокрутка — прыгает ещё раз. Со стороны это выглядит поломкой, а не
 * подсказкой.
 */
function useTargetRect(selector: string | undefined, step: number): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null)
  useEffect(() => {
    // Сбрасываем СРАЗУ: старый прямоугольник — от прошлого шага, и показывать
    // по нему новую подсказку значит показать её не там.
    setRect(null)
    if (!selector) return
    /**
     * Ищем не сразу: предыдущий шаг мог только что переключить вкладку, и в
     * этот момент нужного элемента ещё нет в разметке. Пробуем несколько раз
     * и сдаёмся — шаг без цели покажется по центру, а не сорвёт тур.
     */
    let tries = 0
    let timer = 0
    let cancelled = false
    const find = () => {
      if (cancelled) return
      const el = document.querySelector(selector)
      if (el) {
        /**
         * Сначала доводим до вида, и только потом меряем.
         *
         * Прокрутка мгновенная, не плавная: пока идёт анимация, координаты
         * меняются каждый кадр, и подсветка ползёт за элементом. Резкий скачок
         * содержимого здесь честнее ползущей рамки — человек в этот момент
         * читает подсказку, а не следит за прокруткой.
         */
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        // Через кадр: браузер применяет прокрутку до отрисовки, и без
        // ожидания мы бы сняли координаты ДО неё.
        requestAnimationFrame(() => {
          if (!cancelled) setRect(el.getBoundingClientRect())
        })
        return
      }
      if (tries++ < 10) timer = window.setTimeout(find, 100)
    }
    find()

    // Окно меняют по ходу тура: пересчитываем, иначе подсветка уезжает.
    const onMove = () => {
      const el = document.querySelector(selector)
      if (el) setRect(el.getBoundingClientRect())
    }
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [selector, step])
  return rect
}

export function Tour({
  steps,
  onDone,
  onDismiss,
}: {
  steps: TourStep[]
  /**
   * Человек ОТВЕТИЛ на вопрос «нужно ли объяснять»: дошёл до конца или нажал
   * «Пропустить». Больше тур не показываем.
   */
  onDone: () => void
  /**
   * Человек просто убрал окно с дороги — щёлкнул мимо или нажал Escape.
   *
   * Это не ответ: чаще всего он целился в кнопку под затемнением (сменить
   * язык, закрыть уведомление). Прятать тур навсегда за промах мышью —
   * потерять его без возможности вернуть, и человек даже не поймёт, что
   * потерял. Закрываем на сейчас, при следующем заходе покажем снова.
   */
  onDismiss: () => void
}) {
  const { t } = useTranslation()
  const [i, setI] = useState(0)
  /**
   * Настоящая высота карточки.
   *
   * Угадывать её нельзя: текст шагов разной длины, на иврите и русском строки
   * переносятся по-разному. При 212 вместо предполагаемых 190 подсказка
   * налезала на цель — а проверка «не перекрывает» этого не видела, потому что
   * считала по выдуманному числу.
   */
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null)
  const [cardH, setCardH] = useState(210)
  useEffect(() => {
    if (!cardEl) return
    const ro = new ResizeObserver(() => setCardH(cardEl.offsetHeight))
    ro.observe(cardEl)
    setCardH(cardEl.offsetHeight)
    return () => ro.disconnect()
  }, [cardEl])
  const step = steps[i]
  const rect = useTargetRect(step?.target, i)

  // Действие шага выполняем ДО показа подсказки.
  useEffect(() => {
    step?.before?.()
  }, [i, step])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss()
      if (e.key === 'ArrowRight') setI((v) => Math.min(v + 1, steps.length - 1))
      if (e.key === 'ArrowLeft') setI((v) => Math.max(v - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss, steps.length])

  const last = i === steps.length - 1

  /**
   * Куда поставить карточку.
   *
   * Считаем сами, а не через Popover: цель — произвольный элемент страницы, а
   * не то, по чему кликнули, и Popover нужен якорь в разметке. Держим карточку
   * в пределах окна — на узком экране она иначе уезжает за край.
   */
  const pos = useMemo(() => {
    const W = 320
    const H = cardH
    const pad = 12
    if (!rect) return { left: window.innerWidth / 2 - W / 2, top: window.innerHeight / 2 - 80 }

    /**
     * Карточка не должна накрывать то, о чём рассказывает.
     *
     * Заданная сторона — пожелание, а не приказ: строка компании стоит у
     * нижнего края, и подсказка «сверху» ложилась ровно на неё — человек
     * читал про элемент, которого не видит. Поэтому проверяем все стороны и
     * берём первую, где карточка помещается целиком и не задевает цель.
     */
    const W2 = W + pad
    const H2 = H + pad
    const candidates: Record<string, { left: number; top: number }> = {
      bottom: { left: rect.left + rect.width / 2 - W / 2, top: rect.bottom + pad },
      top: { left: rect.left + rect.width / 2 - W / 2, top: rect.top - H2 },
      right: { left: rect.right + pad, top: rect.top },
      left: { left: rect.left - W2, top: rect.top },
    }
    const order = [step?.side ?? 'bottom', 'bottom', 'right', 'left', 'top']

    const fits = (c: { left: number; top: number }) =>
      c.left >= pad &&
      c.top >= pad &&
      c.left + W <= window.innerWidth - pad &&
      c.top + H <= window.innerHeight - pad &&
      // Не перекрывает цель: прямоугольники не пересекаются.
      (c.left + W <= rect.left || c.left >= rect.right || c.top + H <= rect.top || c.top >= rect.bottom)

    for (const side of order) {
      const c = candidates[side]
      if (c && fits(c)) return c
    }

    /**
     * Не поместилась нигде — цель занимает почти весь экран.
     *
     * Тогда просто держим карточку в окне: перекрытие неизбежно, а вылезти за
     * край нельзя — оттуда её не прочитать вовсе.
     */
    const c = candidates[step?.side ?? 'bottom'] ?? candidates.bottom!
    return {
      left: Math.max(pad, Math.min(c.left, window.innerWidth - W - pad)),
      top: Math.max(pad, Math.min(c.top, window.innerHeight - H - pad)),
    }
  }, [rect, step?.side, cardH])

  if (!step) return null
  /**
   * Пока цель не найдена — не рисуем.
   *
   * Раньше карточка в этот момент вставала по центру экрана, а через миг
   * прыгала к элементу: два разных места за полсекунды, и человек видит
   * скачущее окно вместо подсказки. Лучше показать на кадр позже, но сразу
   * там, где надо.
   *
   * У шага без цели (target не задан) rect и не появится — такие шаги мы
   * специально не используем.
   */
  if (step.target && !rect) return null

  return createPortal(
    <div className="fixed inset-0 z-[100]">
      {/* Затемнение ловит клик мимо. Это НЕ «больше не показывать»: человек
          обычно целится в кнопку под ним. Прячем на сейчас.
          Когда цель найдена, темнит не этот слой, а огромная тень вокруг
          подсветки ниже: два затемнения складывались бы, и вырез переставал
          читаться. Без цели (шаг по центру) темним обычным способом. */}
      {/* Затемнение ловит клик мимо. Без размытия: backdrop-blur ложится
          сплошным слоем, и вырезать из него дырку нельзя — размывалось всё,
          включая то, на что показываем. Глубины даёт сама тень выреза ниже. */}
      <div className={cn('absolute inset-0', !rect && 'bg-black/60')} onClick={onDismiss} />
      {rect && (
        <div
          className="pointer-events-none absolute rounded-lg ring-2 ring-brand"
          style={{
            left: rect.left - 4,
            top: rect.top - 4,
            width: rect.width + 8,
            height: rect.height + 8,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.72)',
          }}
        />
      )}

      <div
        ref={setCardEl}
        className="absolute w-80 rounded-xl border bg-popover p-4 text-popover-foreground shadow-xl"
        style={{ left: pos.left, top: pos.top }}
      >
        {/* Крестик убирает окно, но не отвечает за человека: на карточке он
            означает «закрой это», а не «больше никогда». Отказ — только
            явной кнопкой «Пропустить» внизу. */}
        <button
          onClick={onDismiss}
          title={t('tour.close')}
          className="absolute end-2 top-2 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>

        <h3 className="pe-6 text-sm font-semibold">{t(`tour.${step.key}.title`)}</h3>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{t(`tour.${step.key}.text`)}</p>

        <div className="mt-4 flex items-center gap-2">
          {/* Точки — чтобы было видно, сколько ещё осталось: без этого тур
              ощущается бесконечным, и его закрывают на середине. */}
          <span className="flex flex-1 items-center gap-1">
            {steps.map((_, k) => (
              <span
                key={k}
                className={cn('h-1 rounded-full transition-all', k === i ? 'w-4 bg-brand' : 'w-1 bg-border')}
              />
            ))}
          </span>
          {i > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setI(i - 1)}>
              {t('tour.back')}
            </Button>
          )}
          <Button variant="brand" size="sm" onClick={() => (last ? onDone() : setI(i + 1))}>
            {last ? t('tour.finish') : t('tour.next')}
          </Button>
        </div>

        {/* Выход словами, а не только крестиком: крестик замечают не все, а
            уйти человек должен мочь в любой момент. */}
        {/* Единственный ответ «не нужно»: нажат осознанно, словами. */}
        {!last && (
          <button
            onClick={onDone}
            className="mt-2 w-full text-center text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          >
            {t('tour.skip')}
          </button>
        )}
      </div>
    </div>,
    document.body,
  )
}
