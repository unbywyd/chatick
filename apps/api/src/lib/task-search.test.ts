import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Поиск по задачам и обсуждениям.
 *
 * «Где та таска, где я писал» — вопрос не про один проект: в StartPlan люди
 * состоят в 8–20 проектах, и перебирать их руками никто не станет.
 *
 * Опасность здесь одна и тихая: задача принадлежит ПРОЕКТУ, и поиск, забывший
 * границу членства, покажет задачи проектов, куда человека не звали. Ошибки
 * при этом не будет никакой — просто чужое в выдаче.
 */

const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8')
const lib = read('embeddings.ts')
const bridge = read('../routes/bridge.ts')
const memory = read('memory.ts')

describe('граница — проекты человека, а не компания', () => {
  it('список проектов строится по членству', () => {
    const at = lib.indexOf('export async function searchTaskIds')
    const fn = lib.slice(at)
    expect(fn).toMatch(/\.from\(projectMembers\)/)
    expect(fn).toMatch(/eq\(projectMembers\.userId, opts\.userId\)/)
  })

  it('фильтр стоит В ЗАПРОСЕ — и в словах, и в векторах', () => {
    // Саботаж: убрать inArray(...allowedIds) из любой половины — и чужие
    // задачи попадут в выдачу молча.
    const at = lib.indexOf('export async function searchTaskIds')
    const fn = lib.slice(at)
    const words = fn.split('\n').filter((l) => l.includes('inArray(tasks.projectId, allowedIds)'))
    const vectors = fn.split('\n').filter((l) => l.includes('inArray(embeddings.projectId, allowedIds)'))
    expect(words.length, 'словесный поиск без фильтра по проектам').toBeGreaterThan(0)
    expect(vectors.length, 'векторный поиск без фильтра по проектам').toBeGreaterThan(0)
    for (const line of [...words, ...vectors]) {
      expect(line.trimStart().startsWith('//'), 'фильтр закомментирован').toBe(false)
    }
  })

  it('нет проектов — пустая выдача, а не вся компания', () => {
    const at = lib.indexOf('export async function searchTaskIds')
    expect(lib.slice(at)).toMatch(/if \(!allowed\.length\) return \{ ids: \[\], semanticIds: new Set\(\) \}/)
  })
})

describe('задача и комментарии — одна запись', () => {
  it('комментарии подмешиваются в текст задачи', () => {
    // Порознь «сделал», «проверь», «ок» бессмысленны и забили бы выдачу.
    const at = lib.indexOf("if (entityType === 'task')")
    const fn = lib.slice(at, at + 2000)
    expect(fn).toMatch(/\.from\(taskComments\)/)
    expect(fn).toMatch(/comments\.map\(\(c\) => htmlToText\(c\.body\)\)/)
  })

  it('номер задачи тоже в тексте', () => {
    // «TASK-81» ищут дословно — вектор должен его знать.
    const at = lib.indexOf("if (entityType === 'task')")
    expect(lib.slice(at, at + 2000)).toMatch(/text: \[t\.number, t\.title/)
  })
})

describe('индексация догоняет, а не подключается к каждой правке', () => {
  it('сверка идёт по времени правки и последнего комментария', () => {
    // Точек правки больше десятка: интерфейс, мост, ассистент, смена статуса,
    // восстановление. Подключать enqueue к каждой значит однажды пропустить.
    const at = lib.indexOf('export async function sweepStaleTasks')
    const fn = lib.slice(at)
    expect(fn).toMatch(/e\.updated_at < t\.updated_at/)
    expect(fn).toMatch(/max\(c\.created_at\)/)
  })

  it('уже стоящее в очереди не дублируется', () => {
    const at = lib.indexOf('export async function sweepStaleTasks')
    expect(lib.slice(at)).toMatch(/not exists \(\s*select 1 from embedding_queue/)
  })

  it('сверка встроена в планировщик', () => {
    const rem = read('reminders.ts')
    expect(rem).toMatch(/void sweepStaleTasks\(\)\.catch\(\(\) => \{\}\)/)
  })
})

describe('поиск доступен обоим ассистентам', () => {
  it('мост отдаёт ручку', () => {
    expect(bridge).toMatch(/bridgeRoute\.get\('\/search\/tasks'/)
  })

  it('внутренний ассистент — свой инструмент', () => {
    expect(memory).toMatch(/name: 'search_tasks'/)
    expect(memory).toMatch(/search_tasks: async \(args\)/)
  })

  it('по умолчанию ищут ВЕЗДЕ, а не в текущем проекте', () => {
    // «Где та таска» — вопрос как раз о том, что проект забыт. Сузить можно
    // явно, но умолчание должно отвечать на заданный вопрос.
    const at = memory.indexOf('search_tasks: async (args)')
    expect(memory.slice(at, at + 1200)).toMatch(/args\.allProjects === false \? projectId : null/)
  })

  it('обоим сказано, что комментарии ищутся вместе с задачей', () => {
    const mcp = readFileSync(join(import.meta.dirname, '../../../mcp/src/index.ts'), 'utf8')
    for (const [src, who] of [[mcp, 'MCP'], [memory, 'ассистент']] as const) {
      expect(src, `${who} не объясняет про комментарии`).toMatch(/Comments are indexed together with their task/)
    }
  })
})
