import { useEffect, useRef } from 'react'

/**
 * Меряет высоту липкой шапки и кладёт её в переменную CSS на общем предке,
 * помеченном `data-sticky-root`. Читают как `top: var(--name)` — в том числе
 * из соседних компонентов, лишь бы они были внутри того же корня.
 *
 * Зачем не константа: полоса вкладок на широком экране в один ряд (69px), а на
 * телефоне переносится в два (105px). Любое число, зашитое в класс, оказалось
 * бы неверным на одной из ширин — блок под шапкой либо уезжал бы под неё, либо
 * висел с дырой.
 *
 * ResizeObserver, а не замер при монтировании: ряды переносятся при повороте
 * телефона и при смене языка (иврит короче, вкладки помещаются в один ряд),
 * а это происходит уже после первой отрисовки.
 */
export function useStickyHeight(name: string) {
  const ref = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Пишем НЕ на сам элемент, а на общего предка: полосу вкладок и блок под
    // ней читают соседи по дереву (вкладка «Часы» — отдельный компонент), а
    // переменная с самого элемента наследуется только вниз, в его потомков.
    const host = el.closest('[data-sticky-root]') ?? el.parentElement ?? el
    const apply = () => (host as HTMLElement).style.setProperty(name, `${Math.round(el.offsetHeight)}px`)
    apply()
    // offsetHeight, а не rect.height: нужно целое число, дробное в top даёт
    // полоску фона под шапкой на экранах с дробным масштабом.
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [name])

  return ref
}
