import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Суточная сводка непрочитанных.
//
// Человек из израильской компании получал её по-английски и жаловался, что
// письмо непонятное и слишком длинное. Обе жалобы — про одно письмо, но
// причины разные:
//
//   язык   — localeFor звали без компании, а личный выбор у большинства не
//            сделан: колонка locale стоит NOT NULL DEFAULT 'en', и падать
//            функции было некуда;
//   длина  — в письмо вываливались ВСЕ непрочитанные, а их было 83.
//
// Здесь проверяется, что оба лечения на месте и что выключиться из письма
// по-прежнему можно в один клик.

const here = import.meta.dirname
const digest = readFileSync(join(here, 'digest.ts'), 'utf8')
const mails = readFileSync(join(here, 'mails.ts'), 'utf8')
const locale = readFileSync(join(here, 'locale.ts'), 'utf8')

const sendDigest = mails.slice(mails.indexOf('export async function sendDigestMail'))

describe('язык письма', () => {
  it('компания участвует в выборе языка', () => {
    // Без companyId localeFor доходит до последней строки и возвращает 'en'.
    expect(digest).toMatch(/localeFor\(\{ userId: user\.id, companyId \}\)/)
  })

  it('компания берётся из проектов, о которых письмо', () => {
    expect(digest).toMatch(/const companyId = items\[0\]!\.project\.companyId/)
  })

  it('личный выбор по-прежнему сильнее языка компании', () => {
    // Человек мог осознанно выбрать язык, отличный от языка фирмы, — и это
    // решение не должно перебиваться.
    const f = locale.slice(locale.indexOf('export async function localeFor'))
    const personal = f.indexOf('user.localeSetByUser')
    const company = f.indexOf('companyLocale(opts.companyId)')
    expect(personal).toBeGreaterThan(-1)
    expect(company).toBeGreaterThan(-1)
    expect(personal).toBeLessThan(company)
  })

  it('дефолтный en не принимается за выбор', () => {
    // Ровно та ловушка, из-за которой всё и сломалось: у заведённых через API
    // компании стоит 'en' просто потому, что колонка не пустая.
    const f = locale.slice(locale.indexOf('export async function localeFor'))
    expect(f).toMatch(/user\?\.locale && user\.localeSetByUser/)
  })

  it('иврит есть среди языков сводки', () => {
    expect(mails).toMatch(/סיכום Chatick/)
  })
})

describe('длина письма', () => {
  it('на проект показывается ограниченное число строк', () => {
    expect(sendDigest).toMatch(/const PER_PROJECT = \d+/)
    expect(sendDigest).toMatch(/g\.lines\.slice\(0, PER_PROJECT\)/)
  })

  it('остальное сворачивается в счётчик, а не пропадает молча', () => {
    // Пропасть без следа хуже простыни: человек не поймёт, что показано не всё.
    expect(sendDigest).toMatch(/const rest = g\.lines\.length - shown\.length/)
    expect(sendDigest).toMatch(/rest > 0 \?/)
  })

  it('общее число событий по проекту остаётся на виду', () => {
    expect(sendDigest).toMatch(/\$\{g\.lines\.length\}/)
  })

  it('«и ещё N» переведено на все три языка', () => {
    expect(mails).toMatch(/more: 'and \{\{n\}\} more'/)
    expect(mails).toMatch(/more: 'и ещё \{\{n\}\}'/)
    expect(mails).toMatch(/more: 'ועוד \{\{n\}\}'/)
  })
})

describe('выключиться можно из самого письма', () => {
  it('ссылка ведёт на экран настроек, а не на главную', () => {
    // Раньше вело на /#/start: человек попадал на список компаний и не
    // понимал, куда дальше.
    expect(sendDigest).toMatch(/#\/settings\/notifications/)
    expect(sendDigest).not.toMatch(/unsubscribeUrl = `\$\{appUrl\(\)\}\/#\/start`/)
  })

  it('ссылка видна в тексте, а не только в заголовке письма', () => {
    // List-Unsubscribe показывают не все клиенты, и кнопка там мелкая.
    expect(sendDigest).toMatch(/fmt\(s\.unsubscribe, \{ url: unsubscribeUrl \}\)/)
    expect(mails).toMatch(/Turn it off<\/a>/)
  })

  it('заголовок List-Unsubscribe остаётся', () => {
    expect(sendDigest).toMatch(/\{ unsubscribeUrl \}/)
  })
})

describe('выключатель — личный, один на все проекты', () => {
  it('настройка хранится по человеку', () => {
    // Письмо одно на все проекты, значит и выключатель должен быть один:
    // на уровне компании он оставил бы человека с несколькими письмами.
    const schema = readFileSync(join(here, '../db/schema.ts'), 'utf8')
    const t = schema.slice(schema.indexOf("export const userNotificationPrefs"))
    const head = t.slice(0, t.indexOf('})'))
    expect(head).toMatch(/userId: text\('user_id'\)\.primaryKey\(\)/)
    expect(head).not.toMatch(/companyId|projectId/)
  })

  it('выключенный дайджест не шлёт письма', () => {
    expect(digest).toMatch(/if \(!dailyDigest\) continue/)
  })
})
