import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Правка записи времени: не путать длительность со временем, переносить день
 * целиком и объяснять ошибку словами.
 *
 * Как сломалось: в строке «11:08 · 09:08 (+1) · 22:00» человек прочёл «начал в
 * 9, закончил в 10 вечера». На деле 09:08 был концом следующего дня, а 22:00 —
 * длительностью. Чтобы «перенести на 8-е», он сдвинул дату ОКОНЧАНИЯ — конец
 * оказался раньше начала, и сервер ответил английской фразой. День показал 30
 * часов. Заодно выбранный сегодняшний день в календаре был пустым лаймовым
 * квадратом: в тёмной теме цвет «сегодня» совпадал с заливкой выбранного.
 */

const read = (p: string) => readFileSync(join(import.meta.dirname, '../../../app/src', p), 'utf8').replace(/\r\n/g, '\n')
const tab = read('components/tabs/TimeTab.tsx')
const calendar = read('components/ui/calendar.tsx')
const locale = (l: string) => JSON.parse(read(`i18n/locales/${l}.json`)).time as Record<string, string>

describe('строка записи времени', () => {
  it('дата начала переносит запись целиком, длительность та же', () => {
    // Саботаж: вернуть onChange, двигающий только startedAt, — тест падает.
    expect(tab).toContain("<DateCell value={start} label={t('time.entryDate')} onChange={moveEntry} />")
    expect(tab).toContain('const shift = day.getTime() - start.getTime()')
    expect(tab).toContain('endedAt: new Date(end.getTime() + shift)')
  })

  it('все правки краёв проходят проверку до отправки', () => {
    // Прямой patch.mutate с датами в обход sendEdges вернул бы английскую
    // ошибку сервера вместо объяснения.
    expect(tab).not.toMatch(/patch\.mutate\(\{ (startedAt|endedAt):/)
    expect(tab).toContain("if (e && e.getTime() <= s.getTime()) return toast.error(t('time.endBeforeStart'))")
    expect(tab).toContain("return toast.error(t('time.tooLong'))")
  })

  it('длительность в покое не выглядит как время', () => {
    expect(tab).toContain('value={draft ?? (focused ? shown : human)}')
    expect(tab).toContain("focused ? 'font-mono text-base' : 'text-sm font-semibold'")
  })

  it('объяснения есть на трёх языках', () => {
    for (const l of ['ru', 'en', 'he']) {
      const t = locale(l)
      for (const k of ['entryDate', 'endBeforeStart', 'tooLong', 'durH', 'durHM', 'durM', 'durationHint']) {
        expect(t[k], `${l}: time.${k}`).toBeTruthy()
      }
      expect(t.durHM).toContain('{{h}}')
      expect(t.durHM).toContain('{{m}}')
    }
  })
})

describe('календарь', () => {
  it('цвет «сегодня» не ложится на выбранный день', () => {
    // Оба правила одной силы: кто победит, решал порядок в собранном CSS. В
    // тёмной теме brand-ink = заливка выбранного, и цифра пропадала.
    expect(calendar).toContain("today: 'font-bold [&:not([data-selected])>button]:text-brand-ink'")
    expect(calendar).toContain("selected: '[&>button]:bg-brand [&>button]:font-semibold [&>button]:text-brand-foreground'")
  })
})
