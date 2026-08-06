import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { env } from '../env.js'
import { dbConnections, dbQueryLog, dbTablePolicies } from '../db/schema.js'
import { requireProject, type ProjectEnv } from '../auth.js'
import { hasPermission, projectRoleOf } from './projects.js'
import { encrypt } from '../lib/crypto.js'
import { logActivity } from '../lib/audit.js'
import {
  describeDsn,
  introspect,
  runRead,
  testConnection,
  MAX_ROWS,
  type DbKind,
  type TablePolicy,
} from '../lib/db-bridge.js'

/**
 * Подключения к внешним БД (шаг 1: только чтение).
 *
 * Заводит подключение владелец или админ ПРОЕКТА: база относится к конкретной
 * работе, и человек, управляющий проектом, знает, что за неё подключено.
 * Требовать ради этого владельца компании — лишний шаг там, где он ничего не
 * решает.
 *
 * Строка подключения не отдаётся наружу никогда: ни в списке, ни в правке.
 * Показываем хост и имя базы — этого хватает, чтобы понять, куда подключён, и
 * недостаточно, чтобы случайно отправить пароль в переписку.
 */
export const dbConnectionsRoute = new Hono<ProjectEnv>()
dbConnectionsRoute.use('*', requireProject)

/** Наш адрес — его заказчик должен пустить к своей БД. */
export const OUTBOUND_IP = process.env.OUTBOUND_IP || '148.251.137.162'

/**
 * Фича выключена — ведём себя так, будто её нет.
 *
 * 404, а не 403: «выключено» и «нет прав» — разные вещи, и путать их значит
 * заставлять человека искать права, которых он не лишён.
 */
const enabled = () => env.DB_CONNECTIONS_ENABLED === 'true'
dbConnectionsRoute.use('*', async (c, next) => {
  if (!enabled()) return c.json({ error: 'Not found' }, 404)
  return next()
})

/** Заводить и настраивать подключения — только владелец или админ проекта. */
async function canManage(projectId: string, userId: string): Promise<boolean> {
  const m = await projectRoleOf(projectId, userId)
  return m?.role === 'owner' || m?.role === 'admin'
}

const parsePolicies = (rows: (typeof dbTablePolicies.$inferSelect)[]): TablePolicy[] =>
  rows.map((r) => ({
    schemaName: r.schemaName,
    tableName: r.tableName,
    canRead: r.canRead,
    canWrite: r.canWrite,
    hiddenColumns: JSON.parse(r.hiddenColumns || '[]') as string[],
  }))

/** Список подключений проекта. Без строк подключения — они не покидают сервер. */
dbConnectionsRoute.get('/', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await hasPermission(projectId, sub, 'resources.read'))) return c.json({ error: 'Forbidden' }, 403)

  const rows = await db
    .select()
    .from(dbConnections)
    .where(and(eq(dbConnections.projectId, projectId), isNull(dbConnections.deletedAt)))
    .orderBy(asc(dbConnections.createdAt))

  const items = await Promise.all(
    rows.map(async (r) => {
      const pol = await db.select().from(dbTablePolicies).where(eq(dbTablePolicies.connectionId, r.id))
      return {
        id: r.id,
        name: r.name,
        kind: r.kind,
        host: r.host,
        database: r.database,
        writeEnabled: r.writeEnabled,
        checkedAt: r.checkedAt,
        lastError: r.lastError,
        tablesTotal: pol.length,
        tablesReadable: pol.filter((p) => p.canRead).length,
      }
    }),
  )
  return c.json({ items, outboundIp: OUTBOUND_IP, canManage: await canManage(projectId, sub) })
})

/** Завести подключение. Связь проверяем сразу: нерабочее заводить незачем. */
dbConnectionsRoute.post(
  '/',
  zValidator(
    'json',
    z.object({
      name: z.string().min(1).max(100),
      kind: z.enum(['postgres', 'mysql']),
      dsn: z.string().min(10).max(2000),
    }),
  ),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    if (!(await canManage(projectId, sub))) return c.json({ error: 'Forbidden: project owner or admin only' }, 403)
    const b = c.req.valid('json')

    const dsnEncrypted = encrypt(b.dsn)
    const check = await testConnection(dsnEncrypted, b.kind as DbKind)
    if (!check.ok) return c.json({ error: `Could not connect: ${check.error}`, outboundIp: OUTBOUND_IP }, 400)

    const { host, database } = describeDsn(b.dsn)
    const [row] = await db
      .insert(dbConnections)
      .values({
        projectId,
        name: b.name.trim(),
        kind: b.kind,
        host,
        database,
        dsnEncrypted,
        checkedAt: new Date(),
        createdById: sub,
      })
      .returning()

    void logActivity({
      projectId,
      actorId: sub,
      action: 'create',
      entityType: 'resource',
      entityId: row!.id,
      entityLabel: `DB: ${row!.name}`,
    })
    return c.json({ id: row!.id, name: row!.name, host, database, kind: row!.kind })
  },
)

/**
 * Стянуть схему: список таблиц с колонками.
 *
 * Каждая таблица приходит ВЫКЛЮЧЕННОЙ. Автоматика находит таблицы, решение
 * «эту можно читать» принимает человек: угадывать, что из чужой базы безопасно
 * показывать, мы не вправе.
 */
dbConnectionsRoute.post('/:id/introspect', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await canManage(projectId, sub))) return c.json({ error: 'Forbidden: project owner or admin only' }, 403)

  const conn = await db.query.dbConnections.findFirst({
    where: and(eq(dbConnections.id, c.req.param('id')), eq(dbConnections.projectId, projectId), isNull(dbConnections.deletedAt)),
  })
  if (!conn) return c.json({ error: 'Not found' }, 404)

  let tables: Awaited<ReturnType<typeof introspect>>
  try {
    tables = await introspect(conn.dsnEncrypted, conn.kind as DbKind)
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await db.update(dbConnections).set({ lastError: error }).where(eq(dbConnections.id, conn.id))
    return c.json({ error, outboundIp: OUTBOUND_IP }, 400)
  }

  // Новые таблицы добавляем выключенными, у существующих настройки НЕ трогаем:
  // повторная разведка не должна сбрасывать то, что человек уже решил.
  for (const t of tables) {
    await db
      .insert(dbTablePolicies)
      .values({ connectionId: conn.id, schemaName: t.schema, tableName: t.table })
      .onConflictDoNothing()
  }
  await db.update(dbConnections).set({ checkedAt: new Date(), lastError: null }).where(eq(dbConnections.id, conn.id))

  const saved = await db.select().from(dbTablePolicies).where(eq(dbTablePolicies.connectionId, conn.id))
  const byKey = new Map(saved.map((p) => [`${p.schemaName}.${p.tableName}`, p]))
  return c.json({
    tables: tables.map((t) => {
      const p = byKey.get(`${t.schema}.${t.table}`)
      return {
        schema: t.schema,
        table: t.table,
        columns: t.columns,
        canRead: p?.canRead ?? false,
        canWrite: p?.canWrite ?? false,
        hiddenColumns: JSON.parse(p?.hiddenColumns || '[]') as string[],
      }
    }),
  })
})

/** Что можно с таблицей. Запись пока только сохраняем — исполнять её нечем. */
dbConnectionsRoute.patch(
  '/:id/tables',
  zValidator(
    'json',
    z.object({
      schema: z.string().min(1).max(100),
      table: z.string().min(1).max(200),
      canRead: z.boolean().optional(),
      canWrite: z.boolean().optional(),
      hiddenColumns: z.array(z.string().max(200)).max(200).optional(),
    }),
  ),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    if (!(await canManage(projectId, sub))) return c.json({ error: 'Forbidden: project owner or admin only' }, 403)
    const b = c.req.valid('json')

    const conn = await db.query.dbConnections.findFirst({
      where: and(eq(dbConnections.id, c.req.param('id')), eq(dbConnections.projectId, projectId), isNull(dbConnections.deletedAt)),
    })
    if (!conn) return c.json({ error: 'Not found' }, 404)

    const patch: Record<string, unknown> = { updatedAt: new Date() }
    if (b.canRead !== undefined) patch.canRead = b.canRead
    if (b.canWrite !== undefined) patch.canWrite = b.canWrite
    if (b.hiddenColumns !== undefined) patch.hiddenColumns = JSON.stringify(b.hiddenColumns)

    await db
      .insert(dbTablePolicies)
      .values({
        connectionId: conn.id,
        schemaName: b.schema,
        tableName: b.table,
        canRead: b.canRead ?? false,
        canWrite: b.canWrite ?? false,
        hiddenColumns: JSON.stringify(b.hiddenColumns ?? []),
      })
      .onConflictDoUpdate({
        target: [dbTablePolicies.connectionId, dbTablePolicies.schemaName, dbTablePolicies.tableName],
        set: patch,
      })
    return c.json({ ok: true })
  },
)

/**
 * Массовое переключение чтения по таблицам.
 *
 * Отдельная ручка, а не цикл запросов с клиента: у базы бывает полсотни
 * таблиц, и «снять все» превращалось бы в полсотни обращений — половина из
 * них успевала бы разойтись с тем, что человек видит на экране.
 *
 * Пишем только canRead: право на запись массово не раздаём даже когда оно
 * появится. Открыть на запись полсотни таблиц одним движением — не то
 * действие, которое стоит делать лёгким.
 */
dbConnectionsRoute.patch(
  '/:id/tables/bulk',
  zValidator(
    'json',
    z.object({
      /** Кого трогаем. Пусто — все таблицы подключения. */
      tables: z.array(z.object({ schema: z.string(), table: z.string() })).max(2000).optional(),
      /** true — открыть, false — закрыть, 'invert' — поменять на противоположное. */
      canRead: z.union([z.boolean(), z.literal('invert')]),
    }),
  ),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    if (!(await canManage(projectId, sub))) return c.json({ error: 'Forbidden: project owner or admin only' }, 403)
    const b = c.req.valid('json')

    const conn = await db.query.dbConnections.findFirst({
      where: and(eq(dbConnections.id, c.req.param('id')), eq(dbConnections.projectId, projectId), isNull(dbConnections.deletedAt)),
    })
    if (!conn) return c.json({ error: 'Not found' }, 404)

    const all = await db.select().from(dbTablePolicies).where(eq(dbTablePolicies.connectionId, conn.id))
    // Список пришёл — работаем только с ним: человек мог отфильтровать
    // таблицы поиском, и «снять все» должно означать «снять найденные».
    const wanted = b.tables?.length
      ? new Set(b.tables.map((t) => `${t.schema}.${t.table}`))
      : null
    const target = wanted ? all.filter((p) => wanted.has(`${p.schemaName}.${p.tableName}`)) : all

    for (const p of target) {
      const next = b.canRead === 'invert' ? !p.canRead : b.canRead
      if (next === p.canRead) continue
      await db
        .update(dbTablePolicies)
        .set({ canRead: next, updatedAt: new Date() })
        .where(eq(dbTablePolicies.id, p.id))
    }
    const after = await db.select().from(dbTablePolicies).where(eq(dbTablePolicies.connectionId, conn.id))
    return c.json({ ok: true, readable: after.filter((p) => p.canRead).length, total: after.length })
  },
)

/** Убрать подключение. Мягко: строка остаётся, но ей уже не воспользоваться. */
dbConnectionsRoute.delete('/:id', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await canManage(projectId, sub))) return c.json({ error: 'Forbidden: project owner or admin only' }, 403)

  const conn = await db.query.dbConnections.findFirst({
    where: and(eq(dbConnections.id, c.req.param('id')), eq(dbConnections.projectId, projectId)),
  })
  if (!conn) return c.json({ error: 'Not found' }, 404)

  await db.update(dbConnections).set({ deletedAt: new Date() }).where(eq(dbConnections.id, conn.id))
  void logActivity({
    projectId,
    actorId: sub,
    action: 'delete',
    entityType: 'resource',
    entityId: conn.id,
    entityLabel: `DB: ${conn.name}`,
  })
  return c.json({ ok: true })
})

/**
 * Прочитать. Общий обработчик для интерфейса и моста — правила должны быть
 * одни, а не две расходящиеся копии.
 */
export async function readFromConnection(opts: {
  projectId: string
  userId: string
  connectionId: string
  sql: string
  limit?: number
  viaBridge: boolean
}) {
  const conn = await db.query.dbConnections.findFirst({
    where: and(
      eq(dbConnections.id, opts.connectionId),
      eq(dbConnections.projectId, opts.projectId),
      isNull(dbConnections.deletedAt),
    ),
  })
  if (!conn) return { error: 'Connection not found', status: 404 as const }

  const policies = parsePolicies(
    await db.select().from(dbTablePolicies).where(eq(dbTablePolicies.connectionId, conn.id)),
  )

  const started = Date.now()
  try {
    const res = await runRead(conn.dsnEncrypted, conn.kind as DbKind, opts.sql, policies, opts.limit)
    // Пишем запрос, но не строки: в них данные заказчика, и копить их у себя
    // мы не вправе.
    void db.insert(dbQueryLog).values({
      connectionId: conn.id,
      projectId: opts.projectId,
      userId: opts.userId,
      viaBridge: opts.viaBridge,
      kind: 'read',
      sqlText: opts.sql.slice(0, 5000),
      rowCount: res.rowCount,
      ms: res.ms,
    })
    return { result: res }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    void db.insert(dbQueryLog).values({
      connectionId: conn.id,
      projectId: opts.projectId,
      userId: opts.userId,
      viaBridge: opts.viaBridge,
      kind: 'read',
      sqlText: opts.sql.slice(0, 5000),
      ms: Date.now() - started,
      error: error.slice(0, 2000),
    })
    return { error, status: 400 as const }
  }
}

dbConnectionsRoute.post(
  '/:id/read',
  zValidator('json', z.object({ sql: z.string().min(1).max(10_000), limit: z.number().int().min(1).max(MAX_ROWS).optional() })),
  async (c) => {
    const { projectId, sub } = c.get('auth')
    if (!(await hasPermission(projectId, sub, 'resources.read'))) return c.json({ error: 'Forbidden' }, 403)
    const b = c.req.valid('json')
    const r = await readFromConnection({
      projectId,
      userId: sub,
      connectionId: c.req.param('id'),
      sql: b.sql,
      limit: b.limit,
      viaBridge: false,
    })
    if ('error' in r) return c.json({ error: r.error }, r.status)
    return c.json(r.result)
  },
)

/** Журнал обращений — кто и что спрашивал у чужой базы. */
dbConnectionsRoute.get('/:id/log', async (c) => {
  const { projectId, sub } = c.get('auth')
  if (!(await canManage(projectId, sub))) return c.json({ error: 'Forbidden: project owner or admin only' }, 403)
  const rows = await db
    .select()
    .from(dbQueryLog)
    .where(and(eq(dbQueryLog.connectionId, c.req.param('id')), eq(dbQueryLog.projectId, projectId)))
    .orderBy(desc(dbQueryLog.createdAt))
    .limit(100)
  return c.json({ items: rows })
})
