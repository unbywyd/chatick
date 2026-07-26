import { and, eq, isNull, desc } from 'drizzle-orm'
import { db } from './client.js'
import { messages, notifications, projectMembers, projects, tasks, users } from './schema.js'

/**
 * Наполняет «Входящие» одного человека правдоподобными уведомлениями.
 *
 * Зачем отдельный скрипт: notify() намеренно не уведомляет о собственных
 * действиях, поэтому наполнить свой inbox через API невозможно — нужен второй
 * человек. Здесь мы пишем от имени коллег напрямую, как это сделал бы сервер.
 *
 *   pnpm --filter @chatick/api db:seed-inbox [email]
 *
 * Существующие уведомления не трогаем: скрипт добавляет, а не подменяет.
 */

const EMAIL = process.argv[2] ?? 'unbywyd@gmail.com'

/** Уведомление ссылается на живую сущность — иначе клик ведёт в никуда. */
type Draft = {
  event: 'chat_mention' | 'task_assigned' | 'task_comment' | 'task_status'
  title: string
  body: string
  summary: string
}

const DRAFTS: Draft[] = [
  {
    event: 'chat_mention',
    title: '{actor} упомянул вас в {project}',
    body: 'Собрал сборку с новой панелью — посмотри, когда будет время.',
    summary: 'Просит посмотреть новую сборку',
  },
  {
    event: 'task_assigned',
    title: '{actor} назначил вам задачу в {project}',
    body: 'Взял на вас {task} — посмотрите, когда будет время.',
    summary: 'Назначена задача: {task}',
  },
  {
    event: 'task_comment',
    title: '{actor} прокомментировал задачу в {project}',
    body: 'Оставил комментарий в {task} — нужен ваш ответ.',
    summary: 'Комментарий в задаче: {task}',
  },
  {
    event: 'chat_mention',
    title: '{actor} упомянул вас в {project}',
    body: 'Скриншоты на лендинге устарели, нужны новые после релиза.',
    summary: 'Просит обновить скриншоты на лендинге',
  },
  {
    event: 'task_status',
    title: 'Задача перешла в «на проверке» в {project}',
    body: '{task} готова к проверке.',
    summary: 'Ждёт проверки: {task}',
  },
]

async function main() {
  const me = await db.query.users.findFirst({ where: eq(users.email, EMAIL) })
  if (!me) throw new Error(`Пользователь ${EMAIL} не найден`)

  // Проекты, где человек действительно состоит: уведомление из чужого проекта
  // он всё равно не откроет.
  const mine = await db
    .select({ p: projects })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(eq(projectMembers.userId, me.id))
  if (!mine.length) throw new Error('Нет проектов, где этот человек состоит')

  let created = 0
  for (let i = 0; i < DRAFTS.length; i++) {
    const draft = DRAFTS[i]!
    const project = mine[i % mine.length]!.p

    // Автор — коллега по проекту, но не сам получатель: уведомление о
    // собственном действии бессмысленно.
    const mates = await db
      .select({ u: users })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, project.id))
    const actor = mates.map((m) => m.u).filter((u) => u.id !== me.id)[i % Math.max(1, mates.length - 1)]
    if (!actor) continue

    // Ссылаемся на настоящую задачу или сообщение — иначе клик уведёт в пустоту.
    // Текст уведомления при этом должен ОПИСЫВАТЬ то, куда ведёт: иначе
    // человек читает про одно, попадает в другое и считает это ошибкой.
    let entityType: string | null = null
    let entityId: string | null = null
    let link = `/p/${project.id}/chat`
    let body = draft.body
    let summary = draft.summary

    if (draft.event === 'chat_mention') {
      const msg = await db.query.messages.findFirst({
        where: eq(messages.projectId, project.id),
        orderBy: desc(messages.createdAt),
      })
      if (msg) {
        entityType = 'message'
        entityId = msg.id
        link = `/p/${project.id}/chat?msg=${msg.id}`
      }
    } else {
      const task = await db.query.tasks.findFirst({
        where: and(eq(tasks.projectId, project.id), isNull(tasks.deletedAt)),
        orderBy: desc(tasks.createdAt),
      })
      if (task) {
        entityType = 'task'
        entityId = task.id
        link = `/p/${project.id}/tasks/${task.id}`
        // Пишем про ту задачу, куда ведём, а не про абстрактную.
        body = draft.body.replace('{task}', `${task.number} «${task.title}»`)
        summary = draft.summary.replace('{task}', task.title)
      }
    }

    await db.insert(notifications).values({
      userId: me.id,
      projectId: project.id,
      event: draft.event,
      actorId: actor.id,
      title: draft.title.replace('{actor}', actor.name).replace('{project}', project.name),
      body,
      summary,
      link,
      entityType,
      entityId,
      // Разносим во времени: свежие сверху, как в жизни.
      createdAt: new Date(Date.now() - i * 37 * 60_000),
    })
    created++
    console.log(`  ${actor.name} → ${project.name}: ${draft.summary}`)
  }

  console.log(`\nСоздано уведомлений: ${created} для ${me.name} <${me.email}>`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
