import { and, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm'
import { db } from '../db/client.js'
import { flush as flushWebhooks, sweepDeliveries } from './webhooks.js'
import { notes, taskReminders, tasks, projects, projectMembers, timeEntries, users } from '../db/schema.js'
import { sendTaskReminderMail } from './mails.js'
import { env } from '../env.js'
import { sweepPendingFiles, sweepSoftDeleted } from './file-cleanup.js'
import { sweepBridge } from './bridge-auth.js'
import { sendDailyDigests } from './digest.js'
import { notify } from './notify.js'
import { timeConfigForProject } from '../routes/time.js'
import { broadcast } from '../ws.js'
import { htmlToText } from './sanitize-html.js'
import { companyOf, projectPath, projectUrl } from './links.js'
import { runDueBackups } from './auto-backup.js'
import { localeFor } from './locale.js'
import { notifyConfigForProject } from './notify-config.js'
import { checkSpendAlert } from './spend-alert.js'
import { flushQueue as flushEmbeddingQueue, sweepStaleTasks } from './embeddings.js'

// Планировщик напоминаний об открытых задачах (SPEC §8.9).
// Тик раз в 5 минут: для каждого включённого конфига проверяем, наступил ли срок,
// и если да — шлём письмо со списком задач нужным получателям.

const TICK_MS = 5 * 60 * 1000

type Lang = 'en' | 'ru' | 'he'
const STR: Record<Lang, { subject: string; intro: string; none: string; open: string; footer: string }> = {
  en: {
    subject: 'Open tasks in {project}',
    intro: 'These tasks are still open in {project}:',
    none: 'No open tasks — nice work!',
    open: 'Open project',
    footer: 'You are receiving this because task reminders are enabled for this project.',
  },
  ru: {
    subject: 'Открытые задачи в проекте «{project}»',
    intro: 'В проекте «{project}» ещё открыты задачи:',
    none: 'Открытых задач нет — отличная работа!',
    open: 'Открыть проект',
    footer: 'Вы получили это письмо, потому что в проекте включены напоминания о задачах.',
  },
  he: {
    subject: 'משימות פתוחות בפרויקט «{project}»',
    intro: 'המשימות הבאות עדיין פתוחות בפרויקט «{project}»:',
    none: 'אין משימות פתוחות — עבודה יפה!',
    open: 'פתח פרויקט',
    footer: 'קיבלת הודעה זו כי התראות משימות מופעלות בפרויקט זה.',
  },
}
const langOf = (l: string | null | undefined): Lang => {
  const s = (l || 'en').slice(0, 2)
  return s === 'ru' || s === 'he' ? s : 'en'
}
const fmt = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '')

// Жёсткий предел: не чаще одного письма в сутки, что бы ни стояло в конфиге.
// Почтовые напоминания чаще раза в день — прямой путь в спам и в раздражение.
const MIN_GAP_MS = 23 * 3600_000

/** Наступил ли срок для конфига относительно now (UTC) и lastSentAt. */
function isDue(r: typeof taskReminders.$inferSelect, now: Date): boolean {
  const last = r.lastSentAt ? new Date(r.lastSentAt) : null
  const sinceLast = last ? now.getTime() - last.getTime() : Infinity

  // hourly оставлен только ради старых записей в БД — трактуем его как daily
  const hour = Number(r.hourOfDay) || 0
  if (now.getUTCHours() !== hour) return false
  if (r.cadence === 'weekly' && now.getUTCDay() !== (Number(r.dayOfWeek) || 0)) return false
  const minGap = r.cadence === 'weekly' ? 6 * 24 * 3600_000 : MIN_GAP_MS
  return sinceLast >= minGap
}

async function runReminder(r: typeof taskReminders.$inferSelect) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, r.projectId) })
  if (!project) return

  const statuses = r.statuses.split(',').filter(Boolean) as ('todo' | 'in_progress' | 'review' | 'verified' | 'done')[]
  if (!statuses.length) return

  const openTasks = await db.query.tasks.findMany({
    where: and(eq(tasks.projectId, r.projectId), inArray(tasks.status, statuses)),
  })
  if (!openTasks.length) {
    // нечего напоминать — просто двигаем метку, чтобы не долбить проверками
    await db.update(taskReminders).set({ lastSentAt: new Date() }).where(eq(taskReminders.id, r.id))
    return
  }

  // получатели
  let recipientIds: string[]
  if (r.audience === 'assignees') {
    recipientIds = [...new Set(openTasks.map((t) => t.assigneeId).filter((x): x is string => Boolean(x)))]
  } else {
    const members = await db.query.projectMembers.findMany({ where: eq(projectMembers.projectId, r.projectId) })
    recipientIds = members.map((m) => m.userId)
  }
  if (!recipientIds.length) {
    await db.update(taskReminders).set({ lastSentAt: new Date() }).where(eq(taskReminders.id, r.id))
    return
  }

  const recipients = await db.query.users.findMany({ where: inArray(users.id, recipientIds) })
  // Компания — часть адреса проекта (SPEC §8.45).
  const companyId = (await companyOf(r.projectId)) ?? ''
  const url = projectUrl(env.APP_URL, companyId, r.projectId)

  for (const user of recipients) {
    const lang = langOf(user.locale)
    const s = STR[lang]
    // для assignees показываем только задачи этого человека; для all — все
    const list = r.audience === 'assignees' ? openTasks.filter((t) => t.assigneeId === user.id) : openTasks
    if (!list.length) continue
    await sendTaskReminderMail({
      to: user.email,
      // Не user.locale: у заведённых через API там дефолтный 'en', который
      // никто не выбирал. localeFor учитывает язык проекта и компании.
      locale: await localeFor({ userId: user.id, projectId: r.projectId }),
      projectId: r.projectId,
      projectName: project.name,
      tasks: list.map((t) => ({ number: t.number, title: t.title, status: t.status })),
    })
  }

  await db.update(taskReminders).set({ lastSentAt: new Date() }).where(eq(taskReminders.id, r.id))
}

async function tick() {
  try {
    const now = new Date()
    const configs = await db.query.taskReminders.findMany({ where: eq(taskReminders.enabled, true) })
    for (const r of configs) {
      if (isDue(r, now)) await runReminder(r)
    }
  } catch (err) {
    console.error('[reminders] tick failed:', err)
  }
}

/**
 * Наступившие напоминания в заметках (SPEC §8.31). Уведомляем автора и всех,
 * кого он в заметке упомянул — напоминание часто и ставят ради другого человека.
 * remindedAt защищает от повтора: тик идёт чаще, чем раз в сутки.
 */
async function sweepNoteReminders() {
  try {
    const due = await db.query.notes.findMany({
      where: and(
        isNotNull(notes.remindAt),
        lte(notes.remindAt, new Date()),
        isNull(notes.remindedAt),
        isNull(notes.deletedAt),
      ),
      limit: 200,
    })
    for (const n of due) {
      const author = n.authorId ? await db.query.users.findFirst({ where: eq(users.id, n.authorId) }) : null
      const mentioned = JSON.parse(n.mentionedIds) as string[]
      const recipients = [...new Set([n.authorId, ...mentioned].filter(Boolean) as string[])]
      // Уведомления живут внутри проекта: без него слать некуда, и ссылку
      // построить не из чего. Запись компании напоминание просто не шлёт —
      // отметку проставим ниже, чтобы не перебирать её каждый тик.
      if (recipients.length && n.projectId) {
        await notify({
          projectId: n.projectId,
          event: 'note_reminder',
          recipientIds: recipients,
          actorId: n.authorId ?? null,
          actorName: author?.name || 'Someone',
          dedupeKey: `note_reminder:${n.id}`,
          link: projectPath((await companyOf(n.projectId)) ?? '', n.projectId, `/notes?note=${n.id}`),
          preview: n.title || htmlToText(n.body).slice(0, 200),
          entityType: 'note',
          entityId: n.id,
        })
      }
      await db.update(notes).set({ remindedAt: new Date() }).where(eq(notes.id, n.id))
    }
  } catch (err) {
    console.error('[reminders] note reminders failed:', err)
  }
}

/**
 * Приближающийся срок задачи (SPEC §8.9).
 *
 * За сколько предупреждать — настройка проекта, а если проект молчит, то
 * компании (notifyConfigForProject). Ноль настроек в интерфейсе означал бы
 * либо шум, либо бесполезность: у стройки и у поддержки «заранее» разное.
 *
 * Кому: исполнителю, а если его нет — тем, кто задачу завёл. Всей команде
 * такое не шлём: срок чужой задачи — не твоя забота, а от уведомлений «просто
 * чтобы знали» отписываются вместе со всеми остальными.
 *
 * dueNotifiedAt защищает от повтора: тик идёт каждые 5 минут. Оно же
 * сбрасывается в null при смене срока — перенесли дату, значит про новую ещё
 * не предупреждали.
 */
async function sweepDueTasks() {
  try {
    // Берём с запасом по самому большому возможному упреждению: у каждого
    // проекта оно своё, а тянуть задачи по одному проекту за раз — лишние
    // запросы. Лишнее отсеем ниже, уже зная настройку.
    const MAX_LEAD_MS = 24 * 14 * 3600_000
    const horizon = new Date(Date.now() + MAX_LEAD_MS)

    const soon = await db.query.tasks.findMany({
      where: and(
        isNotNull(tasks.dueDate),
        isNull(tasks.dueNotifiedAt),
        isNull(tasks.deletedAt),
        lte(tasks.dueDate, horizon),
        // Сделанную задачу срок уже не касается.
        // verified тоже незакрыт: проверку прошёл, но закрыть ещё не успели —
        // забыть его здесь значит молча перестать напоминать про такие задачи.
        inArray(tasks.status, ['todo', 'in_progress', 'review', 'verified']),
      ),
      limit: 500,
    })
    if (!soon.length) return

    // Настройки читаем по проекту, а не по задаче: в одном проекте их обычно
    // десятки, и это был бы тот же ответ, полученный заново.
    const configs = new Map<string, Awaited<ReturnType<typeof notifyConfigForProject>>>()

    for (const t of soon) {
      let cfg = configs.get(t.projectId)
      if (!cfg) {
        cfg = await notifyConfigForProject(t.projectId)
        configs.set(t.projectId, cfg)
      }
      if (cfg.events.task_due === false) continue

      const due = t.dueDate!.getTime()
      const leadMs = cfg.dueLeadHours * 3600_000
      // Ещё рано — этот проект просил предупреждать позже.
      if (due - Date.now() > leadMs) continue

      const recipients = t.assigneeId
        ? [t.assigneeId]
        : t.createdById
          ? [t.createdById]
          : []
      // Некому напоминать — но метку ставим, иначе задача будет всплывать в
      // каждом тике до самого удаления.
      if (recipients.length) {
        await notify({
          projectId: t.projectId,
          event: 'task_due',
          recipientIds: recipients,
          // Срок наступает сам: актора нет, и подставлять сюда автора задачи
          // значило бы написать, будто это он что-то сделал.
          actorId: null,
          actorName: '',
          dedupeKey: `task_due:${t.id}:${t.dueDate!.toISOString()}`,
          link: projectPath((await companyOf(t.projectId)) ?? '', t.projectId, `/tasks?task=${t.id}`),
          preview: t.title,
          // Дату отдаём в ISO: notify знает язык получателя, а мы — нет.
          // Каждый получит её в своём формате, а не в нашем.
          vars: { ref: t.number, dueAt: t.dueDate!.toISOString() },
          entityType: 'task',
          entityId: t.id,
        })
      }
      await db.update(tasks).set({ dueNotifiedAt: new Date() }).where(eq(tasks.id, t.id))
    }
  } catch (err) {
    console.error('[reminders] due tasks failed:', err)
  }
}

/**
 * Забытые таймеры (SPEC §8.32). Проект решает сам: напоминать или
 * останавливать. Напоминание повторяется, пока таймер идёт, — один раз его
 * легко пропустить, а сутки в статистике портят всю картину.
 */
async function sweepRunningTimers() {
  try {
    const running = await db.query.timeEntries.findMany({ where: isNull(timeEntries.endedAt), limit: 500 })
    if (!running.length) return
    const now = Date.now()

    for (const e of running) {
      const project = await db.query.projects.findFirst({ where: eq(projects.id, e.projectId) })
      if (!project) continue
      const cfg = await timeConfigForProject(project.id)
      const hours = (now - e.startedAt.getTime()) / 3_600_000
      if (hours < cfg.idleHours) continue

      if (cfg.idleAction === 'stop') {
        // останавливаем на пороге, а не «сейчас»: время после него человек
        // не работал — иначе бы выключил
        const endedAt = new Date(e.startedAt.getTime() + cfg.idleHours * 3_600_000)
        await db.update(timeEntries).set({ endedAt, autoStopped: true, updatedAt: new Date() }).where(eq(timeEntries.id, e.id))
        broadcast(e.projectId, 'time', { action: 'stop', id: e.id, userId: e.userId })
      }

      // сколько напоминаний уже полагалось к этому моменту
      const due = Math.floor((hours - cfg.idleHours) / cfg.repeatHours) + 1
      if (cfg.idleAction === 'stop' || due > e.remindersSent) {
        const user = await db.query.users.findFirst({ where: eq(users.id, e.userId) })
        await notify({
          projectId: e.projectId,
          event: 'timer_running',
          recipientIds: [e.userId],
          actorId: null,
          actorName: user?.name || '',
          // ключ включает номер напоминания, иначе дедуп проглотит повторы
          dedupeKey: `timer_running:${e.id}:${cfg.idleAction === 'stop' ? 'auto' : due}`,
          link: projectPath((await companyOf(e.projectId)) ?? '', e.projectId, '/time'),
          preview: e.description || '',
          vars: { hours: String(Math.floor(hours)) },
          entityType: 'time',
          entityId: e.id,
        })
        if (cfg.idleAction !== 'stop') {
          await db.update(timeEntries).set({ remindersSent: due }).where(eq(timeEntries.id, e.id))
        }
      }
    }
  } catch (err) {
    console.error('[reminders] running timers failed:', err)
  }
}

export function startReminderScheduler() {
  // первый прогон через минуту после старта, далее каждые TICK_MS
  setTimeout(() => {
    void tick()
    void sweepPendingFiles()
    setInterval(() => {
      void tick()
      void sweepPendingFiles() // чистим просроченные временные вложения (SPEC §8.17)
      void sweepSoftDeleted() // окончательно удаляем корзину старше 7 дней (SPEC §8.21)
      void sweepBridge() // закрываем протухшие туннели внешнего ИИ (SPEC §8.27)
      void sendDailyDigests() // суточный email-дайджест непрочитанных (SPEC §8.22)
      void sweepNoteReminders() // напоминания в заметках (SPEC §8.31)
      void sweepRunningTimers() // забытые таймеры (SPEC §8.32)
      void sweepDueTasks() // приближающийся срок задачи (SPEC §8.9)
      // Суточный бэкап компаний в их же хранилище (SPEC §8.48). Сам решает,
      // кому пора: тик частый, а бэкап раз в сутки.
      void runDueBackups().catch(() => {})
      // Вебхуки внешним системам: очередь разбирается здесь, а не в момент
      // события — чужой сервер может лежать, и ждать его никто не должен.
      void flushWebhooks().catch(() => {})
      void sweepDeliveries().catch(() => {})
      // Траты на ИИ за месяц. Сам решает, писать ли: одно письмо на период,
      // отметка в базе — тик частый, а порог переходят один раз.
      void checkSpendAlert().catch(() => {})
      // Векторы для поиска по смыслу. Разбираем очередь пачкой: один вызов
      // модели на пятьдесят записей дешевле и быстрее, чем пятьдесят вызовов.
      // Задачи, изменённые любым путём, догоняем сверкой времени: точек
      // правки больше десятка, и подключать enqueue к каждой значит однажды
      // одну пропустить — молча.
      void sweepStaleTasks().catch(() => {})
      void flushEmbeddingQueue().catch(() => {})
    }, TICK_MS)
  }, 60_000)
  console.log('⏰ task-reminder scheduler started')
}
