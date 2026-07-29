/**
 * Снести демо-данные — и только их.
 *
 *   pnpm --filter @chatick/api exec tsx src/db/unseed-demo.ts --yes
 *
 * Ориентируется на companies.isDemo, а не на название: переименованную
 * компанию поиск по имени не нашёл бы, а похоже названную настоящую — снёс бы.
 *
 * Файлы в R2/S3 удаляются ДО строк в базе: ключ объекта хранится только там,
 * и, сняв базу раньше, мы уже не узнали бы, что чистить в хранилище.
 *
 * Люди удаляются только те, что состоят ИСКЛЮЧИТЕЛЬНО в демо-компании: если
 * человек успел вступить в настоящую, он остаётся.
 */
import { eq, inArray, sql } from 'drizzle-orm'
import { db } from './client.js'
import { companies, companyMembers, files, projects, users } from './schema.js'
import { resolveStorage, deleteObject } from '../lib/s3.js'

const CONFIRMED = process.argv.includes('--yes')

async function main() {
  const demo = await db.select().from(companies).where(eq(companies.isDemo, true))
  if (!demo.length) {
    console.log('Демо-компаний нет — удалять нечего.')
    process.exit(0)
  }

  const companyIds = demo.map((c) => c.id)
  const demoProjects = await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.companyId, companyIds))
  const projectIds = demoProjects.map((p) => p.id)

  const [{ n: fileCount }] = projectIds.length
    ? ((await db.select({ n: sql<number>`count(*)::int` }).from(files).where(inArray(files.projectId, projectIds))) as [{ n: number }])
    : [{ n: 0 }]

  console.log('\nБудет удалено:')
  for (const c of demo) console.log(`  компания "${c.name}"`)
  for (const p of demoProjects) console.log(`    проект "${p.name}"`)
  console.log(`  файлов в хранилище: ${fileCount}`)

  if (!CONFIRMED) {
    console.log('\nЭто предпросмотр. Для удаления добавьте --yes\n')
    process.exit(0)
  }

  // --- 1. Хранилище ----------------------------------------------------------
  let removed = 0
  let failed = 0
  for (const p of demoProjects) {
    const store = await resolveStorage(p.id).catch(() => null)
    if (!store) continue
    const rows = await db.select({ key: files.key, originalKey: files.originalKey }).from(files).where(eq(files.projectId, p.id))
    for (const f of rows) {
      for (const key of [f.key, f.originalKey].filter(Boolean) as string[]) {
        try {
          await deleteObject(store, key)
          removed++
        } catch {
          failed++
        }
      }
    }
  }
  if (fileCount) console.log(`\nХранилище: удалено ${removed}${failed ? `, не удалось ${failed}` : ''}`)

  // --- 2. Люди ---------------------------------------------------------------
  // Сначала выясняем, кто состоит только в демо: после удаления компании
  // членство исчезнет, и различить их будет уже нельзя.
  const demoMembers = await db.select({ userId: companyMembers.userId }).from(companyMembers).where(inArray(companyMembers.companyId, companyIds))
  const candidates = [...new Set(demoMembers.map((m) => m.userId))]

  const toDelete: string[] = []
  for (const userId of candidates) {
    const all = await db.select({ companyId: companyMembers.companyId }).from(companyMembers).where(eq(companyMembers.userId, userId))
    // Состоит где-то ещё — не трогаем: это может быть живой человек.
    if (all.every((m) => companyIds.includes(m.companyId))) toDelete.push(userId)
  }

  // --- 3. База ---------------------------------------------------------------
  // Каскады схемы уносят проекты, задачи, сообщения, файлы и прочее.
  await db.delete(companies).where(inArray(companies.id, companyIds))
  if (toDelete.length) await db.delete(users).where(inArray(users.id, toDelete))

  console.log(`База: снесено компаний ${demo.length}, проектов ${demoProjects.length}, людей ${toDelete.length}`)
  console.log('Настоящие данные не тронуты.\n')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
