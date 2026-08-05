import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Вложения задач в общем списке файлов.
//
// Их десятки на каждую задачу, и в менеджере они заслоняли то, за чем туда
// заходили. Прячем на сервере, а не на клиенте: иначе страница из 50 записей
// приходила бы почти пустой, а поиск считался бы по мусору.
//
// Главное условие — что сокрытие общее. Если оно окажется только «для списка
// без фильтров», выключенный тумблер будет прятать файлы из списка и отдавать
// их же в поиске.

const src = readFileSync(join(import.meta.dirname, 'files.ts'), 'utf8')
const list = src.slice(src.indexOf("filesRoute.get('/'"), src.indexOf('const OPTIMIZABLE'))

describe('GET /api/v1/files', () => {
  it('по умолчанию вложений задач в списке нет', () => {
    expect(list).toMatch(/isNull\(files\.taskId\)/)
  })

  it('тумблер их возвращает', () => {
    expect(list).toMatch(/c\.req\.query\('withTaskFiles'\) === '1'/)
    expect(list).toMatch(/!withTaskFiles/)
  })

  it('вкладка «Задачи» и файлы конкретной задачи от тумблера не зависят', () => {
    // Иначе раздел, который существует ровно ради этих файлов, был бы пуст.
    expect(list).toMatch(/!taskId && source !== 'task' && !withTaskFiles/)
  })

  it('сокрытие общее, а не «пока не ищешь»', () => {
    // Условие не должно зависеть от поиска и дат: иначе выключенный тумблер
    // прятал бы файлы из списка и отдавал их же в поиске.
    const guard = list.match(/if \(([^)]*withTaskFiles[^)]*)\) conds\.push\(isNull\(files\.taskId\)\)/)?.[1]
    expect(guard, 'условие сокрытия не найдено').toBeTruthy()
    expect(guard).not.toMatch(/\bq\b|from|to\b/)
  })
})
