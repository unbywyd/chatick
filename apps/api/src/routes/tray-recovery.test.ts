import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Панель в трее после падения запроса.
//
// Симптом был нелепый: приложение залогинено, а внутри пусто — ни проектов, ни
// имени, вопросительный знак вместо аватарки. Кнопка «обновить» не помогала,
// помогал только полный перезапуск программы.
//
// Причина — не в самом падении, а в том, что после него панель уже не встаёт.
// Проверено на живой библиотеке: упавший запрос оставляет data пустым.

const desktop = readFileSync(
  join(import.meta.dirname, '../../../app/src/hooks/useDesktop.ts'),
  'utf8',
)

/** Тело запроса по ключу — от queryKey до закрывающей скобки useQuery. */
function query(key: string): string {
  const at = desktop.indexOf(`queryKey: ['${key}']`)
  expect(at, `запрос ${key} не найден`).toBeGreaterThan(-1)
  const end = desktop.indexOf('\n  })', at)
  return desktop.slice(at, end)
}

describe('панель оживает сама', () => {
  it('компании опрашиваются повторно', () => {
    // Корень всей панели: из этого списка собирается ключ запроса проектов, а
    // пустой ключ выключает тот запрос целиком — вместе с его собственным
    // опросом. Без своего интервала чинить панель было нечему.
    //
    // Саботаж: убрать строку — тест падает, и это ровно тот баг, что ловили.
    expect(query('companies')).toMatch(/refetchInterval:/)
  })

  it('кто вошёл — тоже', () => {
    // Без этого шапка панели оставалась без имени и с вопросительным знаком
    // вместо аватарки до перезапуска программы.
    expect(query('me')).toMatch(/refetchInterval:/)
  })

  it('ни один запрос панели не остаётся без опроса', () => {
    // Общее правило вместо перечисления: следующий добавленный запрос попадёт
    // под ту же проверку, а не повторит эту историю.
    for (const key of ['companies', 'me', 'inbox', 'desktop-running', 'desktop-tasks', 'bridge-sessions']) {
      expect(query(key), `${key} без refetchInterval`).toMatch(/refetchInterval:/)
    }
  })
})

describe('кнопка «обновить» обновляет сломавшееся', () => {
  it('перезапрашивает то, на чём держится панель', () => {
    // Раньше кнопка трогала только те три запроса, что и так опрашивают себя
    // сами. Человек жмёт её, глядя на пустую панель, — а сломано как раз то,
    // чего в списке не было.
    // Именно вызов, а не объявление типа выше: по голому имени поиск попадал
    // в описание моста и читал не тот кусок файла.
    const at = desktop.indexOf('bridge.onStateRefresh(')
    expect(at, 'обработчик не найден').toBeGreaterThan(-1)
    const body = desktop.slice(at, at + 1200)
    for (const key of ['companies', 'tray-projects', 'me']) {
      expect(body, `кнопка не обновляет ${key}`).toContain(`queryKey: ['${key}']`)
    }
  })
})
