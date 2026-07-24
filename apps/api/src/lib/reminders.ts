import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { taskReminders, tasks, projects, projectMembers, users } from '../db/schema.js'
import { sendMail } from './mail.js'
import { env } from '../env.js'
import { sweepPendingFiles } from './file-cleanup.js'

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

/** Наступил ли срок для конфига относительно now (UTC) и lastSentAt. */
function isDue(r: typeof taskReminders.$inferSelect, now: Date): boolean {
  const last = r.lastSentAt ? new Date(r.lastSentAt) : null
  const sinceLast = last ? now.getTime() - last.getTime() : Infinity

  if (r.cadence === 'hourly') {
    const everyMs = Math.max(1, Number(r.everyHours) || 3) * 3600_000
    return sinceLast >= everyMs
  }
  // daily / weekly: срабатывает в hourOfDay (UTC), не чаще раза за период
  const hour = Number(r.hourOfDay) || 0
  if (now.getUTCHours() !== hour) return false
  if (r.cadence === 'weekly' && now.getUTCDay() !== (Number(r.dayOfWeek) || 0)) return false
  const minGap = (r.cadence === 'weekly' ? 6 * 24 : 23) * 3600_000 // защита от повторной отправки в тот же час
  return sinceLast >= minGap
}

async function runReminder(r: typeof taskReminders.$inferSelect) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, r.projectId) })
  if (!project) return

  const statuses = r.statuses.split(',').filter(Boolean) as ('todo' | 'in_progress' | 'review' | 'done')[]
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
  const url = `${env.APP_URL.replace(/\/$/, '')}/#/p/${r.projectId}`

  for (const user of recipients) {
    const lang = langOf(user.locale)
    const s = STR[lang]
    // для assignees показываем только задачи этого человека; для all — все
    const list = r.audience === 'assignees' ? openTasks.filter((t) => t.assigneeId === user.id) : openTasks
    if (!list.length) continue
    const lines = list.map((t) => `• ${t.number} — ${t.title} [${t.status}]`)
    const text = [
      fmt(s.intro, { project: project.name }),
      '',
      ...lines,
      '',
      `${s.open}: ${url}`,
      '',
      s.footer,
    ].join('\n')
    await sendMail({ to: user.email, subject: fmt(s.subject, { project: project.name }), text })
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

export function startReminderScheduler() {
  // первый прогон через минуту после старта, далее каждые TICK_MS
  setTimeout(() => {
    void tick()
    void sweepPendingFiles()
    setInterval(() => {
      void tick()
      void sweepPendingFiles() // чистим просроченные временные вложения (SPEC §8.17)
    }, TICK_MS)
  }, 60_000)
  console.log('⏰ task-reminder scheduler started')
}
