import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Сторож: где человека убирают из проекта или компании, там же раздают его
 * мячи. Новое место удаления без releaseMember снова оставит задачи висеть на
 * том, кого уже нет, — и заметят это только по застрявшей работе.
 */
const SRC = join(__dirname, '..')
const EXEMPT = new Set(['lib/backup.ts', 'lib/delete-project.ts', 'db/seed-demo.ts', 'db/seed-en.ts'])

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sources(p))
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p)
  }
  return out
}

describe('удаление участника раздаёт его мячи', () => {
  it('за каждым delete(projectMembers|companyMembers) следует releaseMember', () => {
    const bad: string[] = []
    for (const p of sources(SRC)) {
      const rel = relative(SRC, p).replaceAll('\\', '/')
      if (EXEMPT.has(rel)) continue
      const text = readFileSync(p, 'utf8')
      for (const m of text.matchAll(/\.delete\(\s*(projectMembers|companyMembers)\s*\)/g)) {
        const after = text.slice(m.index!, m.index! + 1500)
        if (!after.includes('releaseMember(')) bad.push(`${rel}:${text.slice(0, m.index).split('\n').length}`)
      }
    }
    expect(bad, 'удаление участника без releaseMember').toEqual([])
  })
})
