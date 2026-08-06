import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tablesMentioned, describeDsn, MAX_ROWS } from './db-bridge.js'

// Доступ к чужой БД.
//
// Здесь цена ошибки выше обычной: по ту сторону боевые данные заказчика, а не
// наши. Поэтому проверяем не «работает ли», а «нельзя ли обойти».

const lib = readFileSync(join(import.meta.dirname, 'db-bridge.ts'), 'utf8')
const route = readFileSync(join(import.meta.dirname, '../routes/db-connections.ts'), 'utf8')
const bridge = readFileSync(join(import.meta.dirname, '../routes/bridge.ts'), 'utf8')
const docs = readFileSync(join(import.meta.dirname, 'bridge-docs.ts'), 'utf8')

describe('запись невозможна, и это гарантия СУБД', () => {
  it('чтение идёт в read-only транзакции', () => {
    // Единственная настоящая защита. Разбор SQL так не умеет: UPDATE через
    // CTE, вторая команда после «;», подзапрос в SET — каждый пропущенный
    // случай это испорченные данные заказчика.
    expect(lib).toMatch(/set transaction read only/)
    const fn = lib.slice(lib.indexOf('export async function runRead'))
    expect(fn).toMatch(/sql\.begin/)
    expect(fn.indexOf('set transaction read only')).toBeLessThan(fn.indexOf('tx.unsafe(sqlText)'))
  })

  it('шаг 1 не содержит записи вовсе', () => {
    // Не «запись под флагом», а её отсутствие: нечему сломаться.
    expect(lib).not.toMatch(/export async function runWrite/)
    expect(lib).not.toMatch(/\bUPDATE\b.*\bSET\b/i)
  })
})

describe('белый список таблиц', () => {
  it('читаем только то, что человек включил', () => {
    const fn = lib.slice(lib.indexOf('export async function runRead'))
    expect(fn).toMatch(/policies\.filter\(\(p\) => p\.canRead\)/)
    expect(fn).toMatch(/Not allowed to read/)
  })

  it('без включённых таблиц не читаем ничего', () => {
    // Пустой список — это «ничего нельзя», а не «всё можно».
    expect(lib).toMatch(/No tables are open for reading/)
  })

  it('таблицы создаются ВЫКЛЮЧЕННЫМИ', () => {
    // Автоматика находит таблицы, решение принимает человек: угадывать, что из
    // чужой базы безопасно показывать, мы не вправе.
    expect(route).toMatch(/values\(\{ connectionId: conn\.id, schemaName: t\.schema, tableName: t\.table \}\)/)
    const schema = readFileSync(join(import.meta.dirname, '../db/schema.ts'), 'utf8')
    const tbl = schema.slice(schema.indexOf("'db_table_policies'"))
    expect(tbl.slice(0, 900)).toMatch(/canRead: boolean\('can_read'\)\.notNull\(\)\.default\(false\)/)
  })

  it('повторная разведка не сбрасывает уже выбранное', () => {
    expect(route).toMatch(/onConflictDoNothing\(\)/)
  })
})

describe('имена таблиц в запросе', () => {
  it('находит и в FROM, и в JOIN, и со схемой', () => {
    expect(tablesMentioned('select * from users').sort()).toEqual(['users'])
    expect(tablesMentioned('SELECT * FROM public.users u JOIN orders o ON o.uid=u.id').sort()).toEqual([
      'orders',
      'public.users',
    ])
  })

  it('не ведётся на «from» в комментарии и в строке', () => {
    // Иначе запрос отвергался бы из-за слова в тексте — и человек не понял бы,
    // почему безобидный SELECT «читает запрещённую таблицу».
    expect(tablesMentioned('select * from users -- from secrets')).toEqual(['users'])
    expect(tablesMentioned('select * from users /* from secrets */')).toEqual(['users'])
    expect(tablesMentioned("select * from users where note='from secrets'")).toEqual(['users'])
  })

  it('кавычки и регистр не обманывают', () => {
    expect(tablesMentioned('select * from "Users"')).toEqual(['users'])
  })
})

describe('чужие данные не утекают', () => {
  it('скрытые колонки вырезаются ПОСЛЕ выборки', () => {
    // «select *» иначе принесёт хеши паролей, и они уедут в переписку с
    // внешней моделью — навсегда.
    const fn = lib.slice(lib.indexOf('export async function runRead'))
    expect(fn).toMatch(/hidden\.has\(k\.toLowerCase\(\)\)/)
  })

  it('строка подключения не покидает сервер', () => {
    // Ни в списке, ни через мост: пароль от боевой базы заказчика.
    expect(route).not.toMatch(/dsnEncrypted: r\.dsnEncrypted/)
    expect(route).not.toMatch(/dsn: conn\.dsnEncrypted/)
    const list = bridge.slice(bridge.indexOf("bridgeRoute.get('/db'"), bridge.indexOf("bridgeRoute.post('/db/:id/read'"))
    expect(list).not.toMatch(/dsn/i)
  })

  it('в журнал пишем запрос, но не строки', () => {
    // В строках персональные данные заказчика: копить их у себя мы не вправе.
    expect(route).toMatch(/sqlText: opts\.sql\.slice/)
    expect(route).not.toMatch(/rows: res\.rows/)
  })

  it('есть потолок строк и он не бесконечный', () => {
    expect(MAX_ROWS).toBeGreaterThan(0)
    expect(MAX_ROWS).toBeLessThanOrEqual(1000)
    expect(lib).toMatch(/statement_timeout/)
  })
})

describe('фичу можно выключить', () => {
  it('выключатель гасит и REST, и мост', () => {
    expect(route).toMatch(/DB_CONNECTIONS_ENABLED !== 'true'|env\.DB_CONNECTIONS_ENABLED === 'true'/)
    const db = bridge.slice(bridge.indexOf("bridgeRoute.get('/db'"))
    expect(db.slice(0, 1200)).toMatch(/DB_CONNECTIONS_ENABLED !== 'true'/)
  })

  it('выключено — 404, а не 403', () => {
    // «Выключено» и «нет прав» — разные вещи; путать их значит гонять человека
    // искать права, которых он не лишён.
    const mw = route.slice(route.indexOf('const enabled ='), route.indexOf('async function canManage'))
    expect(mw).toMatch(/'Not found' \}, 404/)
  })
})

describe('кто заводит подключение', () => {
  it('только владелец или админ ПРОЕКТА', () => {
    // Строка подключения — ключ от боевой базы, это не то, что даётся каждому.
    expect(route).toMatch(/m\?\.role === 'owner' \|\| m\?\.role === 'admin'/)
    // Якорь по содержимому ручки, а не по её позиции: рядом появились другие
    // post-ручки, и слайс «от первого post» уезжал на них.
    const create = route.slice(route.indexOf('/** Завести подключение'), route.indexOf('* Стянуть схему'))
    expect(create.slice(0, 800)).toMatch(/canManage\(projectId, sub\)/)
  })

  it('связь проверяется до сохранения', () => {
    // Нерабочее подключение заводить незачем: человек узнает об этом позже и
    // будет гадать, что сломалось.
    // Якорь по содержимому ручки, а не по её позиции: рядом появились другие
    // post-ручки, и слайс «от первого post» уезжал на них.
    const create = route.slice(route.indexOf('/** Завести подключение'), route.indexOf('* Стянуть схему'))
    // Регуляркой, а не точной строкой: перенос строки бывает CRLF, и якорь по
    // «\n» молча не находится — тест «зеленел» бы, не проверив ничего.
    expect(create.indexOf('testConnection')).toBeLessThan(create.search(/\.insert\(dbConnections\)/))
  })

  it('при отказе показываем наш IP — его надо открыть у себя', () => {
    expect(route).toMatch(/outboundIp: OUTBOUND_IP/)
  })
})

describe('гайд для ассистента', () => {
  it('честно говорит, что писать нельзя', () => {
    expect(docs).toMatch(/You cannot write/)
    expect(docs).toMatch(/read-only transaction/)
  })

  it('велит сначала спросить список таблиц', () => {
    expect(docs).toMatch(/Call GET \/x\/db first/)
  })

  it('предупреждает про чужие персональные данные', () => {
    expect(docs).toMatch(/production data belonging to someone else/)
    expect(docs).toMatch(/do not copy personal data/)
  })

  it('объясняет обрезанную выдачу', () => {
    expect(docs).toMatch(/"truncated": true/)
  })
})

describe('разбор строки подключения', () => {
  it('показывает хост и базу, без пароля', () => {
    const d = describeDsn('postgres://user:secret@db.example.com:5432/shop?sslmode=require')
    expect(d.host).toBe('db.example.com:5432')
    expect(d.database).toBe('shop')
    expect(JSON.stringify(d)).not.toContain('secret')
  })

  it('мусор не роняет разбор', () => {
    expect(describeDsn('не строка вовсе')).toEqual({ host: '', database: '' })
  })
})

describe('шифрование канала', () => {
  it('SSL включён по умолчанию, а не по флагу в строке', () => {
    // Heroku и AWS RDS требуют шифрование ВСЕГДА, а строку подключения выдают
    // без всякого sslmode. Обратное условие давало отказ «no pg_hba.conf entry
    // ... no encryption», по которому человек ищет проблему у себя в правах —
    // хотя виноваты мы. Проверено на живой базе RDS.
    expect(lib).toMatch(/sslmode=disable/)
    expect(lib).toMatch(/ssl: noSsl \? undefined : \{ rejectUnauthorized: false \}/)
    // Старое условие «включаем только если попросили» вернуться не должно.
    expect(lib).not.toMatch(/wantsSsl/)
  })
})
