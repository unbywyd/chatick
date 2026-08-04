import type { ReactElement } from 'react'
import { ResponsiveContainer } from 'recharts'

// Обёртка для всех графиков.
//
// Recharts считает геометрию слева направо и ставит подписи оси по этому же
// расчёту. На странице с dir="rtl" разметка едет: длинная подпись проекта
// выезжает в область столбиков и ложится поверх них — на иврите график
// читался как каша из наложенного текста.
//
// Поэтому график всегда LTR, независимо от языка страницы. Сам текст подписей
// при этом остаётся ивритом и разворачивается как надо: направление здесь
// задаёт раскладку осей, а не читаемость слов.
export function ChartBox({ height, children }: { height: number; children: ReactElement }) {
  return (
    <div dir="ltr">
      <ResponsiveContainer width="100%" height={height}>
        {children}
      </ResponsiveContainer>
    </div>
  )
}
