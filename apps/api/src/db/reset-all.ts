/**
 * ПОЛНЫЙ СБРОС: база и хранилище.
 *
 *   pnpm --filter @chatick/api exec tsx src/db/reset-all.ts --yes
 *
 * Удаляет ВСЁ: компании, проекты, людей, переписку, задачи, документы,
 * заметки, файлы — и объекты в R2/S3 следом. Восстановить нельзя.
 *
 * Файлы удаляются ПЕРВЫМИ и по одному, до того как исчезнут строки в базе:
 * ключ объекта хранится только там, и, снеся базу раньше, мы навсегда
 * потеряли бы возможность узнать, что именно чистить в хранилище. Мусор
 * остался бы лежать и капать деньгами.
 *
 * Без --yes скрипт только показывает, что собирается удалить.
 */
import { sql } from 'drizzle-orm'
import { db } from './client.js'
import { files, projects } from './schema.js'
import { eq } from 'drizzle-orm'
import { resolveStorage, deleteObject } from '../lib/s3.js'

const CONFIRMED = process.argv.includes('--yes')

/** Порядок важен: сначала зависимые таблицы, потом те, на кого они ссылаются. */
const TABLES = [
  'resource_secrets',
  'credential_access_log',
  'credentials',
  'task_checklist',
  'task_comments',
  'time_entries',
  'tasks',
  'task_groups',
  'document_versions',
  'documents',
  'notes',
  'chat_summaries',
  'sandbox_messages',
  'files',
  'messages',
  'notifications',
  'inbox_items',
  'activity_log',
  'ai_usage',
  'shares',
  'reviews',
  'bridge_sessions',
  'bridge_device_codes',
  'project_storage',
  'project_ai',
  'project_members',
  'projects',
  'company_invites',
  'company_members',
  'companies',
  'sessions',
  'users',
]

async function main() {
  const counts = await db.execute<{ table_name: string; n: number }>(sql`
    select 'companies' as table_name, count(*)::int as n from companies
    union all select 'projects', count(*)::int from projects
    union all select 'users', count(*)::int from users
    union all select 'messages', count(*)::int from messages
    union all select 'tasks', count(*)::int from tasks
    union all select 'files', count(*)::int from files
  `)

  console.log('\nБудет удалено:')
  for (const r of counts) console.log(`  ${String(r.table_name).padEnd(12)} ${r.n}`)

  if (!CONFIRMED) {
    console.log('\nЭто предпросмотр. Для удаления добавьте --yes\n')
    process.exit(0)
  }

  // --- 1. Хранилище ----------------------------------------------------------
  // Свой бакет у каждого проекта может быть разным, поэтому идём по проектам.
  const allProjects = await db.select({ id: projects.id }).from(projects)
  let removed = 0
  let failed = 0

  for (const p of allProjects) {
    const store = await resolveStorage(p.id).catch(() => null)
    if (!store) continue
    const rows = await db.select({ key: files.key, originalKey: files.originalKey }).from(files).where(eq(files.projectId, p.id))
    for (const f of rows) {
      // originalKey — несжатый оригинал картинки, отдельный объект.
      for (const key of [f.key, f.originalKey].filter(Boolean) as string[]) {
        try {
          await deleteObject(store, key)
          removed++
        } catch {
          // Не останавливаемся: один недоступный объект не повод бросить
          // остальные — иначе в хранилище останется больше мусора, а не меньше.
          failed++
        }
      }
    }
  }
  console.log(`\nХранилище: удалено ${removed}${failed ? `, не удалось ${failed}` : ''}`)

  // --- 2. База ---------------------------------------------------------------
  for (const t of TABLES) {
    try {
      await db.execute(sql.raw(`TRUNCATE TABLE "${t}" CASCADE`))
    } catch (e) {
      // Таблицы может не быть — схема менялась; это не повод падать.
      console.warn(`  пропущено ${t}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  console.log('База очищена.\n')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
