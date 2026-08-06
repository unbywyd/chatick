import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Зависимости между задачами: «эта ждёт ту».
//
// Опасность здесь одна и она тихая: кольцо. A ждёт B ждёт A — и обе задачи
// невозможно закрыть НИКОГДА, потому что каждая ждёт другую. Заметить это по
// интерфейсу нельзя: на каждом шаге связь выглядит осмысленной.

const src = readFileSync(join(import.meta.dirname, 'tasks.ts'), 'utf8')

function handler(method: string, path: string): string {
  // Аргумент бывает на той же строке и на следующей — якорь не должен от
  // этого зависеть, иначе тест «зеленеет» просто потому, что не нашёл ручку.
  const re = new RegExp(`tasksRoute\\.${method}\\(\\s*'${path.replace(/[/:]/g, (m) => `\\${m}`)}'`)
  const m = re.exec(src)
  expect(m, `ручка ${method.toUpperCase()} ${path} не найдена`).not.toBeNull()
  const rest = src.slice(m!.index + 20)
  const end = rest.indexOf('tasksRoute.')
  return rest.slice(0, end === -1 ? undefined : end)
}

describe('кольца запрещены', () => {
  const body = handler('post', '/:taskId/blockers')

  it('проверка идёт ДО вставки, а не после', () => {
    const check = body.indexOf('forbidden')
    const insert = body.search(/\.insert\(taskBlockers\)/)
    expect(check).toBeGreaterThan(-1)
    expect(insert).toBeGreaterThan(check)
  })

  it('проверяется транзитивно, а не только прямая пара', () => {
    // A→B→C→A на каждом шаге выглядит невинно, поэтому одной проверки
    // «не связаны ли эти двое напрямую» мало.
    expect(body).toMatch(/dependentsOf|blockersOf/)
    expect(src).toMatch(/async function dependentsOf/)
    expect(src).toMatch(/async function blockersOf/)
  })

  it('обход идёт вширь по всей цепочке, а не на один шаг', () => {
    const fn = src.slice(src.indexOf('async function dependentsOf'))
    expect(fn).toMatch(/while \(frontier\.length\)/)
    // Без множества посещённых обход по кольцу не закончился бы никогда.
    expect(fn).toMatch(/seen\.has/)
  })

  it('отказ называет задачи, а не просто «нельзя»', () => {
    expect(body).toMatch(/Circular dependency/)
    expect(body).toMatch(/looped\.map/)
  })

  it('задача не может ждать саму себя', () => {
    expect(body).toMatch(/cannot block itself/)
  })
})

describe('связи не выходят за проект', () => {
  const body = handler('post', '/:taskId/blockers')

  it('все задачи — из этого же проекта', () => {
    // Иначе в списке зависимостей появилась бы задача, к которой у человека
    // может не быть доступа.
    expect(body).toMatch(/not in this project/)
    expect(body).toMatch(/eq\(tasks\.projectId, projectId\)/)
  })

  it('правка связей требует права на правку задач', () => {
    expect(body).toMatch(/hasPermission\(projectId, sub, 'tasks\.edit'\)/)
  })
})

describe('счётчики для списка', () => {
  const list = src.slice(src.indexOf("tasksRoute.get('/'"), src.indexOf("tasksRoute.post('/'"))

  it('считаются одним запросом вместе со списком', () => {
    // Отдельный запрос на строку — это N+1 на таблицу в тысячу задач.
    expect(list).toMatch(/blockedBy: sql/)
    expect(list).toMatch(/blocking: sql/)
  })

  it('замочек гаснет сам: ждём только НЕзакрытые', () => {
    // Связь переживает завершение блокера — это факт о работе. Но задача,
    // все блокеры которой сделаны, заблокированной уже не считается.
    const m = list.slice(list.indexOf('blockedBy: sql'), list.indexOf('blocking: sql'))
    expect(m).toMatch(/bt\.status <> 'done'/)
  })

  it('удалённые задачи в счёт не идут', () => {
    expect(list).toMatch(/bt\.deleted_at is null/)
    expect(list).toMatch(/dt\.deleted_at is null/)
  })
})

describe('кандидаты на связь', () => {
  const body = handler('get', '/:taskId/blockers/candidates')

  it('заведомо запрещённые не предлагаются', () => {
    // Дать выбрать и ответить отказом — худший вид подсказки: решение уже
    // принято, а причину надо угадывать.
    expect(body).toMatch(/forbidden\.has/)
    expect(body).toMatch(/already\.has/)
    expect(body).toMatch(/r\.task\.id !== taskId/)
  })

  it('ищет по номеру, названию и своим номерам', () => {
    expect(body).toMatch(/tasks\.title.*ilike/s)
    expect(body).toMatch(/tasks\.number.*ilike/s)
    expect(body).toMatch(/tasks\.refs.*ilike/s)
  })
})
