import { db } from '../db/client.js'
import { activityLog } from '../db/schema.js'

// Универсальный журнал действий (SPEC §8.21). Fail-safe — не роняет основной флоу.

export type ActivityAction = 'create' | 'update' | 'delete' | 'restore' | 'status' | 'assign' | 'comment' | 'upload'
export type EntityType = 'task' | 'file' | 'resource' | 'comment' | 'sprint' | 'member' | 'project' | 'document' | 'ai'

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
  } catch (err) {
    console.error('[audit] log failed:', err)
  }
}
