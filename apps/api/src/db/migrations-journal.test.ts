import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Журнал миграций не отстаёт от файлов.
 *
 * До v2 так и случилось: 28 миграций писались руками в обход журнала drizzle,
 * штатный запуск не знал о них и пытался накатить уже применённое заново.
 * Миграции на прод приходилось катать руками по одной, а установка на пустую
 * базу собирала неполную схему. Итог 97 прежних миграций собран в точку
 * отсчёта 0000_baseline; здесь — правила, которые не дают этому повториться.
 */

const API = join(import.meta.dirname, '..', '..')
const DIR = join(API, 'drizzle')
const journal = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[]
}
const sqlFiles = readdirSync(DIR).filter((f) => f.endsWith('.sql'))
const read = (p: string) => readFileSync(join(API, p), 'utf8').replace(/\r\n/g, '\n')

describe('журнал миграций', () => {
  it('каждый файл миграции записан в журнал, и наоборот', () => {
    // Саботаж: положить в drizzle/ файл, написанный руками, — тест называет его.
    const tags = journal.entries.map((e) => e.tag)
    expect(sqlFiles.map((f) => f.replace(/\.sql$/, '')).sort()).toEqual([...tags].sort())
  })

  it('номера идут подряд, время растёт', () => {
    journal.entries.forEach((e, i) => {
      expect(e.idx, e.tag).toBe(i)
      expect(e.tag.startsWith(String(i).padStart(4, '0') + '_'), e.tag).toBe(true)
      if (i > 0) expect(e.when, e.tag).toBeGreaterThan(journal.entries[i - 1]!.when)
    })
  })

  it('у последней миграции есть снимок схемы', () => {
    // Без снимка следующий drizzle-kit generate считает разницу не от той точки.
    const last = journal.entries.at(-1)!
    expect(existsSync(join(DIR, 'meta', `${String(last.idx).padStart(4, '0')}_snapshot.json`))).toBe(true)
  })

  it('в миграциях нет команд psql и смены search_path', () => {
    // \restrict и SET search_path из pg_dump ломают выполнение через drizzle:
    // первое — не SQL, второе отрезает все последующие миграции от схемы public.
    for (const f of sqlFiles) {
      const s = read(join('drizzle', f))
      expect(s, f).not.toMatch(/^\\/m)
      expect(s, f).not.toMatch(/search_path/i)
    }
  })
})

describe('точка отсчёта', () => {
  it('первой идёт 0000_baseline, прежние миграции — в истории', () => {
    expect(journal.entries[0]!.tag).toBe('0000_baseline')
    expect(existsSync(join(API, 'drizzle-legacy', '0097_task_cancelled.sql'))).toBe(true)
  })

  it('миграции ведут отдельный журнал, и drizzle-kit смотрит в тот же', () => {
    // Старый журнал помнит прежнюю нумерацию: смешать их — снова накатить
    // применённое.
    const migrate = read('src/db/migrate.ts')
    expect(migrate).toContain("export const MIGRATIONS_TABLE = '__drizzle_migrations_v2'")
    expect(migrate).toContain('migrationsTable: MIGRATIONS_TABLE')
    expect(read('drizzle.config.ts')).toContain("migrations: { table: '__drizzle_migrations_v2', schema: 'drizzle' }")
  })

  it('существующую базу помечаем, только если она дошла до последней прежней миграции', () => {
    // Иначе точка отсчёта «применится» к старой инсталляции, у которой схемы
    // ещё нет, и всё следующее посыплется.
    const migrate = read('src/db/migrate.ts')
    expect(migrate).toContain("where t.typname = 'task_status' and e.enumlabel = 'cancelled'")
    expect(migrate).toMatch(/if \(!state\?\.current\) \{\s*throw new Error/)
  })
})
