import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Порядок в панели «Мои задачи».
 *
 * Раньше сквозной список был только «по срочности», и вопроса «что у меня
 * висит дольше всего» задать было нельзя: забытая задача не обязана быть
 * срочной — по срочности она как раз тонет внизу.
 */

const panel = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/chat/MyTasksPanel.tsx'),
  'utf8',
).replace(/\r\n/g, '\n')

describe('сквозной список сортируется', () => {
  it('есть три порядка, включая «сначала старые»', () => {
    // Саботаж: убрать oldest — тест падает.
    expect(panel, 'нет выбора порядка').toContain("useState<'urgency' | 'oldest' | 'newest'>")
    expect(panel, 'нет всех трёх кнопок').toContain("(['urgency', 'oldest', 'newest'] as const)")
  })

  it('по срочности список НЕ пересортировывается', () => {
    // Сервер уже отсортировал; повторить правило на клиенте значит развести
    // их при первой правке.
    //
    // Саботаж: убрать ранний возврат — тест падает.
    expect(panel, 'клиент пересортировывает срочность сам').toContain(
      "if (grouped || sort === 'urgency') return items",
    )
  })

  it('даты сравниваются числами, а не строками', () => {
    // Строки ISO сравнимы лексикографически только пока часовой пояс один, а
    // сервер отдаёт их с зоной.
    //
    // Саботаж: сравнить a.createdAt < b.createdAt — тест падает.
    expect(panel, 'даты сравниваются как строки').toContain('+new Date(a.createdAt) - +new Date(b.createdAt)')
  })

  it('исходный массив не мутируется', () => {
    // items приходит из кеша запроса: sort() на месте перетасовал бы его для
    // всех, кто на него смотрит.
    //
    // Саботаж: убрать копию — тест падает.
    expect(panel, 'сортировка мутирует кеш').toContain('[...items].sort(')
  })

  it('выбор порядка переживает перезагрузку', () => {
    expect(panel, 'порядок не запоминается').toContain('localStorage.setItem(SORT_KEY, k)')
  })

  it('порядок показывается только в сквозном списке', () => {
    // В группировке по проектам порядок задаёт сам проект — второй
    // переключатель там сбивал бы.
    //
    // Саботаж: убрать !grouped — тест падает.
    expect(panel, 'переключатель порядка виден в группировке').toContain("{!grouped && (")
  })

  it('вкладка называется «все задачи», а не «по срочности»', () => {
    // Она про НАБОР задач, а порядок теперь выбирается отдельно.
    expect(panel, 'вкладка всё ещё про срочность').toContain("label: 'myTasks.allTasks'")
    expect(panel, 'старая подпись осталась').not.toContain("label: 'myTasks.byUrgency'")
  })
})

describe('переводы порядка есть во всех языках', () => {
  for (const loc of ['ru', 'en', 'he'] as const) {
    it(loc, () => {
      const m = JSON.parse(
        readFileSync(join(import.meta.dirname, `../../../app/src/i18n/locales/${loc}.json`), 'utf8'),
      ).myTasks
      expect(m?.allTasks, `нет myTasks.allTasks в ${loc}`).toBeTruthy()
      expect(m?.sortBy, `нет myTasks.sortBy в ${loc}`).toBeTruthy()
      for (const k of ['urgency', 'oldest', 'newest']) {
        expect(m?.sort?.[k], `нет myTasks.sort.${k} в ${loc}`).toBeTruthy()
      }
    })
  }
})
