/**
 * Демо-уведомления для одного человека — посмотреть, как выглядит колокольчик,
 * трей и почтовая сводка на непустом списке.
 *
 *   pnpm --filter @chatick/api exec tsx src/db/seed-notifications.ts <email>
 *
 * Только для демо-проектов (companies.is_demo): слать себе выдуманные
 * уведомления из настоящего проекта — значит засорять рабочий список тем,
 * чего не было.
 *
 * Удаляются вместе с демо-компанией (unseed-demo.ts) — каскадом по projectId.
 *
 * ВАЖНО: пишет прямо в базу, минуя notify() и сокет. Соединения живут в
 * памяти процесса API, а этот скрипт — отдельный процесс, и достучаться до
 * них не может. Значит запущенное приложение узнает о новых уведомлениях
 * только следующим опросом (до минуты), а не мгновенно.
 *
 * Поэтому сидом НЕЛЬЗЯ проверять живую доставку: он наполняет список, но не
 * повторяет путь настоящего события. Для проверки сокета нужно настоящее
 * действие — упоминание в чате, назначение задачи.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { db } from './client.js'
import { companies, notifications, projectMembers, projects, tasks, users } from './schema.js'

const email = process.argv[2] ?? 'unbywyd@gmail.com'

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

async function main() {
  const me = await db.query.users.findFirst({ where: eq(users.email, email) })
  if (!me) {
    console.error(`Пользователь ${email} не найден.`)
    process.exit(1)
  }

  const demoCompanies = await db.select({ id: companies.id }).from(companies).where(eq(companies.isDemo, true))
  if (!demoCompanies.length) {
    console.error('Демо-компании нет — сначала запустите seed-en.ts')
    process.exit(1)
  }

  // Только те демо-проекты, где человек состоит: уведомление из проекта, куда
  // нет доступа, откроется ошибкой — хуже, чем его отсутствие.
  const mine = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .innerJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, me.id)))
    .where(inArray(projects.companyId, demoCompanies.map((c) => c.id)))

  if (!mine.length) {
    console.error(`${email} не состоит ни в одном демо-проекте.`)
    process.exit(1)
  }

  // Коллеги-отправители: уведомление без автора выглядит системным.
  const mates = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .innerJoin(projectMembers, eq(projectMembers.userId, users.id))
    .where(eq(projectMembers.projectId, mine[0]!.id))
  const others = mates.filter((u) => u.id !== me.id)

  let made = 0
  let assigned = 0
  for (const project of mine) {
    const projectTasks = await db.select({ id: tasks.id, number: tasks.number, title: tasks.title }).from(tasks).where(eq(tasks.projectId, project.id)).limit(6)

    // Часть задач переводим на этого человека: уведомление «вам назначили»
    // при пустом списке «Мне» выглядит обманом — перешёл по ссылке, а задача
    // чужая. Заодно вкладка «Мне» и панель в трее перестают быть пустыми.
    const forMe = projectTasks.slice(0, 3)
    for (const t of forMe) {
      await db.update(tasks).set({ assigneeId: me.id }).where(eq(tasks.id, t.id))
      assigned++
    }
    const actor = (i: number) => others[i % Math.max(1, others.length)] ?? null

    const batch: (typeof notifications.$inferInsert)[] = []

    // Упоминание в чате
    batch.push({
      userId: me.id,
      projectId: project.id,
      event: 'chat_mention',
      actorId: actor(0)?.id ?? null,
      title: `${actor(0)?.name ?? 'Someone'} mentioned you`,
      body: 'Can you take a look at the staging build before the release?',
      summary: 'Asks you to check the staging build before the release.',
      link: `/p/${project.id}/chat`,
      entityType: 'message',
      createdAt: minutesAgo(12),
    })

    // Назначенная задача и комментарий — по реальным задачам, чтобы ссылка
    // открывала существующую карточку, а не пустоту.
    if (projectTasks[0]) {
      batch.push({
        userId: me.id,
        projectId: project.id,
        event: 'task_assigned',
        actorId: actor(1)?.id ?? null,
        title: `${actor(1)?.name ?? 'Someone'} assigned you a task`,
        body: `${projectTasks[0].number}: ${projectTasks[0].title}`,
        summary: `You are now responsible for ${projectTasks[0].number}.`,
        link: `/p/${project.id}/tasks/${projectTasks[0].id}`,
        entityType: 'task',
        entityId: projectTasks[0].id,
        createdAt: minutesAgo(48),
      })
    }
    if (projectTasks[1]) {
      batch.push({
        userId: me.id,
        projectId: project.id,
        event: 'task_comment',
        actorId: actor(2)?.id ?? null,
        title: `New comment on ${projectTasks[1].number}`,
        body: 'Retested after the fix — works on my side now.',
        link: `/p/${project.id}/tasks/${projectTasks[1].id}`,
        entityType: 'task',
        entityId: projectTasks[1].id,
        createdAt: minutesAgo(140),
      })
    }
    if (projectTasks[2]) {
      batch.push({
        userId: me.id,
        projectId: project.id,
        event: 'task_status',
        actorId: actor(3)?.id ?? null,
        title: `${projectTasks[2].number} moved to review`,
        body: projectTasks[2].title,
        link: `/p/${project.id}/tasks/${projectTasks[2].id}`,
        entityType: 'task',
        entityId: projectTasks[2].id,
        // Прочитанное — чтобы было видно оба состояния списка, а не только
        // жирные непрочитанные.
        readAt: minutesAgo(200),
        createdAt: minutesAgo(300),
      })
    }

    batch.push({
      userId: me.id,
      projectId: project.id,
      event: 'note_mention',
      actorId: actor(4)?.id ?? null,
      title: `${actor(4)?.name ?? 'Someone'} mentioned you in a note`,
      body: 'Two different refund windows — support says 14 days, terms say 30.',
      summary: 'Wants your call on which refund window is correct.',
      link: `/p/${project.id}/notes`,
      entityType: 'note',
      createdAt: minutesAgo(1500),
    })

    await db.insert(notifications).values(batch)
    made += batch.length
    console.log(`  ${project.name}: ${batch.length}`)
  }

  const unread = made - mine.length // по одному прочитанному на проект
  console.log(`\nГотово: ${made} уведомлений для ${email}, из них непрочитанных ~${unread}.`)
  console.log(`Задач переназначено на вас: ${assigned}.`)
  console.log('Снесутся вместе с демо-компанией (unseed-demo.ts).\n')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
