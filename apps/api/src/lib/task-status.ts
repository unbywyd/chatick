import { sql } from 'drizzle-orm'

/**
 * Статусы задачи — ЕДИНСТВЕННОЕ место, где они перечислены и где сказано,
 * какие из них означают «закрыто».
 *
 * До появления «отменено» слово 'done' стояло в 86 местах API как синоним
 * «закрыто»: фильтры открытых задач, отпускание блокеров, просрочка, «Мои
 * задачи», плановые часы. Правило, выписанное 86 раз, разошлось бы на 87-м —
 * и отменённая задача осталась бы открытой в одной статистике, держала бы
 * блокеров в другой и висела просроченной в третьей.
 *
 * У «done» два разных смысла, и «cancelled» разделяет только один из них:
 *
 *   закрыта   — работы больше нет           done, cancelled
 *   улажена   — исполнителю делать нечего   done, verified, cancelled
 *   достигнута — работа сделана             done (и verified в «закрыл»)
 *
 * Отменённая — не достижение и не долг. В счётчики сделанного она не идёт, в
 * знаменатель прогресса тоже: иначе отмена роняла бы процент готовности, и
 * команда избегала бы отменять.
 */
export const TASK_STATUSES = ['todo', 'in_progress', 'review', 'verified', 'done', 'cancelled'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** Закрыта: работы больше нет. Блокер с таким статусом никого не держит. */
export const CLOSED_STATUSES: TaskStatus[] = ['done', 'cancelled']

/**
 * Улажена: исполнителю делать нечего. verified ждёт лишь финального done от
 * проверяющего — в «застрявшие» и «забытые» такой задаче не место.
 */
export const SETTLED_STATUSES: TaskStatus[] = ['done', 'verified', 'cancelled']

export const isClosed = (status: string): boolean => (CLOSED_STATUSES as string[]).includes(status)

/**
 * Статусы, о которых можно напоминать. Отменённые сюда не входят намеренно:
 * «напомнить об отменённой задаче» — не имеет смысла, и предлагать такой
 * выбор в настройках напоминаний незачем. Клиентский список в
 * NotificationsTab держится с этим в согласии сторожем.
 */
export const REMINDER_STATUSES = ['todo', 'in_progress', 'review', 'verified', 'done'] as const

/**
 * Для сырого SQL с алиасами: `bt.status not in ${closedSql}`.
 *
 * sql.raw, а не параметр: это список литералов enum'а, а не значение из
 * запроса, и подстановка через $1 дала бы «not in ('done,cancelled')» —
 * одну строку вместо двух.
 */
export const closedSql = sql.raw(`('done','cancelled')`)
export const settledSql = sql.raw(`('done','verified','cancelled')`)
