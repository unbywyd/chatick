import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../env.js'

/**
 * Миграции v2.
 *
 * До v2 журнал drizzle отставал от базы: 28 миграций писались руками и в журнал
 * не попали, и штатный запуск пытался накатить уже применённое заново. Их итог
 * собран в одну точку отсчёта — 0000_baseline (точная схема прода на 11.10.2026),
 * а сами они лежат в drizzle-legacy/ как история.
 *
 * Журнал применённых — НОВАЯ таблица: старая (__drizzle_migrations) помнит
 * прежнюю нумерацию, и смешивать их нельзя.
 *
 * Существующая база точку отсчёта не выполняет — её схема уже такая. Помечаем
 * применённой, но только если база действительно дошла до последней прежней
 * миграции (0097, статус «Отменено»): иначе это старая инсталляция, и накатывать
 * поверх неё нельзя ни точку отсчёта, ни то, что после.
 */
export const MIGRATIONS_TABLE = '__drizzle_migrations_v2'
export const MIGRATIONS_SCHEMA = 'drizzle'
const BASELINE = '0000_baseline'

// Migrations use a dedicated single connection (not the app pool).
const sql = postgres(env.DATABASE_URL, {
  max: 1,
  ssl: env.DATABASE_URL.includes('sslmode=no-verify') ? { rejectUnauthorized: false } : undefined,
})

async function markBaselineOnExistingDb() {
  const [probe] = await sql<{ existing: boolean }[]>`select to_regclass('public.users') is not null as existing`
  if (!probe?.existing) return // пустая база — точка отсчёта создаст всё

  await sql`create schema if not exists ${sql(MIGRATIONS_SCHEMA)}`
  await sql`create table if not exists ${sql(MIGRATIONS_SCHEMA)}.${sql(MIGRATIONS_TABLE)} (
    id serial primary key, hash text not null, created_at bigint
  )`
  const [applied] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(MIGRATIONS_SCHEMA)}.${sql(MIGRATIONS_TABLE)}`
  if ((applied?.n ?? 0) > 0) return // уже на новом журнале

  const [state] = await sql<{ current: boolean }[]>`
    select exists(
      select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
      where t.typname = 'task_status' and e.enumlabel = 'cancelled'
    ) as current`
  if (!state?.current) {
    throw new Error(
      'База старее точки отсчёта v2: последняя прежняя миграция (0097_task_cancelled) не применена. ' +
        'Накатите drizzle-legacy/ вручную до 0097, затем повторите.',
    )
  }

  const journal = JSON.parse(readFileSync('./drizzle/meta/_journal.json', 'utf8')) as {
    entries: { tag: string; when: number }[]
  }
  const entry = journal.entries.find((e) => e.tag === BASELINE)
  if (!entry) throw new Error(`В журнале нет ${BASELINE}`)
  const hash = createHash('sha256').update(readFileSync(`./drizzle/${BASELINE}.sql`, 'utf8')).digest('hex')
  await sql`insert into ${sql(MIGRATIONS_SCHEMA)}.${sql(MIGRATIONS_TABLE)} (hash, created_at) values (${hash}, ${entry.when})`
  console.log('Существующая база: точка отсчёта помечена применённой.')
}

console.log('Running migrations...')
await markBaselineOnExistingDb()
await migrate(drizzle(sql), {
  migrationsFolder: './drizzle',
  migrationsTable: MIGRATIONS_TABLE,
  migrationsSchema: MIGRATIONS_SCHEMA,
})
console.log('✅ Migrations complete')
await sql.end()
