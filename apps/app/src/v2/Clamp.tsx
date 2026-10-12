import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Длинный текст — свёрнутым: до max пикселей с градиентом внизу и кнопкой
 * «Показать целиком». Комментарии в задачах бывают простынями (ссылки на
 * сборки, логи), и лента из них превращалась в бесконечную прокрутку.
 */
export function Clamp({ max = 260, children }: { max?: number; children: React.ReactNode }) {
  const { t } = useTranslation('v2')
  const box = useRef<HTMLDivElement>(null)
  const [long, setLong] = useState(false)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const check = () => setLong(el.scrollHeight > max + 40)
    check()
    // Редактор дорисовывает содержимое после первого кадра — перемеряем.
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [max])
  return (
    <div className={'clamp' + (long && !open ? ' shut' : '')}>
      <div ref={box} className="clamp-in" style={long && !open ? { maxHeight: max } : undefined}>
        {children}
      </div>
      {long && (
        <button className="clamp-btn" onClick={() => setOpen(!open)}>
          {open ? t('common.collapse') : t('common.showAll')}
        </button>
      )}
    </div>
  )
}
