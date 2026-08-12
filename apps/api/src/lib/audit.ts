import { db } from '../db/client.js'
import { eq } from 'drizzle-orm'
import { projects } from '../db/schema.js'
import { enqueue } from './webhooks.js'
import { activityLog } from '../db/schema.js'

// Универсальный журнал действий (SPEC §8.21). Fail-safe — не роняет основной флоу.

export type ActivityAction = 'create' | 'update' | 'delete' | 'restore' | 'status' | 'assign' | 'comment' | 'upload'
export type EntityType = 'task' | 'file' | 'resource' | 'comment' | 'sprint' | 'member' | 'project' | 'document' | 'note' | 'time' | 'ai' | 'release'

export async function logActivity(params: {
  projectId: string
  actorId: string | null
  action: ActivityAction
  entityType: EntityType
  entityId?: string | null
  entityLabel?: string
  meta?: Record<string, unknown>
}): Promise<void> {
  try {
    await db.insert(activityLog).values({
      projectId: params.projectId,
      actorId: params.actorId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId ?? null,
      entityLabel: (params.entityLabel ?? '').slice(0, 500),
      meta: params.meta ? JSON.stringify(params.meta) : null,
    })
    // Внешней системе — то же событие вебхуком, если она подписана.
    // Здесь, а не в каждой ручке: журнал уже собирает все значимые изменения,
    // и второй такой список неизбежно разошёлся бы с первым.
    void notifyExternal(params).catch(() => {})
  } catch (err) {
    console.error('[audit] log failed:', err)
  }
}

/** Событие журнала → вебхук компании. Молча, если подписки нет. */
async function notifyExternal(params: {
  projectId: string
  actorId: string | null
  action: string
  entityType: string
  entityId?: string | null
  entityLabel?: string
}): Promise<void> {
  // Пока наружу отдаём только задачи: остальное для чужой статистики шум.
  if (params.entityType !== 'task') return

  const project = await db.query.projects.findFirst({ where: eq(projects.id, params.projectId) })
  if (!project?.externalId) return // проект не связан с их системой — нечего сообщать

  const event =
    params.action === 'create' ? 'task.created'
    : params.action === 'status' ? 'task.status_changed'
    : params.action === 'assign' ? 'task.assigned'
    : null
  if (!event) return

  await enqueue(project.companyId, event, {
    projectExternalId: project.externalId,
    task: params.entityLabel ?? '',
    taskId: params.entityId ?? null,
  })
}
