import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companyMembers, notifications, projects, users } from '../db/schema.js'
import { summarizeAsk } from '../lib/notify.js'

/**
 * Переписать сводки уведомлений на языке получателя.
 *
 * Сводку пишет ИИ на языке, который стоял у человека в момент создания
 * уведомления. Людей StartPlan завела внешняя система, языка она не шлёт (в
 * контракте его нет), и все получили умолчание схемы 'en' — при том, что у
 * компании стоит иврит. Сводки записались по-английски и лежат в базе рядом с
 * ивритским текстом.
 *
 * Язык у людей уже исправлен, но записанные сводки смена языка не трогает:
 * это сохранённый текст, а не вычисляемое значение.
 *
 * Скрипт зовёт ТУ ЖЕ функцию, что и боевой код, — иначе промпт разошёлся бы,
 * и старые уведомления пересказывались бы иначе, чем новые.
 *
 * Запуск:
 *   npx tsx src/scripts/resummarize.ts <companyId>          — показать план
 *   npx tsx src/scripts/resummarize.ts <companyId> --apply  — переписать
 */

const companyId = process.argv[2]
const apply = process.argv.includes('--apply')

if (!companyId) {
  console.error('Нужен companyId: npx tsx src/scripts/resummarize.ts <companyId> [--apply]')
  process.exit(1)
}

async function main() {
  const company = await db.query.companies.findFirst({ where: (c, { eq: e }) => e(c.id, companyId!) })
  if (!company) {
    console.error(`Компания ${companyId} не найдена`)
    process.exit(1)
  }

  const projectIds = (
    await db.select({ id: projects.id }).from(projects).where(eq(projects.companyId, companyId!))
  ).map((p) => p.id)
  if (!projectIds.length) {
    console.log('У компании нет проектов')
    return
  }

  const memberIds = (
    await db.select({ id: companyMembers.userId }).from(companyMembers).where(eq(companyMembers.companyId, companyId!))
  ).map((m) => m.id)

  /**
   * Берём только непрочитанные и только с латинской сводкой.
   *
   * Прочитанные человек уже разобрал — переписывать их значит тратить деньги
   * на то, чего никто не увидит. Латиница в начале — признак английской
   * сводки: ивритская начинается с ивритской буквы.
   */
  const rows = await db
    .select({
      id: notifications.id,
      projectId: notifications.projectId,
      body: notifications.body,
      summary: notifications.summary,
      userId: notifications.userId,
    })
    .from(notifications)
    .where(
      and(
        inArray(notifications.projectId, projectIds),
        inArray(notifications.userId, memberIds),
        isNull(notifications.readAt),
        sql`${notifications.summary} ~ '^[A-Za-z]'`,
        sql`${notifications.body} is not null and length(${notifications.body}) > 15`,
      ),
    )

  console.log(`Компания: ${company.name} (язык ${company.locale})`)
  console.log(`Сводок к перезаписи: ${rows.length}`)
  if (!rows.length) return

  if (!apply) {
    console.log('\nПервые пять:')
    for (const r of rows.slice(0, 5)) console.log(`  ${r.summary?.slice(0, 70)}`)
    console.log('\nЭто был показ плана. Чтобы переписать, добавьте --apply')
    return
  }

  // Язык берём у КАЖДОГО получателя, а не у компании: тот, кто выбрал себе
  // другой, должен получить сводку на своём.
  const people = await db.select({ id: users.id, locale: users.locale }).from(users).where(inArray(users.id, memberIds))
  const localeOf = new Map(people.map((p) => [p.id, p.locale]))

  let done = 0
  let failed = 0
  for (const r of rows) {
    const lang = (localeOf.get(r.userId) ?? 'en').slice(0, 2)
    try {
      await summarizeAsk(
        r.id,
        r.projectId,
        r.body ?? '',
        // Автор в исходном тексте уже назван — здесь он нужен лишь как рамка
        // для модели, и подставлять чужое имя вернее, чем пустое.
        '',
        (lang === 'ru' || lang === 'he' ? lang : 'en') as 'ru' | 'he' | 'en',
      )
      done++
      if (done % 20 === 0) console.log(`  …${done}/${rows.length}`)
    } catch (e) {
      failed++
      console.error(`  сбой на ${r.id}:`, e instanceof Error ? e.message : e)
    }
  }
  console.log(`Готово: переписано ${done}, сбоев ${failed}`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
