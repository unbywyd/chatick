import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Коррелированные подзапросы: ссылка на внешнюю строку должна быть
// КВАЛИФИЦИРОВАНА явно.
//
// Класс ошибки, а не одна ошибка. Подзапрос, который снова заходит в ту же
// таблицу, что стоит во внешнем FROM, делает имя «id» двусмысленным: Postgres
// отвечает 42702, и ручка падает с 500 целиком.
//
// Коварство в том, что до поры это работает СЛУЧАЙНО. В вебе рядом стоял
// leftJoin(users), из-за которого drizzle подставлял «tasks»."id" — и запрос
// жил. В мосте такого join не было, и тот же самый подзапрос уронил весь
// список задач. Тип-чекер здесь бессилен: SQL для него строка.
//
// Поэтому проверяем не конкретную ручку, а правило: если внутри подзапроса
// есть join той же таблицы, ссылка наружу не может быть голым ${table.id}.

const FILES = ['bridge.ts', 'tasks.ts', 'projects.ts', 'time.ts', 'files.ts']

/** Тела всех коррелированных подсчётов в файле. */
function subqueries(src: string): { body: string; line: number }[] {
  const out: { body: string; line: number }[] = []
  const re = /\(\s*select count\(\*\)::int from ([\s\S]{0,500}?)\)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    out.push({ body: m[1]!, line: src.slice(0, m.index).split('\n').length })
  }
  return out
}

describe('подзапросы не полагаются на случайную квалификацию', () => {
  for (const file of FILES) {
    const path = join(import.meta.dirname, file)
    let src: string
    try {
      src = readFileSync(path, 'utf8')
    } catch {
      continue // файла может не быть — правило от этого не меняется
    }

    it(`${file}: подзапрос, джойнящий ту же таблицу, ссылается наружу явно`, () => {
      const bad: string[] = []
      for (const { body, line } of subqueries(src)) {
        // Подзапрос снова заходит в tasks?
        const reentersTasks = /join \$\{tasks\}/.test(body)
        if (!reentersTasks) continue
        // Тогда ссылки наружу через ${tasks.id} быть не должно — только
        // "tasks"."id" или собственный алиас внешней таблицы.
        if (/\$\{tasks\.id\}/.test(body)) bad.push(`${file}:${line}`)
      }
      expect(bad, `неквалифицированная ссылка на внешнюю строку: ${bad.join(', ')}`).toEqual([])
    })
  }
})

describe('ручки-списки со счётчиками зависимостей', () => {
  const tasks = readFileSync(join(import.meta.dirname, 'tasks.ts'), 'utf8')
  const bridge = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')

  it('веб: список задач считает зависимости и переживёт снятие join', () => {
    const list = tasks.slice(tasks.indexOf("tasksRoute.get('/'"), tasks.indexOf("tasksRoute.post('/'"))
    expect(list).toMatch(/blockedBy: sql/)
    // Квалификация явная, а не за счёт соседнего leftJoin(users).
    expect(list).toMatch(/b\.blocked_task_id = "tasks"\."id"/)
    expect(list).toMatch(/b\.blocker_task_id = "tasks"\."id"/)
  })

  it('мост: тот же счёт под собственным алиасом внешней таблицы', () => {
    const fn = bridge.slice(bridge.indexOf('async function depCounts'), bridge.indexOf('// --- Задачи'))
    expect(fn).toMatch(/from \$\{tasks\} outer_t/)
    expect((fn.match(/= outer_t\.id/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})
