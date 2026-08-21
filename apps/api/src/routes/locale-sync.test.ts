import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Язык интерфейса и язык человека в профиле — одно и то же.
 *
 * Переключатель менял только интерфейс, в браузере. В профиле оставался язык,
 * доставшийся при создании, — а на нём ИИ пишет сводки уведомлений и письма.
 *
 * Так и вышло у StartPlan: людей завела внешняя система, языка она не шлёт
 * (в контракте его нет), все получили умолчание схемы 'en' при ивритской
 * компании. Человек видел ивритский интерфейс и английские уведомления, и
 * поменять это было негде — отдельного места для языка профиля нет вовсе.
 */

const auth = readFileSync(join(import.meta.dirname, 'auth.ts'), 'utf8')
const select = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/LanguageSelect.tsx'),
  'utf8',
)

describe('выбор языка доходит до профиля', () => {
  it('переключатель сохраняет выбор на сервере', () => {
    // Без этого язык живёт только в браузере, и ИИ пишет на старом.
    expect(select).toMatch(/method: 'PATCH'[\s\S]{0,80}?locale: code/)
  })

  it('интерфейс переключается сразу, не дожидаясь сервера', () => {
    // Сначала changeLanguage, потом запрос: иначе меню подвисает на сети.
    const pick = select.match(/const pick = \(code: string\) => \{[\s\S]*?\n  \}/)?.[0] ?? ''
    expect(pick, 'обработчик выбора не найден').not.toBe('')
    expect(pick.indexOf('changeLanguage')).toBeLessThan(pick.indexOf("method: 'PATCH'"))
  })

  it('до входа ничего не сохраняется', () => {
    // Тот же переключатель стоит на входе и в приглашении — там человека
    // ещё нет, и запрос ушёл бы в никуда.
    expect(select).toMatch(/if \(!getSessionToken\(\)\) return/)
  })
})

describe('сервер принимает язык', () => {
  it('PATCH /me понимает locale', () => {
    const patch = auth.slice(auth.indexOf("auth.patch(\n  '/me'"))
    expect(patch, 'ручка правки профиля не найдена').not.toBe('')
    expect(patch).toMatch(/locale: z\.enum\(\['en', 'ru', 'he'\]\)\.optional\(\)/)
  })

  it('имя остаётся необязательным', () => {
    // Иначе прежние вызовы, шлющие только имя или только язык, ломаются.
    const patch = auth.slice(auth.indexOf("auth.patch(\n  '/me'"))
    expect(patch).toMatch(/name: z\.string\(\)\.min\(1\)\.max\(120\)\.optional\(\)/)
  })

  it('выбор помечается как собственный', () => {
    /**
     * localeSetByUser: true — иначе следующая массовая правка по компании
     * снова перезапишет язык, который человек выбрал руками.
     */
    const patch = auth.slice(auth.indexOf("auth.patch(\n  '/me'"))
    expect(patch).toMatch(/patch\.localeSetByUser = true/)
  })
})
