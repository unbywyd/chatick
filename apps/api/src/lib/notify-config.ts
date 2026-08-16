import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companies, projects } from '../db/schema.js'

/**
 * Настройки уведомлений: компания задаёт, проект переопределяет (SPEC §8.9).
 *
 * Раньше уведомления настраивались только в проекте, и правило вроде «о сроках
 * предупреждаем за сутки» приходилось заводить в каждом заново — десять
 * проектов, десять способов разойтись. Теперь умолчание живёт у компании.
 *
 * Наследование, а не копия при создании (как у time_config): когда правило
 * меняют, ждут, что оно изменится везде, а не только в проектах, заведённых
 * после. Проект, которому нужно иначе, пишет своё — и с этого момента живёт
 * сам по себе.
 *
 * ВАЖНО: это умолчания ПРОЕКТА, а не выбор человека. Личные отписки
 * (notification_opt_outs) сильнее — компания включает канал, человек всё равно
 * может отписаться от него у себя.
 */

export const NOTIFY_EVENTS = [
  'chat_mention',
  'task_mention',
  'comment_mention',
  'task_assigned',
  'task_status',
  'task_comment',
  'task_due',
] as const

export type NotifyEvent = (typeof NOTIFY_EVENTS)[number]

export type NotifyConfig = {
  /** Какие события вообще рассылаются в проекте. */
  events: Record<NotifyEvent, boolean>
  /** За сколько часов до срока предупреждать. */
  dueLeadHours: number
}

export const DEFAULT_NOTIFY_CONFIG: NotifyConfig = {
  events: Object.fromEntries(NOTIFY_EVENTS.map((e) => [e, true])) as Record<NotifyEvent, boolean>,
  // Сутки: предупреждение за час бесполезно — рабочий день уже расписан, а за
  // неделю его забывают. Сутки дают вечер на то, чтобы переставить планы.
  dueLeadHours: 24,
}

/** Границы: меньше часа — шум, больше двух недель — не напоминание, а прогноз. */
const MIN_LEAD = 1
const MAX_LEAD = 24 * 14

export function readNotifyConfig(raw: string | null | undefined): NotifyConfig {
  try {
    const p = JSON.parse(raw || '{}') as Partial<NotifyConfig>
    const events = { ...DEFAULT_NOTIFY_CONFIG.events }
    if (p.events && typeof p.events === 'object') {
      for (const e of NOTIFY_EVENTS) {
        // Только явный false выключает: отсутствие ключа — «не трогали»,
        // и новое событие не должно оказаться выключенным у тех, кто
        // сохранил настройки до его появления.
        if ((p.events as Record<string, unknown>)[e] === false) events[e] = false
      }
    }
    const lead = Number(p.dueLeadHours)
    return {
      events,
      dueLeadHours: Number.isFinite(lead) && lead > 0 ? Math.max(MIN_LEAD, Math.min(MAX_LEAD, Math.round(lead))) : DEFAULT_NOTIFY_CONFIG.dueLeadHours,
    }
  } catch {
    return DEFAULT_NOTIFY_CONFIG
  }
}

/**
 * Настройки для проекта: свои, иначе компании, иначе умолчания.
 *
 * «{}» — это «не задано», а не «всё по умолчанию»: пустой объект стоит у всех
 * проектов с рождения, и принимать его за настройку значило бы никогда не
 * дойти до компании.
 */
/**
 * Ставит срок в патч — и вместе с ним снимает метку «уже предупредили».
 *
 * Отдельная функция, а не две строки на каждом из четырёх путей записи (REST,
 * мост, массовая правка, ассистент): забыть сбросить метку — значит молча
 * лишить задачу напоминания навсегда, и заметить это по коду невозможно,
 * потому что всё продолжает работать.
 *
 * null в dueNotifiedAt и при снятии срока: если дату вернут, предупредить
 * надо будет заново.
 */
export function setDue<T extends { dueDate?: Date | null; dueNotifiedAt?: Date | null }>(
  patch: T,
  due: Date | null,
): T {
  patch.dueDate = due
  patch.dueNotifiedAt = null
  return patch
}

export async function notifyConfigForProject(projectId: string): Promise<NotifyConfig> {
  const row = await db
    .select({ own: projects.notifyConfig, company: companies.notifyConfig })
    .from(projects)
    .leftJoin(companies, eq(companies.id, projects.companyId))
    .where(eq(projects.id, projectId))
    .limit(1)
  const r = row[0]
  if (!r) return DEFAULT_NOTIFY_CONFIG
  const own = (r.own ?? '').trim()
  return readNotifyConfig(own && own !== '{}' ? own : r.company)
}
