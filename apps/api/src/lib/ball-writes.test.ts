import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BALL_FIELDS } from './ball.js'

/**
 * Сторож мяча: поля мяча в задачах пишет только lib/ball.ts.
 *
 * Журнал передач отвечает на вопрос «почему это у меня». Одна запись
 * assignee_id или status мимо ball.ts — и журнал расходится с тем, у кого
 * задача на самом деле, причём молча: ни ошибки, ни следа. Поэтому правило
 * проверяется по исходникам, а не по памяти.
 *
 * Исключения — места, которые переносят задачи как есть, а не меняют их:
 * восстановление из бэкапа и демо-данные.
 */
const SRC = join(__dirname, '..')
const EXEMPT = new Set(['lib/ball.ts', 'lib/backup.ts', 'db/seed-demo.ts', 'db/seed-en.ts', 'db/seed-notifications.ts'])

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sources(p))
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p)
  }
  return out
}

const files = sources(SRC)
  .map((p) => ({ rel: relative(SRC, p).replaceAll('\\', '/'), text: readFileSync(p, 'utf8') }))
  .filter((f) => !EXEMPT.has(f.rel))

describe('поля мяча пишет только lib/ball.ts', () => {
  it('новые задачи создаются через insertTask', () => {
    const bad = files.filter((f) => /\.insert\(\s*tasks\s*\)/.test(f.text)).map((f) => f.rel)
    expect(bad, 'используйте insertTask из lib/ball.ts').toEqual([])
  })

  it('update(tasks) не трогает полей мяча', () => {
    const bad: string[] = []
    for (const f of files) {
      for (const m of f.text.matchAll(/\.update\(\s*tasks\s*\)([\s\S]*?)\.where\(/g)) {
        const set = m[1]!
        const line = f.text.slice(0, m.index).split('\n').length
        // .set(patch) — по переменной не видно, что внутри: только литерал.
        if (/\.set\(\s*[A-Za-z_$][\w$]*\s*\)/.test(set)) bad.push(`${f.rel}:${line} — .set(<переменная>), нужен литерал или updateTask`)
        for (const k of BALL_FIELDS) if (new RegExp(`\\b${k}\\s*:`).test(set)) bad.push(`${f.rel}:${line} — пишет ${k}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('сырой SQL не обновляет задачи', () => {
    const bad = files.filter((f) => /update\s+"?tasks"?\s+set/i.test(f.text)).map((f) => f.rel)
    expect(bad).toEqual([])
  })

  it('сторож видит то, что должен: в ball.ts запись есть', () => {
    const ball = readFileSync(join(SRC, 'lib/ball.ts'), 'utf8')
    expect(ball).toMatch(/\.insert\(\s*tasks\s*\)/)
    expect(ball).toMatch(/\.update\(\s*tasks\s*\)/)
  })
})
