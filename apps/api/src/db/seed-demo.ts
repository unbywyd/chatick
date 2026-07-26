/**
 * Демо-данные: три месяца жизни компании (SPEC §8.32).
 *
 * Зачем: посмотреть, как площадка ведёт себя на заполненной базе — скорость
 * списков, читаемость отчётов, поведение чата с историей.
 *
 * ОСТОРОЖНО: скрипт УДАЛЯЕТ всех пользователей, кроме KEEP_EMAIL, и все их
 * данные. Запускать только на демо-базе.
 *
 *   pnpm --filter @chatick/api exec tsx src/db/seed-demo.ts
 */
import { and, eq, ne, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from './client.js'
import {
  companies,
  companyMembers,
  documents,
  messages,
  notes,
  projectMembers,
  projects,
  taskComments,
  taskGroups,
  tasks,
  timeEntries,
  users,
} from './schema.js'

const KEEP_EMAIL = 'unbywyd@gmail.com'
const MONTHS = 3

// --- мелкие помощники --------------------------------------------------------

const rnd = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1))
const pick = <T,>(list: readonly T[]): T => list[rnd(0, list.length - 1)]!
const chance = (percent: number) => Math.random() * 100 < percent

/** Случайные N элементов без повторов. */
function sample<T>(list: readonly T[], n: number): T[] {
  const copy = [...list]
  const out: T[] = []
  while (out.length < n && copy.length) out.push(...copy.splice(rnd(0, copy.length - 1), 1))
  return out
}

const daysAgo = (days: number, hour = 10, minute = 0) => {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(hour, minute, 0, 0)
  return d
}

/** Рабочий ли день: выходные пропускаем, иначе история выглядит ненастоящей. */
const isWorkday = (d: Date) => d.getDay() !== 0 && d.getDay() !== 6

// --- содержимое --------------------------------------------------------------

const PEOPLE = [
  { name: 'Мария Ковальская', email: 'maria@demo.chatick.com', locale: 'ru' },
  { name: 'Дмитрий Орлов', email: 'dmitry@demo.chatick.com', locale: 'ru' },
  { name: 'Анна Литвинова', email: 'anna@demo.chatick.com', locale: 'ru' },
  { name: 'Сергей Найденов', email: 'sergey@demo.chatick.com', locale: 'ru' },
  { name: 'Ольга Пронина', email: 'olga@demo.chatick.com', locale: 'ru' },
  { name: 'Илья Барсуков', email: 'ilya@demo.chatick.com', locale: 'ru' },
  { name: 'Ekaterina Sokolova', email: 'kate@demo.chatick.com', locale: 'en' },
  { name: 'Tom Fisher', email: 'tom@demo.chatick.com', locale: 'en' },
  { name: 'Noa Levi', email: 'noa@demo.chatick.com', locale: 'he' },
  { name: 'Павел Гринько', email: 'pavel@demo.chatick.com', locale: 'ru' },
]

const PROJECT_DEFS = [
  {
    name: 'Мобильное приложение',
    about: 'Клиентское приложение под iOS и Android: заказы, оплата, пуши.',
    color: '#6366f1',
    done: true,
    tasks: [
      'Экран онбординга', 'Авторизация по номеру', 'Список заказов', 'Карточка заказа',
      'Оплата картой', 'Push-уведомления', 'Офлайн-режим', 'Локализация на иврит',
      'Тёмная тема', 'Аналитика событий', 'Сборка в App Store', 'Сборка в Google Play',
      'Краш-репорты', 'Экран профиля', 'История платежей',
    ],
  },
  {
    name: 'Сайт и лендинги',
    about: 'Маркетинговый сайт, посадочные страницы, SEO.',
    color: '#f97316',
    done: true,
    tasks: [
      'Главная страница', 'Страница тарифов', 'Блог', 'Форма заявки',
      'SEO-разметка', 'Скорость загрузки', 'Мультиязычность', 'Интеграция с CRM',
      'A/B тест заголовков', 'Карта сайта', 'Редизайн футера',
    ],
  },
  {
    name: 'Платформа заказов',
    about: 'Внутренняя система: склад, логистика, отчётность. Идёт разработка.',
    color: '#14b8a6',
    done: false,
    tasks: [
      'Схема базы данных', 'API складских остатков', 'Импорт из 1С', 'Роли и права',
      'Отчёт по отгрузкам', 'Печать накладных', 'Интеграция с курьерами', 'Уведомления менеджерам',
      'Дашборд руководителя', 'Экспорт в Excel', 'Аудит действий', 'Резервное копирование',
      'Нагрузочное тестирование', 'Документация API', 'Миграция старых данных',
      'Мониторинг ошибок', 'Кэширование каталога', 'Поиск по заказам',
    ],
  },
] as const

const CHAT_LINES = [
  'Привет! Смотрели последний макет?',
  'Да, но там кнопка съезжает на мобильном',
  'Поправлю сегодня',
  'Кто занимается интеграцией?',
  'Я взял, к четвергу будет',
  'Заказчик просит перенести дедлайн на неделю',
  'Тогда успеваем спокойно',
  'Скинул ссылку на репозиторий',
  'Тесты зелёные, можно мержить',
  'На проде отвалился вебхук, смотрю',
  'Уже починил, была опечатка в урле',
  'Сделал ревью, пара замечаний в комментариях',
  'Согласовали бюджет на следующий квартал',
  'Отпишусь как закончу',
  'Кто-нибудь видел последний отчёт?',
  'Он в документах, вкладка «Отчёты»',
  'Спасибо!',
  'Давайте созвонимся завтра в 11',
  'Ок, кину приглашение',
  'Задача готова, передаю на ревью',
  'Проверил, всё работает',
  'Обновил зависимости, ничего не сломалось',
  'Клиент доволен, просил передать спасибо команде',
  'Нужно обсудить архитектуру хранилища',
  'Предлагаю вынести это в отдельный сервис',
  'Согласен, так будет чище',
  'Закрыл три бага из бэклога',
  'Отлично, остались только мелочи',
  'Выкатили на стейджинг',
  'Проверю после обеда',
]

const WORK_DESCRIPTIONS = [
  'вёрстка экрана', 'ревью пулл-реквеста', 'созвон с командой', 'правки по макету',
  'отладка интеграции', 'написание тестов', 'разбор багов', 'документация',
  'планирование спринта', 'рефакторинг', 'настройка окружения', 'встреча с заказчиком',
]

const NOTE_SEEDS = [
  { type: 'solution', title: 'CORS падал на проде из-за префлайта', body: '<p>Симптом: запросы с фронта 403 только в проде.</p><p>Причина: nginx резал заголовок authorization в OPTIONS.</p><p>Решение: добавили access-control-allow-headers в конфиг.</p>', tags: ['nginx', 'cors'] },
  { type: 'decision', title: 'Храним файлы в S3, а не в базе', body: '<p>Обсудили на созвоне: база растёт слишком быстро, бэкапы становятся неподъёмными.</p>', tags: ['архитектура'] },
  { type: 'contradiction', title: 'Сроки по интеграции менялись дважды', body: '<p>Сначала договорились на пятницу, потом попросили к среде, в итоге спрашивали почему не готово.</p>', tags: ['сроки'] },
  { type: 'problem', title: 'Импорт из 1С падает на больших файлах', body: '<p>Файлы больше 20 МБ не проходят — таймаут. Решения пока нет.</p>', tags: ['1с', 'импорт'] },
  { type: 'business', title: 'Скидка постоянным клиентам — от 5 заказов', body: '<p>Правило подтверждено коммерческим отделом.</p>', tags: ['бизнес'] },
  { type: 'gap', title: 'В макете нет состояния пустого списка', body: '<p>Что показывать, когда заказов нет? У дизайнера не нарисовано.</p>', tags: ['дизайн'] },
]

const DOC_SEEDS = [
  { title: 'Регламент релизов', content: '<h2>Как выкатываем</h2><p>Релиз по вторникам и четвергам. Пятница — только хотфиксы.</p><ul><li>Прогнать тесты</li><li>Проверить на стейджинге</li><li>Выкатить</li><li>Отписаться в чат</li></ul>' },
  { title: 'Онбординг нового разработчика', content: '<h2>Первый день</h2><p>Доступы, репозиторий, локальное окружение.</p><h2>Первая неделя</h2><p>Взять простую задачу из бэклога, пройти весь цикл до релиза.</p>' },
  { title: 'Договорённости с заказчиком', content: '<p>Правки по макетам принимаем до среды. Всё, что позже — в следующий спринт.</p>' },
]

// --- очистка -----------------------------------------------------------------

async function wipe(keepUserId: string) {
  console.log('Чищу демо-данные…')
  // Проекты каскадом уносят задачи, сообщения, часы, заметки, документы.
  await db.delete(projects)
  // Пользователи, кроме владельца: их членства и записи уйдут каскадом.
  await db.delete(users).where(ne(users.id, keepUserId))
  console.log('  проекты и чужие пользователи удалены')
}

// --- наполнение --------------------------------------------------------------

async function seed() {
  const owner = await db.query.users.findFirst({ where: eq(users.email, KEEP_EMAIL) })
  if (!owner) throw new Error(`Нет пользователя ${KEEP_EMAIL} — сначала войдите в приложение`)

  const company = await db.query.companies.findFirst({
    where: sql`exists (select 1 from company_members cm where cm.company_id = companies.id and cm.user_id = ${owner.id})`,
  })
  if (!company) throw new Error('У пользователя нет компании — создайте её в интерфейсе')

  await wipe(owner.id)

  // --- люди ------------------------------------------------------------------
  const people = await db
    .insert(users)
    .values(
      PEOPLE.map((p) => ({
        email: p.email,
        name: p.name,
        locale: p.locale,
        // аватарки-заглушки: лица не нужны, нужна разница в списках
        avatarUrl: `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(p.name)}`,
      })),
    )
    .returning()

  await db.insert(companyMembers).values(
    people.map((u, i) => ({
      companyId: company.id,
      userId: u.id,
      // пара менеджеров, остальные участники — чтобы права было на ком проверить
      role: (i < 2 ? 'manager' : 'member') as 'manager' | 'member',
    })),
  )
  console.log(`  добавлено людей: ${people.length}`)

  const everyone = [owner, ...people]
  const totalDays = MONTHS * 30

  for (const def of PROJECT_DEFS) {
    // проект «начался» в разное время: не все стартуют в один день
    const startedDaysAgo = def.done ? rnd(totalDays - 10, totalDays) : rnd(50, 70)

    const [project] = await db
      .insert(projects)
      .values({
        companyId: company.id,
        name: def.name,
        slug: `${def.name.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-')}-${nanoid(4)}`.slice(0, 60),
        about: def.about,
        color: def.color,
        chatRules: 'По делу, без флуда. Ссылки — с описанием.',
        aiConfig: JSON.stringify({ mode: 'assistant', language: 'ru', autoTranslate: true }),
        timeConfig: JSON.stringify({ maxTimers: 1, idleAction: 'remind', idleHours: 8, repeatHours: 8, country: 'GE', timezone: 'Asia/Tbilisi', weekStart: 1 }),
        createdAt: daysAgo(startedDaysAgo),
      })
      .returning()

    // --- команда проекта -----------------------------------------------------
    const team = [owner, ...sample(people, rnd(3, 8) - 1)]
    await db.insert(projectMembers).values(
      team.map((u, i) => ({
        projectId: project!.id,
        userId: u.id,
        role: (u.id === owner.id ? 'owner' : i === 1 ? 'admin' : 'member') as 'owner' | 'admin' | 'member',
        rulesAcceptedAt: daysAgo(startedDaysAgo - 1),
        createdAt: daysAgo(startedDaysAgo),
      })),
    )

    // --- спринты -------------------------------------------------------------
    const sprintCount = rnd(2, 4)
    const sprints = await db
      .insert(taskGroups)
      .values(
        Array.from({ length: sprintCount }, (_, i) => ({
          projectId: project!.id,
          name: `Спринт ${i + 1}`,
          sortOrder: i,
          createdAt: daysAgo(startedDaysAgo - i * 14),
        })),
      )
      .returning()

    // --- задачи --------------------------------------------------------------
    const taskRows = await db
      .insert(tasks)
      .values(
        def.tasks.map((title, i) => {
          const created = rnd(10, startedDaysAgo)
          // в завершённом проекте почти всё сделано, в активном — вперемешку
          const status = def.done
            ? chance(88) ? 'done' : 'review'
            : pick(['todo', 'todo', 'in_progress', 'review', 'done', 'done'] as const)
          return {
            projectId: project!.id,
            groupId: sprints[i % sprints.length]!.id,
            number: `TASK-${i + 1}`,
            title,
            description: `<p>${title}. Подробности обсуждались в чате.</p>`,
            status: status as 'todo' | 'in_progress' | 'review' | 'done',
            priority: pick(['low', 'normal', 'normal', 'high', 'urgent'] as const),
            estimateMinutes: chance(70) ? String(rnd(2, 16) * 30) : null,
            sortOrder: i,
            dueDate: chance(60) ? daysAgo(created - rnd(3, 20)) : null,
            assigneeId: chance(85) ? pick(team).id : null,
            createdById: pick(team).id,
            createdAt: daysAgo(created),
          }
        }),
      )
      .returning()

    // --- комментарии к задачам ----------------------------------------------
    const comments = taskRows.flatMap((task) =>
      Array.from({ length: rnd(0, 4) }, () => ({
        taskId: task.id,
        projectId: project!.id,
        authorId: pick(team).id,
        body: pick(CHAT_LINES),
        createdAt: daysAgo(rnd(1, 60)),
      })),
    )
    if (comments.length) await db.insert(taskComments).values(comments)

    // --- чат -----------------------------------------------------------------
    // Сообщения раскиданы по рабочим дням: в выходные тишина, как в жизни.
    const chat: (typeof messages.$inferInsert)[] = []
    for (let day = startedDaysAgo; day >= (def.done ? 20 : 0); day--) {
      const d = daysAgo(day)
      if (!isWorkday(d) || chance(35)) continue
      for (let k = 0; k < rnd(2, 9); k++) {
        chat.push({
          projectId: project!.id,
          authorId: pick(team).id,
          mode: 'group',
          status: 'delivered',
          text: pick(CHAT_LINES),
          createdAt: daysAgo(day, rnd(9, 19), rnd(0, 59)),
        })
      }
    }
    if (chat.length) await db.insert(messages).values(chat)

    // --- учёт времени --------------------------------------------------------
    // По рабочим дням, не всем и не всегда — иначе отчёт выглядит синтетическим.
    const entries: (typeof timeEntries.$inferInsert)[] = []
    for (let day = startedDaysAgo; day >= (def.done ? 20 : 0); day--) {
      const d = daysAgo(day)
      if (!isWorkday(d)) continue
      for (const member of team) {
        if (chance(45)) continue // не каждый работает каждый день
        const startHour = rnd(9, 12)
        const startMin = pick([0, 15, 30, 45])
        const minutes = rnd(1, 9) * 45 // от 45 минут до ~7 часов
        const startedAt = daysAgo(day, startHour, startMin)
        const endedAt = new Date(startedAt.getTime() + minutes * 60_000)
        const task = chance(55) ? pick(taskRows) : null
        entries.push({
          projectId: project!.id,
          userId: member.id,
          taskId: task?.id ?? null,
          description: task ? '' : pick(WORK_DESCRIPTIONS),
          startedAt,
          endedAt,
          createdVia: chance(15) ? 'ai' : 'ui',
          createdAt: startedAt,
        })
      }
    }
    if (entries.length) await db.insert(timeEntries).values(entries)

    // --- заметки и документы -------------------------------------------------
    const projectNotes = sample(NOTE_SEEDS, rnd(2, 4)).map((n) => ({
      projectId: project!.id,
      companyId: company.id,
      type: n.type,
      title: n.title,
      body: n.body,
      tags: JSON.stringify(n.tags),
      // технические решения помечаем company — ради поиска между проектами
      scope: n.type === 'solution' ? 'company' : 'project',
      sources: '[]',
      mentionedIds: '[]',
      authorId: pick(team).id,
      createdAt: daysAgo(rnd(5, startedDaysAgo)),
    }))
    await db.insert(notes).values(projectNotes)

    const projectDocs = sample(DOC_SEEDS, rnd(1, 3)).map((doc) => ({
      projectId: project!.id,
      title: doc.title,
      content: doc.content,
      createdById: pick(team).id,
      updatedById: pick(team).id,
      createdAt: daysAgo(rnd(5, startedDaysAgo)),
    }))
    await db.insert(documents).values(projectDocs)

    console.log(
      `  «${def.name}»: команда ${team.length}, задач ${taskRows.length}, сообщений ${chat.length}, записей времени ${entries.length}`,
    )
  }
}

seed()
  .then(() => {
    console.log('Готово.')
    process.exit(0)
  })
  .catch((e) => {
    console.error('Сид упал:', e)
    process.exit(1)
  })
