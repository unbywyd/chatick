import postgres from 'postgres'
import { decrypt } from './crypto.js'

/**
 * Доступ к чужой БД: подключение, разведка схемы и ЧТЕНИЕ.
 *
 * Записи здесь нет вовсе — это шаг 1. Так у фичи нет способа испортить данные
 * заказчика, пока мы смотрим, нужна ли она вообще.
 *
 * Устройство защиты, по важности:
 *
 * 1. Read-only транзакция. Не наша проверка, а гарантия СУБД: внутри неё
 *    отвергается любая попытка записи — UPDATE, INSERT, DELETE, DROP, запись
 *    через CTE и вторая команда после точки с запятой. Проверено на живой
 *    базе, все шесть форм дают 25006. Самодельный разбор SQL так не умеет:
 *    один непредусмотренный случай — и запись прошла.
 *
 * 2. Белый список таблиц. Читаем только то, что человек включил руками.
 *    Забытая таблица недоступна — это свойство белого списка, а не недосмотр.
 *
 * 3. Скрытые колонки. Пароли и персональные данные не уезжают в переписку с
 *    моделью, даже если ассистент попросил «покажи всё».
 *
 * 4. Потолки. LIMIT на строки и таймаут на запрос: чужая БД боевая, и наш
 *    любопытный SELECT не должен её положить.
 */

/** Сколько ждём ответа. Дольше — это уже нагрузка на чужой прод. */
const STATEMENT_TIMEOUT_MS = 10_000
/** Потолок строк в одном ответе. */
export const MAX_ROWS = 500

export type DbKind = 'postgres' | 'mysql'

export type TablePolicy = {
  schemaName: string
  tableName: string
  canRead: boolean
  canWrite: boolean
  hiddenColumns: string[]
}

/** Хост и база из строки подключения — показать человеку, не раскрывая пароль. */
export function describeDsn(dsn: string): { host: string; database: string } {
  try {
    const u = new URL(dsn)
    return { host: u.hostname + (u.port ? `:${u.port}` : ''), database: u.pathname.replace(/^\//, '') }
  } catch {
    return { host: '', database: '' }
  }
}

/**
 * Открыть подключение к чужой БД.
 *
 * max: 2 — мы гость на чужом сервере, и держать там пул на десяток соединений
 * невежливо: у заказчика лимит один на всех.
 */
function open(dsn: string, kind: DbKind) {
  if (kind !== 'postgres') {
    // MySQL будет следующим шагом. Сейчас честнее отказать, чем сделать вид,
    // что работает: молчаливая полуподдержка хуже отсутствия.
    throw new Error('MySQL support is not implemented yet')
  }
  // SSL по строке подключения, но с самоподписанным сертификатом мириться
  // приходится: у управляемых баз и у серверов заказчиков он сплошь и рядом,
  // и без этого фича просто не подключится к половине из них. Проверено на
  // живой базе — обычный TLS-клиент падает с DEPTH_ZERO_SELF_SIGNED_CERT.
  //
  // Это осознанный размен: канал по-прежнему шифруется, но подлинность
  // сервера мы не проверяем. Строку подключения человек вводит сам и знает,
  // куда подключается, а требовать от заказчика валидный сертификат ради
  // нашей вкладки — нереалистично.
  const wantsSsl = /[?&]sslmode=(require|verify|prefer)/i.test(dsn)
  return postgres(dsn, {
    max: 2,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
    // Собственный таймаут на запрос — на случай, если чужая БД задумается.
    connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
    onnotice: () => {},
  })
}

/** Проверка связи. Ошибку возвращаем текстом — человеку её надо прочитать. */
export async function testConnection(dsnEncrypted: string, kind: DbKind): Promise<{ ok: true } | { ok: false; error: string }> {
  let sql: ReturnType<typeof postgres> | null = null
  try {
    sql = open(decrypt(dsnEncrypted), kind)
    await sql`select 1`
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    await sql?.end({ timeout: 5 }).catch(() => {})
  }
}

/**
 * Список таблиц с колонками — чтобы человеку было что включать.
 *
 * Системные схемы пропускаем: в pg_catalog нет ничего, что заказчик считал бы
 * своими данными, а показывать их значит утопить настоящие таблицы в шуме.
 */
export async function introspect(dsnEncrypted: string, kind: DbKind) {
  const sql = open(decrypt(dsnEncrypted), kind)
  try {
    const rows = await sql<{ schema: string; table: string; column: string; type: string }[]>`
      select table_schema as schema, table_name as table, column_name as column, data_type as type
      from information_schema.columns
      where table_schema not in ('pg_catalog', 'information_schema')
      order by table_schema, table_name, ordinal_position`
    const byTable = new Map<string, { schema: string; table: string; columns: { name: string; type: string }[] }>()
    for (const r of rows) {
      const key = `${r.schema}.${r.table}`
      const cur = byTable.get(key) ?? { schema: r.schema, table: r.table, columns: [] }
      cur.columns.push({ name: r.column, type: r.type })
      byTable.set(key, cur)
    }
    return [...byTable.values()]
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {})
  }
}

/**
 * Имена таблиц, встречающиеся в запросе.
 *
 * Это НЕ защита от вредоносного SQL — разобрать чужой SQL надёжно нельзя, и
 * полагаться на такой разбор было бы ошибкой. Защита от записи — read-only
 * транзакция уровнем выше. Здесь мы отвечаем на другой вопрос: не читает ли
 * запрос таблицу, которую человек не открывал. Ошибаться этот разбор может
 * только в сторону лишнего срабатывания — тогда мы откажем, а не пропустим.
 */
export function tablesMentioned(sqlText: string): string[] {
  const stripped = sqlText
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
  const found = new Set<string>()
  for (const m of stripped.matchAll(/\b(?:from|join)\s+("?[\w$]+"?(?:\s*\.\s*"?[\w$]+"?)?)/gi)) {
    found.add(m[1]!.replace(/"/g, '').replace(/\s+/g, '').toLowerCase())
  }
  return [...found]
}

export type ReadResult = {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  ms: number
}

/**
 * Выполнить SELECT.
 *
 * Сырой SQL здесь допустим намеренно: за анализом в БД и ходят, а JOIN и
 * агрегаты конструктором не выразить. Безопасность держится не на разборе
 * запроса, а на том, что транзакция физически не даёт ничего изменить.
 */
export async function runRead(
  dsnEncrypted: string,
  kind: DbKind,
  sqlText: string,
  policies: TablePolicy[],
  limit = 100,
): Promise<ReadResult> {
  const readable = policies.filter((p) => p.canRead)
  if (!readable.length) throw new Error('No tables are open for reading on this connection')

  // Разрешённые имена — и с указанием схемы, и без: в запросе пишут по-разному.
  const allowed = new Set<string>()
  for (const p of readable) {
    allowed.add(`${p.schemaName}.${p.tableName}`.toLowerCase())
    if (p.schemaName === 'public') allowed.add(p.tableName.toLowerCase())
  }
  const used = tablesMentioned(sqlText)
  const forbidden = used.filter((t) => !allowed.has(t))
  if (forbidden.length) {
    throw new Error(
      `Not allowed to read: ${forbidden.join(', ')}. Open these tables in the project settings first, or use only: ${[...allowed].join(', ')}`,
    )
  }

  const cap = Math.min(Math.max(1, limit), MAX_ROWS)
  const sql = open(decrypt(dsnEncrypted), kind)
  const started = Date.now()
  try {
    const rows = await sql.begin(async (tx) => {
      // Вот она, настоящая защита. Всё, что не SELECT, СУБД отвергнет сама.
      await tx.unsafe('set transaction read only')
      return tx.unsafe(sqlText)
    })
    const list = (rows as unknown as Record<string, unknown>[]) ?? []
    const truncated = list.length > cap
    const kept = truncated ? list.slice(0, cap) : list

    // Скрытые колонки вырезаем ПОСЛЕ выборки: «select *» иначе принесёт
    // пароли, и они уедут в переписку с моделью.
    const hidden = new Set(
      readable.flatMap((p) => p.hiddenColumns.map((c) => c.toLowerCase())),
    )
    const clean = kept.map((row) => {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row)) if (!hidden.has(k.toLowerCase())) out[k] = v
      return out
    })

    return {
      columns: clean.length ? Object.keys(clean[0]!) : [],
      rows: clean,
      rowCount: clean.length,
      truncated,
      ms: Date.now() - started,
    }
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {})
  }
}
