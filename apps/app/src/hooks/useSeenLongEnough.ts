import { useEffect, useRef } from 'react'

/**
 * Погасить то, что человек действительно разглядывал.
 *
 * Полоса «что меня касается» листается вбок, и карточки в ней человек читает
 * глазами, не нажимая ничего: перешёл по одной, остальные прочитал и пошёл
 * работать. Уведомления при этом оставались непрочитанными, и бейдж висел за
 * то, что уже увидено.
 *
 * Почему не «показалось на экране — гасим». Попадание во вьюпорт не значит
 * прочтения: при открытии страницы первые карточки оказываются на экране
 * раньше, чем человек успел на них посмотреть, а листая ленту вбок он
 * проматывает мимо всё подряд. Погашенное зря не вернуть — человек уже не
 * узнает, что там было, — тогда как непогашенное он всегда закроет сам,
 * кнопки для этого есть. Асимметрия и определяет осторожность здесь.
 *
 * Отсюда три условия, и все обязательны:
 *
 *  — карточка видна ЦЕЛИКОМ (threshold 1). Наполовину уехавшая за край
 *    прочитанной не считается: у неё не видно ни текста, ни половины строк.
 *  — и держится так `delay` подряд. Пролистнул мимо — таймер не досчитал.
 *  — вкладка на переднем плане. Открытая в фоне страница иначе потушила бы
 *    всё сама, без единого человека перед экраном.
 *
 * Намеренно НЕ применяется на странице /inbox: туда идут именно разбирать
 * список, и он не должен стирать себя, пока его читают.
 */
export function useSeenLongEnough({
  onSeen,
  delay = 2500,
  enabled = true,
}: {
  /** Вызывается один раз на каждый id, когда его действительно разглядели. */
  onSeen: (id: string) => void
  delay?: number
  enabled?: boolean
}) {
  const nodes = useRef(new Map<string, Element>())
  const timers = useRef(new Map<string, number>())
  // Колбэк держим в ref: он пересоздаётся на каждый рендер, а пересобирать
  // из-за этого наблюдатель — значит сбрасывать все накопленные таймеры.
  const onSeenRef = useRef(onSeen)
  onSeenRef.current = onSeen

  const observer = useRef<IntersectionObserver | null>(null)

  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === 'undefined') return

    const timersNow = timers.current
    const clear = (id: string) => {
      const t = timersNow.get(id)
      if (t !== undefined) {
        clearTimeout(t)
        timersNow.delete(id)
      }
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.seenId
          if (!id) continue
          // Ушла из виду или показана частично — отсчёт начинается заново.
          if (!e.isIntersecting || document.hidden) {
            clear(id)
            continue
          }
          if (timersNow.has(id)) continue
          timersNow.set(
            id,
            window.setTimeout(() => {
              timersNow.delete(id)
              onSeenRef.current(id)
            }, delay),
          )
        }
      },
      { threshold: 1 },
    )
    observer.current = io
    for (const el of nodes.current.values()) io.observe(el)

    // Уход со вкладки останавливает счёт: человек ушёл, а карточка формально
    // осталась видимой. Вернётся — отсчёт пойдёт с начала.
    const onVisibility = () => {
      if (document.hidden) for (const id of [...timersNow.keys()]) clear(id)
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      io.disconnect()
      observer.current = null
      document.removeEventListener('visibilitychange', onVisibility)
      for (const t of timersNow.values()) clearTimeout(t)
      timersNow.clear()
    }
  }, [enabled, delay])

  /** ref для карточки: `<div ref={watch(n.id)} …>` */
  return (id: string) => (el: HTMLElement | null) => {
    const prev = nodes.current.get(id)
    if (prev && prev !== el) observer.current?.unobserve(prev)
    if (!el) {
      nodes.current.delete(id)
      return
    }
    el.dataset.seenId = id
    nodes.current.set(id, el)
    observer.current?.observe(el)
  }
}
