import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { projects, users } from '../db/schema.js'
import { releaseBalls } from './ball.js'
import { notify } from './notify.js'
import { projectPath } from './links.js'
import { tasksChanged } from '../ws.js'

/**
 * Человек больше не в проекте(ах): раздать его мячи и сказать об этом тем,
 * кому они достались — ОДНИМ уведомлением на человека, а не по одному на
 * задачу. Уход человека с полусотней задач иначе завалил бы владельца
 * полусотней одинаковых строк.
 *
 * Никогда не бросает: удаление участника не должно падать из-за раздачи
 * (Atlas убирает людей сам и на отказ не рассчитан). Зовётся ПОСЛЕ удаления
 * членства — так «кто в команде» уже без него.
 */
export async function releaseMember(projectIds: string[], userId: string, actorId: string | null): Promise<void> {
  if (!projectIds.length) return
  try {
    const leaver = await db.query.users.findFirst({ where: eq(users.id, userId) })
    const rows = await db.select({ id: projects.id, companyId: projects.companyId }).from(projects).where(inArray(projects.id, projectIds))
    for (const p of rows) {
      const r = await releaseBalls(p.id, userId, actorId)
      if (!r.tasks) continue
      tasksChanged(p.id, [userId, ...r.moved.keys()])
      for (const [to, count] of r.moved) {
        await notify({
          projectId: p.id,
          event: 'task_handoff',
          titleKey: 'handoff_released',
          recipientIds: [to],
          actorId,
          actorName: '',
          link: projectPath(p.companyId, p.id, '/tasks'),
          vars: { count: String(count), person: leaver?.name || leaver?.email || '—' },
        })
      }
    }
  } catch (e) {
    console.error('[member-leave] release failed:', e)
  }
}
