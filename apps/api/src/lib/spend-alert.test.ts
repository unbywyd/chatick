import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PRICING } from './ai-usage.js'

/**
 * Предупреждение о тратах на ИИ.
 *
 * Счёт за модели растёт тихо: каждый вызов стоит доли цента, и заметить рост
 * можно только сложив всё за месяц — то есть из выписки, постфактум.
 *
 * Опасность здесь не в том, что письмо не придёт, а в том, что оно придёт 288
 * раз в сутки: планировщик тикает каждые пять минут. Человек отключит такие
 * письма на второй день — вместе с настоящими предупреждениями.
 */

const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8')
const alert = read('spend-alert.ts')
const admin = read('admin-alert.ts')
const reminders = read('reminders.ts')

describe('письмо приходит один раз за месяц', () => {
  it('отметка ставится ДО отправки, а не после', () => {
    // Обратный порядок — «отправили, потом записали» — даёт два письма при
    // одновременном тике двух процессов: оба успевают проверить до вставки.
    const claim = alert.indexOf('.insert(spendAlerts)')
    const mail = alert.indexOf('notifySpendThreshold(')
    expect(claim, 'вставка отметки не найдена').toBeGreaterThan(-1)
    expect(mail, 'отправка не найдена').toBeGreaterThan(-1)
    expect(claim, 'отметка должна ставиться ДО письма').toBeLessThan(mail)
  })

  it('гонку разруливает база, а не код', () => {
    // onConflictDoNothing + уникальный индекс: проигравший процесс получает
    // пустой результат и молча выходит.
    expect(alert).toMatch(/\.onConflictDoNothing\(\)/)
    expect(alert).toMatch(/if \(!claimed\) return/)
  })

  it('уникальность объявлена в схеме', () => {
    const schema = read('../db/schema.ts')
    expect(schema).toMatch(/uniqueIndex\('spend_alerts_period_idx'\)\.on\(t\.period, t\.kind\)/)
  })

  it('и в самой миграции — схема одна, а таблицу создаёт SQL', () => {
    const sql = readFileSync(join(import.meta.dirname, '../../drizzle/0089_spend_alerts.sql'), 'utf8')
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "spend_alerts_period_idx"/)
  })
})

describe('порог и адресат', () => {
  it('нулевой порог выключает проверку', () => {
    expect(alert).toMatch(/if \(!limit \|\| limit <= 0 \|\| !env\.ADMIN_EMAIL\) return/)
  })

  it('порог настраивается, а не зашит', () => {
    const env = read('../env.ts')
    expect(env).toMatch(/AI_SPEND_ALERT_USD: z\.coerce\.number\(\)\.default\(5\)/)
  })

  it('период считается по UTC — иначе месяц закроется дважды', () => {
    // На машине в другом поясе локальная дата даёт другой месяц, и отметка
    // за «август» встала бы дважды: по местному и по UTC.
    expect(alert).toMatch(/getUTCFullYear\(\)/)
    expect(alert).toMatch(/Date\.UTC\(/)
  })
})

describe('письмо объясняет, на что ушло', () => {
  it('в нём есть разбивка по моделям', () => {
    expect(alert).toMatch(/breakdownThisMonth/)
    expect(admin).toMatch(/b\.model.*b\.feature/)
  })

  it('и сказано, что второго письма не будет', () => {
    // Иначе человек ждёт следующего и считает, что траты остановились.
    expect(admin).toMatch(/ОДИН раз за месяц/)
  })
})

describe('проверка встроена в планировщик', () => {
  it('зовётся в тике, и её падение не роняет остальное', () => {
    expect(reminders).toMatch(/void checkSpendAlert\(\)\.catch\(\(\) => \{\}\)/)
  })
})

describe('эмбеддинги считаются как всё остальное', () => {
  it('цена модели известна', () => {
    // Без цены costUsd остаётся null, и траты не попадут в сумму — порог
    // молча не сработает.
    expect(DEFAULT_PRICING['text-embedding-3-small']).toBeTruthy()
    expect(DEFAULT_PRICING['text-embedding-3-small']!.in).toBe(0.02)
  })

  it('у эмбеддингов нет выхода — и это не забытый ноль', () => {
    // Модель принимает текст и возвращает числа: платить за выход нечем.
    expect(DEFAULT_PRICING['text-embedding-3-small']!.out).toBe(0)
    expect(DEFAULT_PRICING['text-embedding-3-large']!.out).toBe(0)
  })
})
