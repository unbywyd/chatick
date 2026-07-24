import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { messages, projects, users, tasks } from '../db/schema.js'
import { broadcast } from '../ws.js'

// Автосообщения в чат о событиях задач (SPEC §8.23).
// Публикуются как ОБЫЧНЫЕ сообщения от имени пользователя, но в обход ЛЛМ-модерации
// (status=delivered, rawSend), с пином задачи и пометкой systemEvent для компактного рендера.

type Lang = 'en' | 'ru' | 'he'
const STR: Record<Lang, { done: string; assigned: string }> = {
  en: { done: 'I finished the task', assigned: '{{name}}, I assigned you a task' },
  ru: { done: 'Я завершил(а) задачу', assigned: '{{name}}, я назначил(а) тебе задачу' },
  he: { done: 'סיימתי את המשימה', assigned: '{{name}}, הקצתי לך משימה' },
}
const langOf = (l: string | null | undefined): Lang => {
  const s = (l || 'en').slice(0, 2)
  return s === 'ru' || s === 'he' ? s : 'en'
}

async function autoPostEnabled(projectId: string): Promise<{ enabled: boolean; lang: Lang }> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  const cfg = JSON.parse(project?.aiConfig || '{}') as { autoPostTaskEvents?: boolean; language?: string }
  return { enabled: cfg.autoPostTaskEvents !== false, lang: langOf(cfg.language) }
}

/** Опубликовать в чат «Я завершил задачу TASK-N …» от имени пользователя. */
export async function postTaskDone(projectId: string, actorId: string, task: typeof tasks.$inferSelect): Promise<void> {
  try {
    const { enabled, lang } = await autoPostEnabled(projectId)
    if (!enabled) return
    const text = `${STR[lang].done} ${task.number} — ${task.title}`
    await postSystemMessage(projectId, actorId, text, task.id, 'task_done')
  } catch (err) {
    console.error('[task-events] postTaskDone failed:', err)
  }
}

/** Опубликовать в чат «@Имя, я назначил тебе задачу TASK-N …» от имени назначившего. */
export async function postTaskAssigned(
  projectId: string,
  actorId: string,
  assigneeId: string,
  task: typeof tasks.$inferSelect,
): Promise<void> {
  try {
    if (actorId === assigneeId) return // сам себе — не шумим
    const { enabled, lang } = await autoPostEnabled(projectId)
    if (!enabled) return
    const assignee = await db.query.users.findFirst({ where: eq(users.id, assigneeId) })
    if (!assignee) return
    // упоминание в нашем формате — получатель получит и in-app уведомление о меншне
    const mention = `@[${assignee.name || assignee.email}](${assignee.id})`
    const text = `${STR[lang].assigned.replace('{{name}}', mention)} ${task.number} — ${task.title}`
    await postSystemMessage(projectId, actorId, text, task.id, 'task_assigned')
  } catch (err) {
    console.error('[task-events] postTaskAssigned failed:', err)
  }
}

async function postSystemMessage(projectId: string, authorId: string, text: string, taskId: string, systemEvent: string) {
  const [row] = await db
    .insert(messages)
    .values({
      projectId,
      authorId,
      mode: 'group',
      status: 'delivered', // в обход ИИ-диспетчера
      rawSend: false,
      text,
      taskRefs: JSON.stringify([taskId]),
      systemEvent,
    })
    .returning()

  const author = await db.query.users.findFirst({ where: eq(users.id, authorId) })
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) })
  broadcast(projectId, 'message', {
    id: row!.id,
    mode: 'group',
    status: 'delivered',
    text: row!.text,
    replyToId: null,
    createdAt: row!.createdAt,
    systemEvent,
    taskPins: task ? [{ id: task.id, number: task.number, title: task.title, status: task.status }] : [],
    author: author ? { id: author.id, name: author.name, avatarUrl: author.avatarUrl } : null,
  })
}
