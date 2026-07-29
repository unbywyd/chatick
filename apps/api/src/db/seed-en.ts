/**
 * Демо-компания на английском — три проекта с живой историей.
 *
 *   pnpm --filter @chatick/api exec tsx src/db/seed-en.ts
 *
 * Компания помечается isDemo=true, поэтому сносится одной командой и без
 * риска задеть настоящие данные:
 *
 *   pnpm --filter @chatick/api exec tsx src/db/unseed-demo.ts --yes
 *
 * Ничего не удаляет при запуске: сид только добавляет. Полная очистка базы —
 * отдельный скрипт reset-all.ts, чтобы «залить демо» и «стереть всё» нельзя
 * было перепутать.
 */
import { eq } from 'drizzle-orm'
import { db } from './client.js'
import {
  chatSummaries,
  companies,
  companyMembers,
  documents,
  messages,
  notes,
  projectMembers,
  projects,
  taskChecklist,
  taskComments,
  taskGroups,
  tasks,
  timeEntries,
  users,
} from './schema.js'
import { hashPassword } from '../lib/password.js'

const PASSWORD = 'demo1234'

const rnd = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1))
const pick = <T,>(list: readonly T[]): T => list[rnd(0, list.length - 1)]!
const chance = (percent: number) => Math.random() * 100 < percent

const daysAgo = (days: number, hour = 10, minute = 0) => {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(hour, minute, 0, 0)
  return d
}

/** Выходные пропускаем — иначе история выглядит сгенерированной. */
const isWorkday = (d: Date) => d.getDay() !== 0 && d.getDay() !== 6

const PEOPLE = [
  { name: 'Sarah Chen', email: 'sarah@demo.chatick.com', title: 'Product Manager', resp: 'roadmap, priorities, talking to customers' },
  { name: 'Marcus Webb', email: 'marcus@demo.chatick.com', title: 'Backend Engineer', resp: 'API, database, integrations' },
  { name: 'Priya Raman', email: 'priya@demo.chatick.com', title: 'Frontend Engineer', resp: 'web app, design system' },
  { name: 'Tom Fisher', email: 'tom@demo.chatick.com', title: 'Designer', resp: 'UI, prototypes, design reviews' },
  { name: 'Elena Costa', email: 'elena@demo.chatick.com', title: 'QA Engineer', resp: 'testing, release checks, bug triage' },
  { name: 'David Okonkwo', email: 'david@demo.chatick.com', title: 'DevOps', resp: 'infrastructure, deploys, monitoring' },
]

const PROJECT_DEFS = [
  {
    name: 'Mobile App',
    about: 'iOS and Android client: orders, payments, push notifications.',
    rules: 'Write in English. Keep threads on topic — one question per message.',
    color: '#6366f1',
    finished: true,
    tasks: [
      'Onboarding screens', 'Phone number sign-in', 'Order list', 'Order details',
      'Card payments', 'Push notifications', 'Offline mode', 'Dark theme',
      'Event analytics', 'App Store build', 'Google Play build', 'Crash reporting',
      'Profile screen', 'Payment history', 'Pull-to-refresh',
    ],
  },
  {
    name: 'Website & Landing Pages',
    about: 'Marketing site, landing pages, SEO and conversion tracking.',
    rules: 'Write in English. Link the page you mean — screenshots without URLs cost everyone time.',
    color: '#f97316',
    finished: true,
    tasks: [
      'Home page redesign', 'Pricing page', 'Blog engine', 'Contact form',
      'SEO metadata', 'Page speed budget', 'Multi-language support', 'CRM integration',
      'A/B test headlines', 'Sitemap', 'Footer rework',
    ],
  },
  {
    name: 'Orders Platform',
    about: 'Internal system: inventory, logistics, reporting. Active development.',
    rules: 'Write in English. Anything touching production data needs a second pair of eyes.',
    color: '#14b8a6',
    finished: false,
    tasks: [
      'Database schema', 'Inventory API', 'Legacy data import', 'Roles and permissions',
      'Shipment report', 'Printable invoices', 'Courier integration', 'Manager notifications',
      'Executive dashboard', 'Excel export', 'Action audit log', 'Automated backups',
      'Load testing', 'API documentation', 'Error monitoring', 'Catalogue caching',
      'Order search', 'Rate limiting',
    ],
  },
] as const

const CHAT_LINES = [
  'Morning — did anyone look at the latest mockup?',
  'Yes, but the button wraps on small screens',
  'On it, should be fixed today',
  'Who is picking up the integration?',
  'I took it, expect it by Thursday',
  'Client asked to move the deadline a week',
  'That actually gives us room to breathe',
  'Pushed the branch, ready for review',
  'Tests are green, safe to merge',
  'Staging is updated, please have a look',
  'Found an edge case with empty carts',
  'Nice catch — is there a ticket for it?',
  'Created one, assigned to myself',
  'Can we ship this before Friday?',
  'Tight but doable if nothing else lands',
  'Design review moved to 3pm',
  'Numbers from last week look good',
  'Reminder: freeze starts Monday',
  'Anyone seen the flaky test on CI?',
  'It only fails when run in parallel',
  'Documented the workaround in the notes',
  'Deploy went out, no errors so far',
  'Customer reported slow search — looking into it',
  'It was a missing index, fixed',
]

const NOTE_DEFS = [
  { type: 'solution', title: 'Flaky CI test — root cause', body: '<p>Tests share a database and run in parallel. Fixed by giving each worker its own schema. If it comes back, check for a new global fixture.</p>', tags: ['ci', 'testing'] },
  { type: 'decision', title: 'We store files in S3, not in the database', body: '<p>Decided after the backup grew past 4 GB. Database keeps metadata only.</p>', tags: ['architecture', 'storage'] },
  { type: 'problem', title: 'Search gets slow past 50k orders', body: '<p>Full-text search without an index. Needs a proper GIN index before the next import.</p>', tags: ['performance'] },
  { type: 'contradiction', title: 'Two different refund windows', body: '<p>Support tells customers 14 days, the terms page says 30. Needs a call from product.</p>', tags: ['policy'] },
  { type: 'gap', title: 'No empty state in the design', body: '<p>The mockups never cover "no orders yet". Asked design to add it.</p>', tags: ['design'] },
  { type: 'business', title: 'Discount tiers', body: '<p>5+ orders a month → 5%, 20+ → 12%. Applied automatically at checkout.</p>', tags: ['pricing'] },
] as const

const DOC_DEFS = [
  { title: 'Onboarding for new engineers', content: '<h2>First day</h2><p>Get access to the repository, staging and the error tracker. Ask in chat if something is missing.</p><h2>First week</h2><p>Pick a small task end to end — it teaches the codebase faster than reading it.</p>' },
  { title: 'Release checklist', content: '<h2>Before the release</h2><ul><li>All tests green</li><li>Changelog updated</li><li>Migrations reviewed</li></ul><h2>After</h2><ul><li>Watch error rates for an hour</li><li>Post in chat that it is out</li></ul>' },
  { title: 'API conventions', content: '<h2>Naming</h2><p>Plural nouns for collections, verbs only where REST does not fit.</p><h2>Errors</h2><p>Always return a message a human can act on, never just a code.</p>' },
]

async function main() {
  const existing = await db.query.companies.findFirst({ where: eq(companies.isDemo, true) })
  if (existing) {
    console.log(`Демо-компания уже есть: "${existing.name}". Сначала снесите её (unseed-demo.ts).`)
    process.exit(1)
  }

  const passwordHash = await hashPassword(PASSWORD)

  // --- люди ------------------------------------------------------------------
  const people: { id: string; name: string; email: string; title: string; resp: string }[] = []
  for (const p of PEOPLE) {
    const [row] = await db
      .insert(users)
      .values({ name: p.name, email: p.email, passwordHash, locale: 'en' })
      .returning()
    people.push({ id: row!.id, ...p })
  }
  const owner = people[0]!

  // --- компания --------------------------------------------------------------
  const [company] = await db
    .insert(companies)
    .values({ name: 'Northwind Studio', isDemo: true })
    .returning()

  for (const [i, p] of people.entries()) {
    await db.insert(companyMembers).values({
      companyId: company!.id,
      userId: p.id,
      role: i === 0 ? 'admin' : i === 1 ? 'manager' : 'member',
    })
  }

  console.log(`Компания "${company!.name}" (демо), людей: ${people.length}`)

  // --- проекты ---------------------------------------------------------------
  for (const def of PROJECT_DEFS) {
    const [project] = await db
      .insert(projects)
      .values({
        companyId: company!.id,
        name: def.name,
        // slug уникален на всю базу — добавляем суффикс, иначе повторный сид
        // после неполной очистки упадёт на конфликте.
        slug: `${def.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 7)}`,
        about: def.about,
        chatRules: def.rules,
        color: def.color,
        aiConfig: JSON.stringify({ language: 'en' }),
      })
      .returning()

    // Участники: все в первом проекте, часть — в остальных.
    const members = def.finished ? people : people.slice(0, 5)
    for (const [i, p] of members.entries()) {
      await db.insert(projectMembers).values({
        projectId: project!.id,
        userId: p.id,
        role: i === 0 ? 'owner' : i === 1 ? 'admin' : 'member',
        jobTitle: p.title,
        responsibility: p.resp,
        rulesAcceptedAt: new Date(),
      })
    }

    // Спринты
    const sprintNames = def.finished ? ['Q1', 'Q2', 'Backlog'] : ['Current sprint', 'Next up', 'Backlog']
    const sprints: string[] = []
    for (const [i, name] of sprintNames.entries()) {
      const [g] = await db
        .insert(taskGroups)
        .values({ projectId: project!.id, name, sortOrder: i })
        .returning()
      sprints.push(g!.id)
    }

    // Задачи
    const statuses = def.finished
      ? (['done', 'done', 'done', 'done', 'review'] as const)
      : (['todo', 'todo', 'in_progress', 'review', 'done'] as const)

    let taskNo = 0
    for (const title of def.tasks) {
      taskNo++
      const assignee = pick(members)
      const created = daysAgo(rnd(20, 85), rnd(9, 17))
      const [task] = await db
        .insert(tasks)
        .values({
          projectId: project!.id,
          number: `TASK-${taskNo}`,
          title,
          description: `<p>${title} — see the linked thread in chat for context.</p>`,
          status: pick(statuses),
          priority: pick(['low', 'normal', 'normal', 'high', 'urgent'] as const),
          assigneeId: chance(85) ? assignee.id : null,
          createdById: owner.id,
          groupId: pick(sprints),
          sortOrder: taskNo,
          estimateMinutes: String(rnd(2, 16) * 30),
          dueDate: chance(60) ? daysAgo(rnd(-14, 30), 18) : null,
          createdAt: created,
        })
        .returning()

      // Комментарии
      for (let i = 0; i < rnd(0, 3); i++) {
        await db.insert(taskComments).values({
          taskId: task!.id,
          projectId: project!.id,
          authorId: pick(members).id,
          body: `<p>${pick(['Looks good to me.', 'Blocked until the API lands.', 'Retested, works now.', 'Can we split this in two?', 'Added a note with the details.'])}</p>`,
          createdAt: new Date(created.getTime() + rnd(1, 72) * 3600_000),
        })
      }

      // Чек-лист — на каждой третьей задаче
      if (chance(35)) {
        const items = ['Check on staging', 'Update the docs', 'Ask design to confirm', 'Add a test case']
        for (const [i, text] of items.slice(0, rnd(2, 4)).entries()) {
          const done = chance(50)
          await db.insert(taskChecklist).values({
            taskId: task!.id,
            projectId: project!.id,
            text,
            note: done && chance(40) ? 'Done — no issues found.' : '',
            done,
            doneById: done ? assignee.id : null,
            doneAt: done ? new Date(created.getTime() + rnd(2, 100) * 3600_000) : null,
            sortOrder: i,
          })
        }
      }

      // Учёт времени
      if (chance(70)) {
        for (let i = 0; i < rnd(1, 3); i++) {
          const start = new Date(created.getTime() + rnd(1, 200) * 3600_000)
          const minutes = rnd(30, 240)
          await db.insert(timeEntries).values({
            projectId: project!.id,
            userId: assignee.id,
            taskId: task!.id,
            description: title,
            startedAt: start,
            endedAt: new Date(start.getTime() + minutes * 60_000),
          })
        }
      }
    }

    // Переписка: по дням, только рабочие
    let msgCount = 0
    for (let d = 90; d >= 0; d--) {
      const day = daysAgo(d)
      if (!isWorkday(day) || !chance(55)) continue
      for (let i = 0; i < rnd(2, 7); i++) {
        const at = new Date(day)
        at.setHours(rnd(9, 18), rnd(0, 59))
        await db.insert(messages).values({
          projectId: project!.id,
          authorId: pick(members).id,
          text: pick(CHAT_LINES),
          mode: 'group',
          status: 'delivered',
          createdAt: at,
        })
        msgCount++
      }
    }

    // Документы
    for (const doc of DOC_DEFS.slice(0, def.finished ? 3 : 2)) {
      await db.insert(documents).values({
        projectId: project!.id,
        title: doc.title,
        content: doc.content,
        createdById: pick(members).id,
        updatedById: pick(members).id,
      })
    }

    // Заметки
    for (const n of NOTE_DEFS.slice(0, rnd(3, 6))) {
      await db.insert(notes).values({
        projectId: project!.id,
        companyId: company!.id,
        type: n.type,
        title: n.title,
        body: n.body,
        tags: JSON.stringify(n.tags),
        scope: chance(30) ? 'company' : 'project',
        sources: '[]',
        mentionedIds: '[]',
        authorId: pick(members).id,
        createdVia: 'manual',
      })
    }

    console.log(`  ${def.name}: задач ${def.tasks.length}, сообщений ${msgCount}, участников ${members.length}`)
  }

  console.log(`\nГотово. Вход: ${owner.email} / ${PASSWORD}`)
  console.log('Снести: pnpm --filter @chatick/api exec tsx src/db/unseed-demo.ts --yes\n')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
