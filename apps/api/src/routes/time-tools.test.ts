import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Управление трекером через ассистента.
//
// Учёт времени опасен тем, что ошибка в нём тихая: неверные часы выглядят как
// верные, а по ним выставляют счета. Поэтому здесь проверяется не наличие
// инструментов, а то, что они не дают испортить чужие записи и не теряют
// связи при переносе.

const bridge = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')
const mcp = readFileSync(join(import.meta.dirname, '..', '..', '..', 'mcp', 'src', 'index.ts'), 'utf8')
const docs = readFileSync(join(import.meta.dirname, '..', 'lib', 'bridge-docs.ts'), 'utf8')

/** Тело обработчика моста от его начала до следующего маршрута. */
function handler(method: string, path: string): string {
  const re = new RegExp(`bridgeRoute\\.${method}\\(\\s*'${path.replace(/[/:]/g, (m) => `\\${m}`)}'`)
  const m = re.exec(bridge)
  expect(m, `ручка ${method.toUpperCase()} ${path} не найдена`).not.toBeNull()
  const rest = bridge.slice(m!.index + 20)
  const end = rest.indexOf('bridgeRoute.')
  return rest.slice(0, end === -1 ? undefined : end)
}

describe('чужие часы не правятся', () => {
  const body = handler('patch', '/time/:id')

  it('своя запись либо право на правку задач', () => {
    // Саботаж: снять эту проверку — и любой участник проекта сможет
    // переписать чужие часы, а заметят это при выставлении счёта.
    expect(body).toMatch(/entry\.userId !== id\.userId/)
    expect(body).toMatch(/'tasks\.edit'/)
    expect(body).toMatch(/belongs to someone else/)
  })

  it('запись ищется в своём проекте', () => {
    expect(body).toMatch(/eq\(timeEntries\.projectId, scope\.projectId\)/)
  })

  it('чужие записи в списке — только руководству', () => {
    const list = handler('get', '/time')
    expect(list).toMatch(/privileged/)
    expect(list).toMatch(/'tasks\.edit'/)
  })
})

describe('перенос в другой проект', () => {
  const body = handler('patch', '/time/:id')

  it('связь с задачей рвётся', () => {
    // Задача осталась в прежнем проекте: без обнуления запись ссылалась бы
    // на задачу, которой в новом проекте нет, и отчёт показал бы пустоту.
    const at = body.indexOf('targetProject = b.project')
    expect(at, 'смена проекта не найдена').toBeGreaterThan(-1)
    // Окно узкое намеренно: ниже есть ВТОРОЙ patch.taskId = null — из ветки
    // «task передали пустым». С широким окном тест зеленел бы, даже если
    // обнуление при переносе убрать, и связь с чужой задачей уцелела бы.
    expect(body.slice(at, at + 200)).toMatch(/patch\.taskId = null/)
  })

  it('проект меняется только по явному указанию', () => {
    expect(body).toMatch(/let targetProject = entry\.projectId/)
    expect(body).toMatch(/if \(b\.project !== undefined\)/)
  })
})

describe('границы записи', () => {
  it('конец не раньше начала', () => {
    const body = handler('patch', '/time/:id')
    expect(body).toMatch(/till\.getTime\(\) <= from\.getTime\(\)/)
  })

  it('незакрытую запись можно снова открыть', () => {
    // endedAt: null — «снова идёт», а не «не трогай»: разница существенная,
    // и в коде она названа.
    const body = handler('patch', '/time/:id')
    expect(body).toMatch(/b\.endedAt !== undefined/)
  })

  it('смена через полночь читается как следующий день', () => {
    const body = handler('post', '/time')
    expect(body).toMatch(/86_400_000/)
  })
})

describe('ассистент умеет то же, что человек', () => {
  it('пять новых инструментов зарегистрированы', () => {
    for (const tool of [
      'chatick_timer_stop',
      'chatick_time_log',
      'chatick_time_list',
      'chatick_time_update',
      'chatick_time_report',
    ]) {
      expect(mcp, `${tool} не зарегистрирован`).toMatch(new RegExp(`'${tool}'`))
    }
  })

  it('правка умеет переносить между проектами', () => {
    const at = mcp.indexOf("'chatick_time_update'")
    const body = mcp.slice(at, at + 2600)
    expect(body).toMatch(/moveToProject/)
    // Поле называется project на стороне моста — иначе перенос молча не
    // сработает, а инструмент отчитается успехом.
    expect(body).toMatch(/\{ project: moveToProject \}/)
  })

  it('главный сценарий назван прямо', () => {
    // Без этого ассистент не догадается, что перенос возможен, и предложит
    // человеку править руками.
    const at = mcp.indexOf("'chatick_time_update'")
    expect(mcp.slice(at, at + 2600)).toMatch(/timer was running on/)
  })

  it('выдумывать часы запрещено словами', () => {
    const at = mcp.indexOf("'chatick_time_log'")
    expect(mcp.slice(at, at + 1800)).toMatch(/invented hours/)
  })

  it('гайд объясняет перенос, а не только называет поле', () => {
    expect(docs).toMatch(/MOVES the entry/)
    expect(docs).toMatch(/task link/)
  })
})
